import { NextResponse } from "next/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { stripeServidor } from "@/lib/mensualidad/stripe";
import { autorizarMensualidad, origenDe } from "@/lib/mensualidad/autorizar";

// Portal de cliente de Stripe: cambiar tarjeta, ver facturas, cancelar.
// Solo el dueño del antro (o el admin).

export async function POST(request: Request) {
  const cuerpo = (await request.json().catch(() => ({}))) as { club_id?: unknown };
  const quien = await autorizarMensualidad(cuerpo.club_id);
  if (!quien.ok) return NextResponse.json({ error: quien.error }, { status: quien.status });
  const st = stripeServidor();
  if (!st.ok) {
    console.error("mensualidad-portal:", st.motivo);
    return NextResponse.json({ error: "La mensualidad todavía no está configurada." }, { status: 503 });
  }
  const { data: sus } = await clienteServicio().from("suscripciones").select("stripe_customer_id").eq("club_id", quien.club.id).maybeSingle();
  if (!sus?.stripe_customer_id) return NextResponse.json({ error: "Este antro todavía no tiene una suscripción." }, { status: 400 });
  try {
    const sesion = await st.stripe.billingPortal.sessions.create({
      customer: sus.stripe_customer_id,
      return_url: `${origenDe(request)}/dueno/mensualidad`,
      locale: "es-419",
    });
    return NextResponse.json({ url: sesion.url });
  } catch (e) {
    console.error("mensualidad-portal: Stripe", e instanceof Error ? e.message.slice(0, 120) : "error");
    return NextResponse.json({ error: "No pudimos abrir el portal de pagos. Intenta de nuevo en unos minutos." }, { status: 502 });
  }
}
