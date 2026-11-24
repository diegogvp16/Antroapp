import { NextResponse } from "next/server";
import { clienteServicio } from "@/lib/supabase/servicio";
import { mensualidadActiva } from "@/lib/mensualidad/bandera";
import { aceptaEventosProduccion, verificadorWebhook } from "@/lib/mensualidad/stripe";
import { procesarEvento, type EventoStripe } from "@/lib/mensualidad/webhook";

// Webhook de Stripe (mensualidad). Solo con NEXT_PUBLIC_MENSUALIDAD=1.
//   1. Verifica la firma con STRIPE_WEBHOOK_SECRET sobre el cuerpo CRUDO.
//   2. Rechaza eventos de producción si no está STRIPE_PERMITIR_PRODUCCION=1.
//   3. procesarEvento: idempotente y tolerante al desorden.
// Responde 2xx solo cuando quedó aplicado (o ya lo estaba): ante un error,
// 500 para que Stripe lo reintente.

export async function POST(request: Request) {
  if (!mensualidadActiva()) return NextResponse.json({ error: "No disponible." }, { status: 404 });
  const secreto = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secreto) {
    console.error("stripe-webhook: falta STRIPE_WEBHOOK_SECRET");
    return NextResponse.json({ error: "Webhook sin configurar." }, { status: 503 });
  }
  const firma = request.headers.get("stripe-signature");
  if (!firma) return NextResponse.json({ error: "Falta la firma." }, { status: 400 });
  const cuerpo = await request.text();

  let evento: EventoStripe;
  try {
    evento = verificadorWebhook().webhooks.constructEvent(cuerpo, firma, secreto) as unknown as EventoStripe;
  } catch {
    return NextResponse.json({ error: "Firma inválida." }, { status: 400 });
  }
  if (evento.livemode && !aceptaEventosProduccion()) {
    console.error("stripe-webhook: evento de producción rechazado", evento.id);
    return NextResponse.json({ error: "Eventos de producción no habilitados." }, { status: 400 });
  }

  try {
    const resultado = await procesarEvento(clienteServicio(), evento);
    return NextResponse.json({ recibido: true, resultado });
  } catch (e) {
    console.error("stripe-webhook:", evento.type, evento.id, e instanceof Error ? e.message : "error");
    return NextResponse.json({ error: "No se pudo procesar." }, { status: 500 });
  }
}
