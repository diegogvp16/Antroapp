// Mensualidad con Stripe detrás de una bandera APAGADA por defecto.
//   NEXT_PUBLIC_MENSUALIDAD=1      → pantallas de mensualidad, checkout,
//                                     portal, webhook y tarea diaria.
// Además, en el servidor: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET y
// CRON_SECRET (docs/stripe-mensualidad.md). Con la bandera apagada la app
// queda como hoy: la suscripción es el botón simulado del panel del dueño.
export function mensualidadActiva(): boolean {
  return process.env.NEXT_PUBLIC_MENSUALIDAD === "1";
}
