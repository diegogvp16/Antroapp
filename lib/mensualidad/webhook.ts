// Procesa un evento de Stripe YA VERIFICADO (la firma la revisa la ruta).
// Idempotente: cada evento se aplica una sola vez (stripe_eventos), y un
// evento más viejo que el último aplicado no pisa el estado (Stripe no
// garantiza el orden). Usa solo los datos del evento firmado: no llama a la
// API de Stripe, así que también se prueba sin llaves.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  esUuid,
  estadoDesdeStripe,
  finDeGracia,
  leerFactura,
  leerSuscripcion,
  quedaPublicado,
  type EstadoMensualidad,
} from "@/lib/domain/mensualidad";

export type EventoStripe = { id: string; type: string; created: number; livemode: boolean; data: { object: unknown } };
export type ResultadoEvento = "aplicado" | "repetido" | "ignorado" | "viejo";

type Fila = {
  club_id: string;
  plan_id: string | null;
  gracia_hasta: string | null;
  ultimo_evento_en: string | null;
  estado: EstadoMensualidad;
};

export async function procesarEvento(svc: SupabaseClient, ev: EventoStripe, ahora = new Date()): Promise<ResultadoEvento> {
  // 1. Idempotencia: el primero que inserta el evento lo procesa.
  const ins = await svc.from("stripe_eventos").insert({ id: ev.id, tipo: ev.type });
  if (ins.error) {
    if (ins.error.code !== "23505") throw new Error("stripe_eventos: " + ins.error.code);
    const { data: previo } = await svc.from("stripe_eventos").select("procesado_en").eq("id", ev.id).maybeSingle();
    if (previo?.procesado_en) return "repetido";
    // Llegó antes pero falló a la mitad: se vuelve a intentar.
  }
  try {
    const r = await aplicar(svc, ev, ahora);
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

// Solo publica. Despublicar lo hace la tarea diaria, después del corte.
async function publicar(svc: SupabaseClient, clubId: string) {
  const { data: c } = await svc.from("clubs").select("suscripcion_activa").eq("id", clubId).maybeSingle();
  if (c && !c.suscripcion_activa) {
    const r = await svc.from("clubs").update({ suscripcion_activa: true, suscripcion_activada_en: new Date().toISOString() }).eq("id", clubId);
    if (r.error) throw new Error("publicar: " + r.error.code);
  }
}

const texto = (x: unknown) => (typeof x === "string" && x ? x : null);

async function aplicar(svc: SupabaseClient, ev: EventoStripe, ahora: Date): Promise<ResultadoEvento> {
  const o = ev.data.object;
  const creado = new Date(ev.created * 1000);

  if (ev.type === "checkout.session.completed") {
    const s = (typeof o === "object" && o ? o : {}) as Record<string, unknown>;
    const club = await clubPor(svc, texto(s.client_reference_id), null, null);
    if (!club) return "ignorado";
    const sub = texto(s.subscription);
    const customer = texto(s.customer);
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
    const { data: actual } = await svc
      .from("suscripciones")
      .select("club_id, plan_id, gracia_hasta, ultimo_evento_en, estado")
      .eq("club_id", club)
      .maybeSingle<Fila>();
    if (actual?.ultimo_evento_en && creado.getTime() < Date.parse(actual.ultimo_evento_en)) return "viejo";

    const { data: plan } = s.priceId
      ? await svc.from("planes").select("id, dias_gracia").eq("stripe_price_id", s.priceId).maybeSingle()
      : { data: null };
    const { data: cl } = await svc.from("clubs").select("zona_horaria").eq("id", club).maybeSingle();
    const zona = cl?.zona_horaria ?? "America/Mexico_City";
    const status = ev.type === "customer.subscription.deleted" ? "canceled" : s.status;

    // La gracia empieza la primera vez que el cobro falla y no se recorre
    // con cada reintento de Stripe.
    let gracia: Date | null = actual?.gracia_hasta ? new Date(actual.gracia_hasta) : null;
    if (["past_due", "unpaid", "paused"].includes(status)) {
      gracia ??= finDeGracia(ahora, plan?.dias_gracia ?? 7, zona);
    } else if (status === "canceled") {
      // Cancelada: sigue publicada hasta el siguiente corte de las 08:00.
      gracia = finDeGracia(ahora, 0, zona);
    } else {
      gracia = null;
    }
    const estado = estadoDesdeStripe(status, gracia, ahora);
    const r = await svc.from("suscripciones").upsert(
      {
        club_id: club,
        plan_id: plan?.id ?? actual?.plan_id ?? null,
        stripe_subscription_id: s.id,
        ...(s.customer ? { stripe_customer_id: s.customer } : {}),
        estado,
        estado_stripe: status,
        periodo_fin: s.periodoFin?.toISOString() ?? null,
        gracia_hasta: gracia?.toISOString() ?? null,
        cancelar_al_final: s.cancelarAlFinal,
        ultimo_evento_en: creado.toISOString(),
        actualizado_en: new Date().toISOString(),
      },
      { onConflict: "club_id" },
    );
    if (r.error) throw new Error("suscripcion: " + r.error.code);
    if (quedaPublicado(estado)) await publicar(svc, club);
    return "aplicado";
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
    return "aplicado";
  }

  return "ignorado";
}

// Tarea diaria (después del corte de las 08:00): gracia vencida → vencida, y
// quita la publicación a los antros vencidos o cancelados cuyo corte ya pasó.
// Los antros SIN fila en suscripciones (de antes de la mensualidad) no se tocan.
export async function aplicarVencimientos(svc: SupabaseClient, ahora = new Date()) {
  const ahoraIso = ahora.toISOString();
  const vencer = await svc
    .from("suscripciones")
    .update({ estado: "vencida", actualizado_en: ahoraIso })
    .eq("estado", "en_gracia")
    .lt("gracia_hasta", ahoraIso)
    .select("club_id");
  if (vencer.error) throw new Error("vencer: " + vencer.error.code);
  const { data: fuera, error } = await svc.from("suscripciones").select("club_id, gracia_hasta").in("estado", ["vencida", "cancelada"]);
  if (error) throw new Error("fuera: " + error.code);
  const despublicar = (fuera ?? [])
    .filter((f) => !f.gracia_hasta || Date.parse(f.gracia_hasta) <= ahora.getTime())
    .map((f) => f.club_id);
  let despublicados = 0;
  if (despublicar.length) {
    const r = await svc.from("clubs").update({ suscripcion_activa: false }).in("id", despublicar).eq("suscripcion_activa", true).select("id");
    if (r.error) throw new Error("despublicar: " + r.error.code);
    despublicados = r.data?.length ?? 0;
  }
  return { vencidas: vencer.data?.length ?? 0, despublicados };
}
