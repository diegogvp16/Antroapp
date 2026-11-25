// Procesa un evento de Stripe YA VERIFICADO (la firma la revisa la ruta).
// Idempotente: cada evento se aplica una sola vez (stripe_eventos), y un
// evento más viejo que el último aplicado no pisa el estado (Stripe no
// garantiza el orden). Usa solo los datos del evento firmado: no llama a la
// API de Stripe, así que también se prueba sin llaves. Las reglas de estado
// y gracia viven en la base (mensualidad_aplicar_suscripcion); las de
// lib/domain/mensualidad.ts son el mismo criterio para pantallas y pruebas.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { esUuid, leerFactura, leerSuscripcion } from "@/lib/domain/mensualidad";
import { enviarAlerta } from "@/lib/alertas";

export type EventoStripe = { id: string; type: string; created: number; livemode: boolean; data: { object: unknown } };
export type ResultadoEvento = "aplicado" | "repetido" | "ignorado" | "viejo" | "ocupado";

export async function procesarEvento(svc: SupabaseClient, ev: EventoStripe): Promise<ResultadoEvento> {
  // 1. Idempotencia: el primero que inserta el evento lo procesa.
  const ins = await svc.from("stripe_eventos").insert({ id: ev.id, tipo: ev.type });
  if (ins.error) {
    if (ins.error.code !== "23505") throw new Error("stripe_eventos: " + ins.error.code);
    const { data: previo } = await svc.from("stripe_eventos").select("procesado_en").eq("id", ev.id).maybeSingle();
    if (previo?.procesado_en) return "repetido";
    // Llegó antes pero falló a la mitad: se vuelve a intentar.
  }
  // 2. Reclamo: un solo servidor procesa el evento a la vez (si otro lo tiene
  // desde hace menos de 2 min, Stripe lo reintentará después).
  const hace2 = new Date(Date.now() - 120_000).toISOString();
  const { data: reclamo } = await svc
    .from("stripe_eventos")
    .update({ procesando_desde: new Date().toISOString() })
    .eq("id", ev.id)
    .is("procesado_en", null)
    .or(`procesando_desde.is.null,procesando_desde.lt.${hace2}`)
    .select("id");
  if (!reclamo?.length) {
    const { data: ya } = await svc.from("stripe_eventos").select("procesado_en").eq("id", ev.id).maybeSingle();
    return ya?.procesado_en ? "repetido" : "ocupado";
  }
  try {
    const r = await aplicar(svc, ev);
    await svc.from("stripe_eventos").update({ procesado_en: new Date().toISOString(), error: null }).eq("id", ev.id);
    return r;
  } catch (e) {
    await svc.from("stripe_eventos").update({ error: e instanceof Error ? e.message.slice(0, 300) : "error" }).eq("id", ev.id);
    throw e;
  }
}

async function clubPor(svc: SupabaseClient, clubId: string | null, sub: string | null, customer: string | null): Promise<string | null> {
  if (esUuid(clubId)) {
    const { data } = await svc.from("clubs").select("id").eq("id", clubId).maybeSingle();
    if (data) return data.id;
  }
  for (const [col, val] of [["stripe_subscription_id", sub], ["stripe_customer_id", customer]] as const) {
    if (!val) continue;
    const { data } = await svc.from("suscripciones").select("club_id").eq(col, val).maybeSingle();
    if (data) return data.club_id;
  }
  return null;
}

const texto = (x: unknown) => (typeof x === "string" && x ? x : null);

async function aplicar(svc: SupabaseClient, ev: EventoStripe): Promise<ResultadoEvento> {
  const o = ev.data.object;
  const creado = new Date(ev.created * 1000);

  if (ev.type === "checkout.session.completed") {
    const s = (typeof o === "object" && o ? o : {}) as Record<string, unknown>;
    const club = await clubPor(svc, texto(s.client_reference_id), null, null);
    if (!club) return "ignorado";
    const customer = texto(s.customer);
    // No reemplaza una suscripción que sigue viva (un segundo pago por error).
    const { data: actual } = await svc.from("suscripciones").select("estado").eq("club_id", club).maybeSingle();
    const viva = actual?.estado === "activa" || actual?.estado === "en_gracia";
    const sub = viva ? null : texto(s.subscription);
    const r = await svc.from("suscripciones").upsert(
      { club_id: club, ...(customer ? { stripe_customer_id: customer } : {}), ...(sub ? { stripe_subscription_id: sub } : {}), actualizado_en: new Date().toISOString() },
      { onConflict: "club_id" },
    );
    if (r.error) throw new Error("checkout: " + r.error.code);
    return "aplicado";
  }

  if (ev.type.startsWith("customer.subscription.")) {
    const s = leerSuscripcion(o);
    if (!s) return "ignorado";
    const club = await clubPor(svc, s.clubId, s.id, s.customer);
    if (!club) return "ignorado";
    // Compara y escribe con candado en la base (mensualidad_aplicar_suscripcion,
    // sql/post-junta/08): dos eventos simultáneos no se pisan, el más viejo no
    // gana y otra suscripción no cambia el estado de la vigente.
    const { data: estado, error } = await svc.rpc("mensualidad_aplicar_suscripcion", {
      p_club: club,
      p_sub: s.id,
      p_customer: s.customer,
      p_status: ev.type === "customer.subscription.deleted" ? "canceled" : s.status,
      p_creado: creado.toISOString(),
      p_periodo_fin: s.periodoFin?.toISOString() ?? null,
      p_cancelar_al_final: s.cancelarAlFinal,
      p_price: s.priceId,
    });
    if (error) throw new Error("suscripcion: " + error.code);
    return estado === "viejo" ? "viejo" : estado === "otra" ? "ignorado" : "aplicado";
  }

  if (["invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.voided"].includes(ev.type)) {
    const f = leerFactura(o);
    if (!f) return "ignorado";
    const club = await clubPor(svc, f.clubId, f.suscripcion, f.customer);
    if (!club) return "ignorado";
    const estado = ev.type === "invoice.payment_failed" ? "fallido" : ev.type === "invoice.voided" ? "anulado" : "pagado";
    // Un "pagado" no lo regresa a "fallido" un evento que llega tarde.
    const { data: previo } = await svc.from("pagos_mensualidad").select("estado").eq("stripe_invoice_id", f.id).maybeSingle();
    if (previo?.estado === "pagado" && estado === "fallido") return "viejo";
    const r = await svc.from("pagos_mensualidad").upsert(
      {
        club_id: club,
        stripe_invoice_id: f.id,
        monto_centavos: f.montoCentavos,
        moneda: f.moneda,
        estado,
        periodo_inicio: f.periodoInicio?.toISOString() ?? null,
        periodo_fin: f.periodoFin?.toISOString() ?? null,
        url_factura: f.url,
        actualizado_en: new Date().toISOString(),
      },
      { onConflict: "stripe_invoice_id" },
    );
    if (r.error) throw new Error("factura: " + r.error.code);
    if (estado === "fallido") {
      // Con la bandera de alertas: aviso al admin (una vez por hora por antro).
      const { data: c } = await svc.from("clubs").select("nombre").eq("id", club).maybeSingle();
      await enviarAlerta(svc, `cobro_fallido:${club}`, `Cobro fallido: ${c?.nombre ?? "un antro"}`,
        `Stripe no pudo cobrar la mensualidad de ${c?.nombre ?? "un antro"}. Entró en periodo de gracia; revisa /admin/mensualidad.`, club);
    }
    return "aplicado";
  }

  return "ignorado";
}

// Tarea diaria (después del corte de las 08:00): vence las gracias
// terminadas, quita la publicación a vencidos o cancelados cuyo corte ya pasó
// y vuelve a publicar a los que pagaron. Todo en la base, sin carreras
// (mensualidad_vencimientos, sql/post-junta/08). Los antros SIN fila en
// suscripciones (de antes de la mensualidad) no se tocan.
export async function aplicarVencimientos(svc: SupabaseClient) {
  const { data, error } = await svc.rpc("mensualidad_vencimientos");
  if (error) throw new Error("vencimientos: " + error.code);
  return data as { vencidas: number; despublicados: number; republicados: number };
}
