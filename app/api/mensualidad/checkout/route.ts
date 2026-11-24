import { NextResponse } from "next/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { stripeServidor } from "@/lib/mensualidad/stripe";
import { autorizarMensualidad, origenDe } from "@/lib/mensualidad/autorizar";

// Abre Stripe Checkout para suscribir un antro a un plan. Solo el dueño del
// antro (o el admin). El estado NO se cambia aquí: lo pone el webhook cuando
// Stripe confirma el pago.

export async function POST(request: Request) {
  const cuerpo = (await request.json().catch(() => ({}))) as { club_id?: unknown; plan_id?: unknown };
  const quien = await autorizarMensualidad(cuerpo.club_id);
  if (!quien.ok) return NextResponse.json({ error: quien.error }, { status: quien.status });
  const st = stripeServidor();
  if (!st.ok) {
    console.error("mensualidad-checkout:", st.motivo);
    return NextResponse.json({ error: "La mensualidad todavía no está configurada." }, { status: 503 });
  }

  const svc = clienteServicio();
  const { data: plan } = await svc.from("planes").select("id, stripe_price_id, activo").eq("id", String(cuerpo.plan_id ?? "")).maybeSingle();
  if (!plan || !plan.activo) return NextResponse.json({ error: "Ese plan no está disponible." }, { status: 400 });
  const { data: sus } = await svc.from("suscripciones").select("stripe_customer_id, estado").eq("club_id", quien.club.id).maybeSingle();
  if (sus && (sus.estado === "activa" || sus.estado === "en_gracia")) {
    return NextResponse.json({ error: "Este antro ya tiene una suscripción. Usa «Administrar pago»." }, { status: 409 });
  }

  try {
    let customer = sus?.stripe_customer_id ?? null;
    if (!customer) {
      const c = await st.stripe.customers.create(
        { name: quien.club.nombre, ...(quien.email ? { email: quien.email } : {}), metadata: { club_id: quien.club.id } },
        { idempotencyKey: `cliente-${quien.club.id}` },
      );
      customer = c.id;
      const r = await svc.from("suscripciones").upsert({ club_id: quien.club.id, stripe_customer_id: customer }, { onConflict: "club_id" });
      if (r.error) throw new Error("suscripciones: " + r.error.code);
    }
    // ¿Ya hay una suscripción viva en Stripe (por ejemplo, un pago abierto en
    // otra pestaña que ya se completó y el webhook no ha llegado)? No se cobra dos veces.
    const vivas = await st.stripe.subscriptions.list({ customer, status: "all", limit: 20 });
    if (vivas.data.some((x) => !["canceled", "incomplete_expired"].includes(x.status))) {
      return NextResponse.json({ error: "Este antro ya tiene una suscripción en Stripe. Usa «Administrar pago»." }, { status: 409 });
    }
    const origen = origenDe(request);
    const sesion = await st.stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      client_reference_id: quien.club.id,
      subscription_data: { metadata: { club_id: quien.club.id } },
      locale: "es-419",
      success_url: `${origen}/dueno/mensualidad?listo=1`,
      cancel_url: `${origen}/dueno/mensualidad`,
    });
    if (!sesion.url) throw new Error("sin url");
    return NextResponse.json({ url: sesion.url });
  } catch (e) {
    console.error("mensualidad-checkout: Stripe", e instanceof Error ? e.message.slice(0, 120) : "error");
    return NextResponse.json({ error: "No pudimos abrir el pago. Intenta de nuevo en unos minutos." }, { status: 502 });
  }
}
