// Pruebas de la mensualidad con Stripe SIN llaves reales: los eventos se
// arman aquí y se firman con el mismo secreto de webhook que usa el
// servidor local (un secreto inventado, solo de prueba). Así se prueba la
// firma, la idempotencia, el desorden de eventos, los estados, la gracia, la
// tarea diaria, RLS y el candado de suscripcion_activa. Checkout y portal
// llegan hasta Stripe y fallan (llave falsa): eso se prueba con llaves de
// prueba reales siguiendo docs/stripe-mensualidad.md.
//
// Servidores (antroapp-dev):
//   apagada:   node scripts/dev/servidor-dev.mjs                                    (3001)
//   encendida: con STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY (sk_test_ falsa) y CRON_SECRET en el entorno:
//              NEXT_DIST_DIR=.next-banderas PUERTO=3003 NEXT_PUBLIC_MENSUALIDAD=1 node scripts/dev/servidor-dev.mjs
//   node scripts/dev/probar-mensualidad.mjs        (con los mismos STRIPE_WEBHOOK_SECRET y CRON_SECRET)

import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";
import { estadoDesdeStripe, finDeGracia, leerFactura, leerSuscripcion } from "../../lib/domain/mensualidad.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requerir = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = requerir("@supabase/supabase-js");
const Stripe = requerir("stripe");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const SIN = "http://localhost:3001";
const CON = (process.argv.find((a) => a.startsWith("--con="))?.slice(6) ?? "http://localhost:3003").replace(/\/$/, "");
const SECRETO = process.env.STRIPE_WEBHOOK_SECRET;
const CRON = process.env.CRON_SECRET;
if (!SECRETO || !CRON) {
  console.log("Faltan STRIPE_WEBHOOK_SECRET y CRON_SECRET (los mismos que el servidor de 3003).");
  process.exit(1);
}
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const firmador = new Stripe("sk_test_solo_para_firmar");

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const suf = randomBytes(5).toString("hex");
const PASS = "Prueba-" + randomUUID();
const ids = [];
const clubs = [];
const zonaHora = (d, zona) => new Intl.DateTimeFormat("en-US", { timeZone: zona, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

async function cuenta(clave, role, club_id = null) {
  const email = `mens_${clave}_${suf}@example.com`;
  const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  ids.push(u.data.user.id);
  await svc.from("profiles").insert({ id: u.data.user.id, nombre: `Mens ${clave}`, role, club_id });
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  await c.auth.signInWithPassword({ email, password: PASS });
  return { id: u.data.user.id, email, c };
}
async function galletas(email) {
  const r = await fetch(SIN + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.18.9." + Math.floor(Math.random() * 250) }, body: JSON.stringify({ email, password: PASS }) });
  return r.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
}
let n = 0;
let idEvento = 0;
const evento = (type, object, created = Math.floor(Date.now() / 1000) + n++, extra = {}) => ({
  id: `evt_prueba${suf}${++idEvento}`,
  object: "event",
  type,
  created,
  livemode: false,
  api_version: "2026-10-28.endive",
  data: { object },
  ...extra,
});
async function enviar(ev, { base = CON, firma = true, secreto = SECRETO } = {}) {
  const payload = JSON.stringify(ev);
  const headers = { "content-type": "application/json" };
  if (firma) headers["stripe-signature"] = firmador.webhooks.generateTestHeaderString({ payload, secret: secreto });
  const r = await fetch(base + "/api/stripe/webhook", { method: "POST", headers, body: payload });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}
const cron = async (auth = true, base = CON) => {
  const r = await fetch(base + "/api/cron/mensualidad", { headers: auth ? { authorization: `Bearer ${CRON}` } : {} });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
};
const sus = async (club) => (await svc.from("suscripciones").select("*").eq("club_id", club).maybeSingle()).data;
const publicado = async (club) => (await svc.from("clubs").select("suscripcion_activa").eq("id", club).maybeSingle()).data?.suscripcion_activa;

try {
  // ---------- 1. Reglas puras ----------
  const ahora = new Date("2026-11-24T18:00:00Z");
  revisar(estadoDesdeStripe("active", null, ahora) === "activa", "active → activa");
  revisar(estadoDesdeStripe("past_due", new Date("2026-11-30T14:00:00Z"), ahora) === "en_gracia", "past_due con gracia vigente → en gracia");
  revisar(estadoDesdeStripe("past_due", new Date("2026-11-20T14:00:00Z"), ahora) === "vencida", "past_due con gracia vencida → vencida");
  revisar(estadoDesdeStripe("canceled", null, ahora) === "cancelada" && estadoDesdeStripe("incomplete", null, ahora) === "sin_suscripcion", "canceled → cancelada; incomplete → sin suscripción");
  const g1 = finDeGracia(new Date("2026-11-24T05:00:00Z"), 7, "America/Mexico_City");
  revisar(g1.toISOString() === "2026-12-01T14:00:00.000Z", "gracia de 7 días desde las 23:00 → termina el 1/12 a las 08:00 CDMX", g1.toISOString());
  const g2 = finDeGracia(new Date("2026-11-24T05:00:00Z"), 7, "America/Tijuana");
  revisar(zonaHora(g2, "America/Tijuana") === "08:00", "en Tijuana termina a las 08:00 de Tijuana", g2.toISOString());
  const g3 = finDeGracia(new Date("2026-11-25T03:30:00Z"), 0, "America/Mexico_City");
  revisar(g3.toISOString() === "2026-11-25T14:00:00.000Z", "cancelar a las 21:30 → sigue publicado hasta las 08:00 del día siguiente", g3.toISOString());
  revisar(leerSuscripcion({ id: "sub_1", status: "active", current_period_end: 1800000000, items: { data: [{ price: { id: "price_a" } }] } })?.periodoFin?.getTime() === 1800000000000, "lee el fin del periodo en la forma vieja de la API");
  revisar(leerSuscripcion({ id: "sub_1", status: "active", items: { data: [{ current_period_end: 1800000000, price: { id: "price_a" } }] } })?.priceId === "price_a", "y en la forma nueva (en los items)");
  revisar(leerFactura({ id: "in_1", parent: { subscription_details: { subscription: "sub_9" } } })?.suscripcion === "sub_9" && leerFactura({ id: "in_2", subscription: "sub_8" })?.suscripcion === "sub_8", "factura: suscripción en parent o en el campo viejo");

  // ---------- 2. Preparación ----------
  const dueno = await cuenta("dueno", "dueno");
  const duenoOtro = await cuenta("dueno_otro", "dueno");
  const { data: club } = await svc.from("clubs").insert({ nombre: `Mens Prueba ${suf}`, direccion: "Calle 1", horario: "Vie", dueno_id: dueno.id, suscripcion_activa: false }).select("id").single();
  clubs.push(club.id);
  const { data: clubLibre } = await svc.from("clubs").insert({ nombre: `Mens Sin Fila ${suf}`, direccion: "Calle 2", horario: "Vie", dueno_id: duenoOtro.id, suscripcion_activa: true }).select("id").single();
  clubs.push(clubLibre.id);
  const staff = await cuenta("staff", "staff", club.id);
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  await admin.auth.signInWithPassword({ email: cred.usuarios.admin, password: cred.password });
  const PRECIO = `price_prueba${suf}`;
  const plan = await admin.from("planes").insert({ clave: `prueba-${suf}`, nombre: "Plan de prueba", stripe_price_id: PRECIO, dias_gracia: 7 }).select("id").single();
  revisar(!plan.error, "el admin crea un plan", plan.error?.message);
  revisar(!!(await dueno.c.from("planes").insert({ clave: `x-${suf}`, nombre: "X", stripe_price_id: `price_x${suf}` })).error, "el dueño no crea planes");
  revisar(((await dueno.c.from("planes").select("id").eq("id", plan.data?.id)).data ?? []).length === 1, "el dueño ve los planes");
  revisar(((await staff.c.from("planes").select("id")).data ?? []).length === 0, "el staff no ve los planes");

  // ---------- 3. Webhook: firma ----------
  const SUB = `sub_prueba${suf}`;
  const CUS = `cus_prueba${suf}`;
  const subObj = (status, extra = {}) => ({ id: SUB, object: "subscription", status, customer: CUS, metadata: { club_id: club.id }, cancel_at_period_end: false, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, price: { id: PRECIO } }] }, ...extra });
  revisar((await enviar(evento("customer.subscription.created", subObj("active")), { firma: false })).status === 400, "sin firma → 400");
  revisar((await enviar(evento("customer.subscription.created", subObj("active")), { secreto: "whsec_otro" })).status === 400, "firma con otro secreto → 400");
  revisar((await enviar(evento("customer.subscription.created", subObj("active"), undefined, { livemode: true }))).status === 400, "evento de producción (livemode) → rechazado");
  revisar((await enviar(evento("customer.subscription.created", subObj("active")), { base: SIN })).status === 404, "bandera apagada: el webhook no existe (404)");

  // ---------- 4. Flujo feliz ----------
  const r1 = await enviar(evento("checkout.session.completed", { id: "cs_x", object: "checkout.session", client_reference_id: club.id, customer: CUS, subscription: SUB }));
  revisar(r1.status === 200 && (await sus(club.id))?.stripe_customer_id === CUS, "checkout completado liga cliente y suscripción al antro", JSON.stringify(r1.cuerpo));
  const evAlta = evento("customer.subscription.created", subObj("active"));
  const r2 = await enviar(evAlta);
  let s = await sus(club.id);
  revisar(r2.cuerpo.resultado === "aplicado" && s.estado === "activa" && s.plan_id === plan.data?.id && s.periodo_fin, "suscripción activa con su plan y próximo cobro");
  revisar((await publicado(club.id)) === true, "el antro queda publicado (suscripcion_activa)");
  const rep = await enviar(evAlta);
  const { count } = await svc.from("stripe_eventos").select("id", { count: "exact", head: true }).eq("id", evAlta.id);
  revisar(rep.status === 200 && rep.cuerpo.resultado === "repetido" && count === 1, "el mismo evento dos veces se aplica una sola vez");
  const fact = (id, extra = {}) => ({ id, object: "invoice", customer: CUS, amount_paid: 12345, amount_due: 12345, currency: "mxn", hosted_invoice_url: "https://invoice.stripe.com/i/prueba", parent: { subscription_details: { subscription: SUB, metadata: { club_id: club.id } } }, lines: { data: [{ period: { start: Math.floor(Date.now() / 1000), end: Math.floor(Date.now() / 1000) + 30 * 86400 } }] }, ...extra });
  await enviar(evento("invoice.paid", fact(`in_prueba${suf}1`)));
  const { data: pago } = await svc.from("pagos_mensualidad").select("estado, monto_centavos, url_factura").eq("stripe_invoice_id", `in_prueba${suf}1`).maybeSingle();
  revisar(pago?.estado === "pagado" && pago.monto_centavos === 12345 && pago.url_factura, "factura pagada en el historial");

  // ---------- 5. Cobro fallido, gracia y desorden ----------
  const tAlta = evAlta.created;
  const evFalla = evento("customer.subscription.updated", subObj("past_due"), tAlta + 100);
  await enviar(evento("invoice.payment_failed", fact(`in_prueba${suf}2`, { amount_paid: 0 })));
  await enviar(evFalla);
  s = await sus(club.id);
  const gracia = s.gracia_hasta;
  revisar(s.estado === "en_gracia" && gracia && zonaHora(new Date(gracia), "America/Mexico_City") === "08:00", "cobro fallido → en gracia hasta las 08:00 (hora del antro)", JSON.stringify({ estado: s.estado, gracia }));
  const dias = (Date.parse(gracia) - Date.now()) / 86400e3;
  revisar(dias > 6.9 && dias < 8.1, `la gracia dura los 7 días del plan, redondeados al corte (${dias.toFixed(2)} días)`);
  revisar((await publicado(club.id)) === true, "en gracia sigue publicado");
  await enviar(evento("customer.subscription.updated", subObj("past_due"), tAlta + 200));
  revisar((await sus(club.id)).gracia_hasta === gracia, "los reintentos de Stripe no recorren la gracia");
  const viejo = await enviar(evento("customer.subscription.updated", subObj("active"), tAlta + 50));
  revisar(viejo.cuerpo.resultado === "viejo" && (await sus(club.id)).estado === "en_gracia", "un evento más viejo que llega tarde no pisa el estado");
  await enviar(evento("invoice.payment_failed", fact(`in_prueba${suf}1`, { amount_paid: 0 })));
  revisar((await svc.from("pagos_mensualidad").select("estado").eq("stripe_invoice_id", `in_prueba${suf}1`).maybeSingle()).data?.estado === "pagado", "una factura pagada no regresa a «falló»");
  const { data: pagos } = await svc.from("pagos_mensualidad").select("estado").eq("club_id", club.id);
  revisar(pagos?.length === 2 && pagos.some((p) => p.estado === "fallido"), "historial con el pago fallido");

  // ---------- 6. Tarea diaria ----------
  revisar((await cron(false)).status === 401, "tarea diaria sin CRON_SECRET → 401");
  revisar((await cron(true, SIN)).status === 401, "en 3001 (sin CRON_SECRET configurado) → 401");
  let c1 = await cron();
  revisar(c1.status === 200 && (await sus(club.id)).estado === "en_gracia" && (await publicado(club.id)) === true, "con la gracia vigente, la tarea no toca nada");
  await svc.from("suscripciones").update({ gracia_hasta: new Date(Date.now() - 60_000).toISOString() }).eq("club_id", club.id);
  c1 = await cron();
  revisar(c1.cuerpo.vencidas >= 1 && (await sus(club.id)).estado === "vencida" && (await publicado(club.id)) === false, "gracia terminada → vencida y deja de mostrarse al público", JSON.stringify(c1.cuerpo));
  revisar((await publicado(clubLibre.id)) === true, "un antro sin fila de suscripción (de antes) no se toca");

  await enviar(evento("customer.subscription.updated", subObj("active"), tAlta + 300));
  s = await sus(club.id);
  revisar(s.estado === "activa" && s.gracia_hasta === null && (await publicado(club.id)) === true, "paga → activa, sin gracia y publicado otra vez");

  await enviar(evento("customer.subscription.deleted", subObj("canceled"), tAlta + 400));
  s = await sus(club.id);
  revisar(s.estado === "cancelada" && zonaHora(new Date(s.gracia_hasta), "America/Mexico_City") === "08:00", "cancelada → publicada hasta el siguiente corte de las 08:00");
  await cron();
  revisar(Date.parse(s.gracia_hasta) > Date.now() ? (await publicado(club.id)) === true : true, "antes del corte la tarea no la despublica (nunca en plena noche)");
  await svc.from("suscripciones").update({ gracia_hasta: new Date(Date.now() - 60_000).toISOString() }).eq("club_id", club.id);
  await cron();
  revisar((await publicado(club.id)) === false, "después del corte, cancelada → no publicada");

  // ---------- 6b. Arreglos de la revisión ----------
  // Mismo segundo y en desorden: "updated active" llega antes que "created incomplete".
  const { data: club2 } = await svc.from("clubs").insert({ nombre: `Mens Orden ${suf}`, direccion: "Calle 4", horario: "Vie", dueno_id: duenoOtro.id, suscripcion_activa: false }).select("id").single();
  clubs.push(club2.id);
  const SUB2 = `sub_orden${suf}`;
  const sub2 = (status) => ({ ...subObj(status), id: SUB2, customer: `cus_orden${suf}`, metadata: { club_id: club2.id } });
  const t0 = Math.floor(Date.now() / 1000) + 500;
  await enviar(evento("customer.subscription.updated", sub2("active"), t0));
  const ri = await enviar(evento("customer.subscription.created", sub2("incomplete"), t0));
  revisar(ri.cuerpo.resultado === "viejo" && (await sus(club2.id)).estado === "activa", "mismo segundo y en desorden: gana «activa», no «incompleta»", JSON.stringify(ri.cuerpo));
  // Otra suscripción del mismo antro mientras la vigente sigue activa.
  const otra = await enviar(evento("customer.subscription.deleted", { ...sub2("canceled"), id: `sub_otra${suf}` }, t0 + 10));
  revisar(otra.cuerpo.resultado === "ignorado" && (await sus(club2.id)).estado === "activa", "cancelar OTRA suscripción no toca la vigente");
  // El mismo evento dos veces al mismo tiempo.
  const doble = evento("customer.subscription.updated", sub2("active"), t0 + 20);
  const [x1, x2] = await Promise.all([enviar(doble), enviar(doble)]);
  const res = [x1.cuerpo.resultado, x2.cuerpo.resultado].sort().join(",");
  revisar(["aplicado,repetido", "aplicado,ocupado"].includes(res) || (x2.status === 503 || x1.status === 503), `dos entregas simultáneas: se aplica una vez (${res})`);
  // La tarea diaria vuelve a publicar a un antro con suscripción activa que quedó oculto.
  await svc.from("clubs").update({ suscripcion_activa: false }).eq("id", club2.id);
  const rp = await cron();
  revisar(rp.cuerpo.republicados >= 1 && (await publicado(club2.id)) === true, "la tarea diaria vuelve a publicar a un antro pagado que quedó oculto");

  // ---------- 7. RLS ----------
  revisar(((await dueno.c.from("suscripciones").select("estado").eq("club_id", club.id)).data ?? []).length === 1, "el dueño ve su suscripción");
  revisar(((await dueno.c.from("pagos_mensualidad").select("id").eq("club_id", club.id)).data ?? []).length === 2, "y su historial");
  revisar(((await duenoOtro.c.from("suscripciones").select("estado").eq("club_id", club.id)).data ?? []).length === 0, "otro dueño no la ve");
  revisar(((await staff.c.from("pagos_mensualidad").select("id").eq("club_id", club.id)).data ?? []).length === 0, "el staff del antro no ve pagos");
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  revisar(((await anon.from("suscripciones").select("club_id")).data ?? []).length === 0, "anónimo no ve suscripciones");
  revisar(((await dueno.c.from("stripe_eventos").select("id")).data ?? []).length === 0, "nadie fuera del servidor lee los eventos de Stripe");
  const cambia = await dueno.c.from("suscripciones").update({ estado: "activa" }).eq("club_id", club.id).select("club_id");
  revisar(!cambia.data?.length && (await sus(club.id)).estado === "cancelada", "el dueño no puede cambiar su estado");

  // ---------- 8. Candado de suscripcion_activa ----------
  await svc.from("clubs").update({ suscripcion_activa: false }).eq("id", club.id);
  const libre = await dueno.c.from("clubs").update({ suscripcion_activa: true }).eq("id", club.id).select("id");
  revisar(!libre.error && libre.data?.length === 1, "con el cobro simulado (hoy), el dueño sí activa su suscripción");
  await svc.from("config_plataforma").update({ valor: true }).eq("clave", "mensualidad_real");
  const candado = await dueno.c.from("clubs").update({ suscripcion_activa: false }).eq("id", club.id).select("id");
  revisar(!!candado.error && /mensualidad/.test(candado.error.message), "con cobro real, el dueño ya no la cambia a mano");
  // Un dueño SIN antro: desde sql/post-junta-2/68 un dueño que ya tiene uno no puede crear otro.
  const duenoNuevo = await cuenta("dueno_nuevo", "dueno");
  const ins = await duenoNuevo.c.from("clubs").insert({ nombre: `Mens Segundo ${suf}`, direccion: "Calle 3", horario: "Vie", dueno_id: duenoNuevo.id, suscripcion_activa: true }).select("id, suscripcion_activa").single();
  if (ins.data) clubs.push(ins.data.id);
  revisar(ins.data?.suscripcion_activa === false, "con cobro real, un antro nuevo del dueño nace sin suscripción aunque la mande");
  revisar(!(await admin.from("clubs").update({ suscripcion_activa: true }).eq("id", club.id)).error, "el admin sí la cambia");
  await svc.from("config_plataforma").update({ valor: false }).eq("clave", "mensualidad_real");

  // ---------- 9. Checkout y portal (sin Stripe real) ----------
  const post = async (ruta, cuerpo, galleta) => {
    const r = await fetch(CON + ruta, { method: "POST", headers: { "content-type": "application/json", ...(galleta ? { cookie: galleta } : {}) }, body: JSON.stringify(cuerpo) });
    return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
  };
  const gDueno = await galletas(dueno.email);
  revisar((await post("/api/mensualidad/checkout", { club_id: club.id, plan_id: plan.data?.id })).status === 401, "checkout sin sesión → 401");
  revisar((await post("/api/mensualidad/checkout", { club_id: club.id, plan_id: plan.data?.id }, await galletas(staff.email))).status === 403, "checkout del staff → 403");
  revisar((await post("/api/mensualidad/checkout", { club_id: club.id, plan_id: plan.data?.id }, await galletas(duenoOtro.email))).status === 403, "checkout de otro dueño → 403");
  const ck = await post("/api/mensualidad/checkout", { club_id: club.id, plan_id: plan.data?.id }, gDueno);
  revisar(ck.status === 502 && !JSON.stringify(ck.cuerpo).includes("sk_"), "checkout del dueño llega hasta Stripe (llave falsa → 502, sin detalles)", JSON.stringify(ck));
  const pt = await post("/api/mensualidad/portal", { club_id: club.id }, gDueno);
  revisar(pt.status === 502, "portal del dueño llega hasta Stripe (llave falsa → 502)", JSON.stringify(pt));
  revisar((await fetch(SIN + "/api/mensualidad/checkout", { method: "POST", headers: { "content-type": "application/json", cookie: gDueno }, body: JSON.stringify({ club_id: club.id, plan_id: plan.data?.id }) })).status === 503, "bandera apagada: checkout responde «no configurada» (503)");
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  await svc.from("stripe_eventos").delete().like("id", `evt_prueba${suf}%`);
  if (clubs.length) {
    await svc.from("pagos_mensualidad").delete().in("club_id", clubs);
    await svc.from("suscripciones").delete().in("club_id", clubs);
  }
  await svc.from("planes").delete().like("clave", `%-${suf}`);
  if (ids.length) await svc.from("profiles").delete().in("id", ids);
  if (clubs.length) await svc.from("clubs").delete().in("id", clubs);
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  await svc.from("config_plataforma").update({ valor: false }).eq("clave", "mensualidad_real");
  console.log(`\nLimpieza: ${clubs.length} antros y ${ids.length} cuentas de prueba borrados; mensualidad_real en false.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
