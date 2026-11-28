// Recorridos completos de la mensualidad con Stripe SIN llaves reales.
// Complementa scripts/dev/probar-mensualidad.mjs (firma, flujo feliz, un
// cobro fallido, desorden, tarea diaria, RLS, candado y checkout/portal):
// aquí NO se repite nada de eso; solo lo que faltaba (docs/stripe-prueba-dev.md):
//
//   1. Falla de pago con reintentos automáticos (Smart Retries) y su efecto
//      en el acceso: catálogo público, reservas, puerta/caja del staff, panel
//      del dueño, boleto. Tres finales: se recupera, se agota → unpaid, se
//      agota → canceled y vuelve a suscribirse.
//   2. Alta de un antro de punta a punta: asistente de /admin (la ruta real),
//      cambio de contraseña temporal, verificación (documentos → revisión →
//      aprobación), checkout del dueño (hasta Stripe con llave falsa) y los
//      eventos de Checkout en el orden en que Stripe los manda → publicado.
//   3. Paso de plan: customer.subscription.updated con otro precio, factura
//      de prorrateo, precio que no es de ningún plan.
//   4. Cancelación al final del periodo: cancel_at_period_end, reactivación,
//      customer.subscription.deleted al terminar el periodo y lo que ve el dueño.
//
// Los eventos se arman con la forma de la API 2026-10-28.endive (la de
// stripe@23.1.0: periodo en los items, la suscripción de la factura en
// `parent`) y se firman con el mismo secreto inventado del servidor local.
// Lo que solo se prueba con Stripe real está en docs/stripe-prueba-dev.md.
//
// Servidor (antroapp-dev), con STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY
// (sk_test_ FALSA) y CRON_SECRET inventados en el entorno:
//   NEXT_DIST_DIR=.next-stripe PUERTO=3043 NEXT_PUBLIC_MENSUALIDAD=1 node scripts/dev/servidor-dev.mjs
//   node scripts/dev/probar-mensualidad-recorridos.mjs --con=http://localhost:3043   (mismos secretos)
// Sin --con usa http://localhost:3003, como la prueba existente.
//
// Solo dev: se niega si .env.dev apunta a producción o si --con no es local.
// Crea sus propios antros, cuentas, planes y eventos y los borra al terminar.

import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requerir = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = requerir("@supabase/supabase-js");
const Stripe = requerir("stripe");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const CON = (process.argv.find((a) => a.startsWith("--con="))?.slice(6) ?? "http://localhost:3003").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(CON)) {
  console.log("ABORTO: --con tiene que ser un servidor local contra dev (http://localhost:PUERTO).");
  process.exit(1);
}
const SECRETO = process.env.STRIPE_WEBHOOK_SECRET;
const CRON = process.env.CRON_SECRET;
if (!SECRETO || !CRON) {
  console.log("Faltan STRIPE_WEBHOOK_SECRET y CRON_SECRET (los mismos que el servidor).");
  process.exit(1);
}
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const firmador = new Stripe("sk_test_solo_para_firmar");

// ---------- Conteo por recorrido ----------
const cuentas = {};
let seccion = "0. Preparación";
function recorrido(nombre) {
  seccion = nombre;
  cuentas[nombre] = { pasan: 0, fallan: 0 };
  console.log(`\n=== ${nombre} ===`);
}
function revisar(cond, texto, detalle = "") {
  cuentas[seccion] ??= { pasan: 0, fallan: 0 };
  if (cond) cuentas[seccion].pasan++;
  else cuentas[seccion].fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
// Comportamiento real que se documenta como riesgo o decisión (no cuenta en N/N).
const notas = [];
function anotar(texto) {
  notas.push(`[${seccion}] ${texto}`);
  console.log("INFO   " + texto);
}

const suf = randomBytes(5).toString("hex");
const PASS = "Prueba-" + randomUUID();
const ids = [];
const clubs = [];
const archivos = [];
const zonaHora = (d, zona) => new Intl.DateTimeFormat("en-US", { timeZone: zona, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
// Noche operativa de hoy en el antro (corte 08:00) + n días, "YYYY-MM-DD".
const noche = (n = 0, zona = "America/Mexico_City") => {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: zona }).format(new Date(Date.now() - 8 * 3600e3));
  const [a, m, d] = hoy.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};

async function cuenta(clave, role, club_id = null) {
  const email = `mensrec_${clave}_${suf}@example.com`;
  const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (u.error) throw new Error("createUser " + clave + ": " + u.error.message);
  ids.push(u.data.user.id);
  const p = await svc.from("profiles").insert({ id: u.data.user.id, nombre: `MensRec ${clave}`, role, club_id });
  if (p.error) throw new Error("perfil " + clave + ": " + p.error.message);
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const s = await c.auth.signInWithPassword({ email, password: PASS });
  if (s.error) throw new Error("login " + clave + ": " + s.error.message);
  return { id: u.data.user.id, email, c };
}
async function galletas(email, password = PASS) {
  const r = await fetch(CON + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify({ email, password }) });
  const cuerpo = await r.json().catch(() => ({}));
  return { status: r.status, cuerpo, galleta: r.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ") };
}
const post = async (ruta, cuerpo, galleta) => {
  const r = await fetch(CON + ruta, { method: "POST", headers: { "content-type": "application/json", ...(galleta ? { cookie: galleta } : {}) }, body: JSON.stringify(cuerpo) });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
};

// ---------- Eventos de Stripe (forma 2026-10-28.endive) ----------
let idEvento = 0;
let reloj = Math.floor(Date.now() / 1000) + 1000; // created estrictamente creciente
const tic = (s = 10) => (reloj += s);
const evento = (type, object, created = tic(), extra = {}) => ({
  id: `evt_rec${suf}${++idEvento}`,
  object: "event",
  type,
  created,
  livemode: false,
  api_version: "2026-10-28.endive",
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  data: { object },
  ...extra,
});
async function enviar(ev) {
  const payload = JSON.stringify(ev);
  const headers = { "content-type": "application/json", "stripe-signature": firmador.webhooks.generateTestHeaderString({ payload, secret: SECRETO }) };
  const r = await fetch(CON + "/api/stripe/webhook", { method: "POST", headers, body: payload });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}
const cron = async () => {
  const r = await fetch(CON + "/api/cron/mensualidad", { headers: { authorization: `Bearer ${CRON}` } });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
};
const ahoraS = () => Math.floor(Date.now() / 1000);
const DIA = 86400;

// Suscripción: un item con su precio y su periodo (la forma nueva).
function suscripcion({ id, customer, club, status, price, inicio = ahoraS(), fin = ahoraS() + 30 * DIA, cancelAlFinal = false, cancelAt = null, canceledAt = null, endedAt = null, latest = null, items = null }) {
  return {
    id,
    object: "subscription",
    status,
    customer,
    metadata: { club_id: club },
    billing_mode: { type: "flexible" },
    collection_method: "charge_automatically",
    cancel_at_period_end: cancelAlFinal,
    cancel_at: cancelAt,
    canceled_at: canceledAt,
    ended_at: endedAt,
    latest_invoice: latest,
    items: {
      object: "list",
      data: items ?? [
        { id: `si_${id.slice(4)}`, object: "subscription_item", current_period_start: inicio, current_period_end: fin, quantity: 1, price: { id: price, object: "price", currency: "mxn", recurring: { interval: "month", interval_count: 1 } } },
      ],
    },
  };
}
// Factura de la suscripción (la suscripción vive en parent.subscription_details).
function factura({ id, customer, sub, club, status = "open", motivo = "subscription_cycle", monto = 250000, pagado = 0, intento = 1, siguiente = null, inicio = ahoraS(), fin = ahoraS() + 30 * DIA, lineas = null }) {
  return {
    id,
    object: "invoice",
    customer,
    status,
    billing_reason: motivo,
    collection_method: "charge_automatically",
    attempt_count: intento,
    attempted: true,
    next_payment_attempt: siguiente,
    amount_due: monto,
    amount_paid: pagado,
    amount_remaining: monto - pagado,
    currency: "mxn",
    hosted_invoice_url: `https://invoice.stripe.com/i/prueba_${id}`,
    parent: { type: "subscription_details", subscription_details: { subscription: sub, metadata: { club_id: club } } },
    lines: { object: "list", data: lineas ?? [{ object: "line_item", amount: monto, period: { start: inicio, end: fin } }] },
  };
}

// ---------- Lecturas ----------
const sus = async (club) => (await svc.from("suscripciones").select("*").eq("club_id", club).maybeSingle()).data;
const publicado = async (club) => (await svc.from("clubs").select("suscripcion_activa").eq("id", club).maybeSingle()).data?.suscripcion_activa;
const pagosDe = async (club) => (await svc.from("pagos_mensualidad").select("stripe_invoice_id, estado, monto_centavos").eq("club_id", club)).data ?? [];
// ¿Lo ve el público? La misma consulta que /cliente (anónimo, por RLS).
const enCatalogo = async (club) =>
  ((await anon.from("clubs").select("id").eq("id", club).eq("estado_verificacion", "verificado").eq("suscripcion_activa", true)).data ?? []).length === 1;
let reservasCliente = 0;
// Un cliente con sesión intenta reservar (cada intento, otra noche: una reserva por cliente, antro y noche).
async function clienteReserva(cliente, club, zona) {
  reservasCliente++;
  const r = await cliente.c.from("reservations").insert({
    cliente_nombre: "MensRec Cliente",
    cliente_telefono: "5500000000",
    rp_id: null,
    club_id: club,
    cliente_id: cliente.id,
    source: "organica",
    fecha: noche(reservasCliente, zona),
    personas: 2,
    status: "pendiente",
    qr_code: `antro-${randomUUID()}`,
  });
  return !r.error;
}
// Lo que necesita el staff para operar: ver la caja, sus permisos y leer una reserva por su QR (puerta).
async function staffOpera(staff, club, qr) {
  const ver = await staff.c.rpc("caja_puede_ver", { p_club_id: club });
  const perm = await staff.c.rpc("caja_mis_permisos", { p_club_id: club });
  const puerta = qr ? await staff.c.from("reservations").select("id").eq("club_id", club).eq("qr_code", qr) : { data: [1] };
  return ver.data === true && perm.data?.abrir_mesa === true && perm.data?.cobrar === true && (puerta.data ?? []).length === 1;
}
// Lo que ve el dueño en /dueno/panel y /dueno/mensualidad (con su sesión, por RLS).
async function duenoVe(dueno, club) {
  const c = await dueno.c.from("clubs").select("id, nombre").eq("id", club);
  const s = await dueno.c.from("suscripciones").select("estado, periodo_fin, gracia_hasta, cancelar_al_final, plan_id").eq("club_id", club).maybeSingle();
  return { club: (c.data ?? []).length === 1, sus: s.data };
}

async function clubVerificado(nombre, dueno, zona = "America/Mexico_City") {
  const { data, error } = await svc
    .from("clubs")
    .insert({ nombre: `MensRec ${nombre} ${suf}`, direccion: "Calle Prueba 1", horario: "Vie y Sáb", ciudad: "Querétaro", dueno_id: dueno.id, suscripcion_activa: false, estado_verificacion: "verificado", verificado_en: new Date().toISOString(), zona_horaria: zona })
    .select("id")
    .single();
  if (error) throw new Error("club " + nombre + ": " + error.message);
  clubs.push(data.id);
  return data.id;
}

try {
  // ---------- Preparación común ----------
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const la = await admin.auth.signInWithPassword({ email: cred.usuarios.admin, password: cred.password });
  if (la.error) throw new Error("login admin: " + la.error.message);
  const PRECIO_A = `price_recA${suf}`;
  const PRECIO_B = `price_recB${suf}`;
  const PRECIO_SUELTO = `price_recX${suf}`; // un precio de Stripe que no es de ningún plan
  const planA = (await admin.from("planes").insert({ clave: `reca-${suf}`, nombre: `Plan Base ${suf}`, stripe_price_id: PRECIO_A, monto_centavos: 250000, dias_gracia: 7 }).select("id").single()).data;
  const planB = (await admin.from("planes").insert({ clave: `recb-${suf}`, nombre: `Plan Grande ${suf}`, stripe_price_id: PRECIO_B, monto_centavos: 400000, dias_gracia: 3 }).select("id").single()).data;
  if (!planA || !planB) throw new Error("no se pudieron crear los planes");
  const cliente = await cuenta("cliente", "cliente");

  // =====================================================================
  recorrido("1. Falla de pago con reintentos y acceso");
  // =====================================================================
  // Antro en Tijuana: el corte de las 08:00 es en SU zona (la base, no solo la regla pura).
  const ZONA1 = "America/Tijuana";
  const dueno1 = await cuenta("dueno1", "dueno");
  const c1 = await clubVerificado("Reintentos", dueno1, ZONA1);
  const staff1 = await cuenta("staff1", "staff", c1);
  const rp1 = await cuenta("rp1", "rp", c1);
  const SUB1 = `sub_rec1${suf}`;
  const CUS1 = `cus_rec1${suf}`;
  const s1 = (status, extra = {}) => suscripcion({ id: SUB1, customer: CUS1, club: c1, status, price: PRECIO_A, ...extra });
  const f1 = (id, extra = {}) => factura({ id, customer: CUS1, sub: SUB1, club: c1, ...extra });

  await enviar(evento("customer.subscription.created", s1("active")));
  await enviar(evento("invoice.paid", f1(`in_rec1a${suf}`, { status: "paid", pagado: 250000, motivo: "subscription_create" })));
  revisar((await sus(c1))?.estado === "activa" && (await enCatalogo(c1)), "punto de partida: activa y en el catálogo público");
  const okReserva = await clienteReserva(cliente, c1, ZONA1);
  revisar(okReserva, "activa: un cliente puede reservar");
  const { data: reservaPrevia } = await svc.from("reservations").select("qr_code").eq("club_id", c1).eq("cliente_id", cliente.id).limit(1).maybeSingle();
  const QR1 = reservaPrevia?.qr_code ?? null;

  // Renovación que falla. Stripe: invoice.payment_failed (intento 1, con el
  // siguiente intento programado) y la suscripción pasa a past_due.
  const IN1 = `in_rec1b${suf}`;
  const r1a = await enviar(evento("invoice.payment_failed", f1(IN1, { intento: 1, siguiente: ahoraS() + 3 * DIA })));
  const r1b = await enviar(evento("customer.subscription.updated", s1("past_due", { latest: IN1 }), tic(), { data: { object: s1("past_due", { latest: IN1 }), previous_attributes: { status: "active" } } }));
  let s = await sus(c1);
  const gracia1 = s?.gracia_hasta;
  revisar(r1a.status === 200 && r1b.cuerpo.resultado === "aplicado" && s?.estado === "en_gracia" && s.estado_stripe === "past_due", "intento 1 falla → en gracia (past_due)", JSON.stringify({ r1a: r1a.status, r1b: r1b.cuerpo, estado: s?.estado }));
  revisar(gracia1 && zonaHora(new Date(gracia1), ZONA1) === "08:00", "la gracia termina a las 08:00 de Tijuana (zona del antro, calculada en la base)", gracia1);
  revisar((await publicado(c1)) === true && (await enCatalogo(c1)), "en gracia: sigue en el catálogo público");
  revisar(await clienteReserva(cliente, c1, ZONA1), "en gracia: un cliente todavía puede reservar");
  revisar(await staffOpera(staff1, c1, QR1), "en gracia: el staff ve la caja, sus permisos y la reserva por su QR");
  let dv = await duenoVe(dueno1, c1);
  revisar(dv.club && dv.sus?.estado === "en_gracia" && dv.sus.gracia_hasta === gracia1, "en gracia: el dueño ve su antro, el estado y hasta cuándo sigue publicado");

  // Reintentos automáticos: el mismo invoice con attempt_count 2, 3, 4.
  // Stripe no manda otro subscription.updated mientras siga past_due.
  for (const intento of [2, 3, 4]) {
    const r = await enviar(evento("invoice.payment_failed", f1(IN1, { intento, siguiente: ahoraS() + (2 + intento) * DIA })));
    s = await sus(c1);
    revisar(r.cuerpo.resultado === "aplicado" && s.estado === "en_gracia" && s.gracia_hasta === gracia1, `reintento ${intento} falla: sigue en gracia y la gracia no se recorre`);
  }
  let pagos = (await pagosDe(c1)).filter((p) => p.stripe_invoice_id === IN1);
  revisar(pagos.length === 1 && pagos[0].estado === "fallido" && pagos[0].monto_centavos === 250000, "los reintentos son UNA fila del historial (la misma factura), en «falló»");

  // La gracia (7 días) termina antes que los Smart Retries (hasta ~2 semanas).
  // Simulación del paso del tiempo: la gracia ya pasó.
  await svc.from("suscripciones").update({ gracia_hasta: new Date(Date.now() - 60_000).toISOString() }).eq("club_id", c1);
  const r5 = await enviar(evento("invoice.payment_failed", f1(IN1, { intento: 5, siguiente: ahoraS() + 2 * DIA })));
  revisar(r5.status === 200 && (await publicado(c1)) === true && (await enCatalogo(c1)), "gracia vencida pero sin tarea diaria: un webhook NO lo despublica (nunca en plena noche)");
  revisar(await clienteReserva(cliente, c1, ZONA1), "…y mientras no corra la tarea diaria sigue recibiendo reservas");
  let cr = await cron();
  s = await sus(c1);
  revisar(cr.status === 200 && s.estado === "vencida" && (await publicado(c1)) === false, "la tarea diaria (después del corte) → vencida y fuera del público", JSON.stringify(cr.cuerpo));
  revisar(!(await enCatalogo(c1)), "vencida: ya no aparece en el catálogo público");
  revisar(!(await clienteReserva(cliente, c1, ZONA1)), "vencida: un cliente ya no puede reservar");
  const anonVencida = await anon.from("reservations").insert({ cliente_nombre: "Anónimo Prueba", cliente_telefono: "5511111111", club_id: c1, source: "organica", fecha: noche(1, ZONA1), personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
  revisar(!!anonVencida.error, "vencida: tampoco reserva un anónimo", anonVencida.error?.message);
  revisar(await staffOpera(staff1, c1, QR1), "vencida: el staff SIGUE operando (caja, permisos y puerta por QR)");
  dv = await duenoVe(dueno1, c1);
  revisar(dv.club && dv.sus?.estado === "vencida", "vencida: el dueño sigue entrando a su panel y ve «Vencida»");
  const rpVencida = await rp1.c.from("reservations").insert({ cliente_nombre: "MensRec RP", cliente_telefono: "5533333333", rp_id: rp1.id, club_id: c1, source: "rp", fecha: noche(1, ZONA1), personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
  if (!rpVencida.error) anotar("vencida: un RP del antro SÍ puede seguir creando reservas (puede_ver_club lo deja por ser del club). La doc decía «deja de recibir reservas nuevas»: solo es cierto para el público.");
  else revisar(false, "RP en antro vencido: comportamiento inesperado", rpVencida.error.message);
  const boleto = await anon.rpc("obtener_reserva_por_qr", { p_qr: QR1 });
  revisar(boleto.data?.[0]?.estado_boleto === "vigente" && boleto.data[0].club_direccion === null, "vencida: el boleto de una reserva previa sigue abriendo (sin dirección del antro)");

  // Final A: el siguiente reintento cobra.
  await enviar(evento("invoice.paid", f1(IN1, { status: "paid", pagado: 250000, intento: 6 })));
  const r6 = await enviar(evento("customer.subscription.updated", s1("active", { latest: IN1 })));
  s = await sus(c1);
  revisar(r6.cuerpo.resultado === "aplicado" && s.estado === "activa" && s.gracia_hasta === null, "final A — un reintento cobra: activa y sin gracia");
  revisar((await publicado(c1)) === true && (await enCatalogo(c1)), "final A: vuelve al catálogo en ese momento (publicar sí lo hace el webhook)");
  pagos = (await pagosDe(c1)).filter((p) => p.stripe_invoice_id === IN1);
  revisar(pagos.length === 1 && pagos[0].estado === "pagado", "final A: la misma factura pasa de «falló» a «pagado»");

  // Final B: otra renovación falla y se agotan los intentos con «marcar como unpaid».
  const IN1c = `in_rec1c${suf}`;
  await enviar(evento("invoice.payment_failed", f1(IN1c, { intento: 1, siguiente: ahoraS() + 3 * DIA })));
  await enviar(evento("customer.subscription.updated", s1("past_due", { latest: IN1c })));
  s = await sus(c1);
  const gracia2 = s.gracia_hasta;
  const dias2 = (Date.parse(gracia2) - Date.now()) / 864e5;
  revisar(s.estado === "en_gracia" && dias2 > 6.9 && dias2 < 8.1, `final B — nueva falla: gracia NUEVA de 7 días (${dias2.toFixed(2)}), no la del episodio anterior`);
  await enviar(evento("invoice.payment_failed", f1(IN1c, { intento: 4, siguiente: null })));
  const rU = await enviar(evento("customer.subscription.updated", s1("unpaid", { latest: IN1c })));
  s = await sus(c1);
  revisar(rU.cuerpo.resultado === "aplicado" && s.estado === "en_gracia" && s.estado_stripe === "unpaid" && s.gracia_hasta === gracia2, "final B: intentos agotados (unpaid) con gracia vigente → sigue en gracia hasta su corte");
  revisar((await enCatalogo(c1)), "final B: unpaid dentro de la gracia sigue publicado");
  await svc.from("suscripciones").update({ gracia_hasta: new Date(Date.now() - 60_000).toISOString() }).eq("club_id", c1);
  // Otro updated de la suscripción unpaid (Stripe lo manda al crear la factura del siguiente periodo).
  await enviar(evento("customer.subscription.updated", s1("unpaid", { latest: `in_rec1c2${suf}` })));
  revisar((await sus(c1)).estado === "vencida" && (await publicado(c1)) === true, "final B: unpaid con la gracia ya vencida → «vencida», pero el webhook no lo despublica (espera a la tarea diaria)");
  await cron();
  revisar((await sus(c1)).estado === "vencida" && !(await enCatalogo(c1)), "final B: terminada la gracia, la tarea diaria lo vence y lo saca del público");
  // El dueño paga después la factura abierta (desde la factura de Stripe o el portal).
  await enviar(evento("invoice.paid", f1(IN1c, { status: "paid", pagado: 250000, intento: 5 })));
  await enviar(evento("customer.subscription.updated", s1("active", { latest: IN1c })));
  revisar((await sus(c1)).estado === "activa" && (await enCatalogo(c1)), "final B: paga la factura pendiente → activa y publicado otra vez");

  // Final C: otra falla y se agotan los intentos con «cancelar la suscripción».
  const IN1d = `in_rec1d${suf}`;
  await enviar(evento("invoice.payment_failed", f1(IN1d, { intento: 1, siguiente: ahoraS() + 3 * DIA })));
  await enviar(evento("customer.subscription.updated", s1("past_due", { latest: IN1d })));
  const gracia3 = (await sus(c1)).gracia_hasta;
  await enviar(evento("invoice.payment_failed", f1(IN1d, { intento: 4, siguiente: null })));
  const rC = await enviar(evento("customer.subscription.deleted", s1("canceled", { canceledAt: ahoraS(), endedAt: ahoraS(), latest: IN1d })));
  s = await sus(c1);
  revisar(rC.cuerpo.resultado === "aplicado" && s.estado === "cancelada" && zonaHora(new Date(s.gracia_hasta), ZONA1) === "08:00", "final C — intentos agotados con cancelación: cancelada, publicada hasta el siguiente 08:00 de Tijuana");
  if (Date.parse(s.gracia_hasta) < Date.parse(gracia3)) {
    anotar(`la cancelación por intentos agotados ACORTA la gracia: de ${gracia3} al siguiente corte (${s.gracia_hasta}). Es lo que dice la doc («Cancelada: no, desde el siguiente corte»), pero conviene decidir si se respeta la gracia que ya se le había avisado al dueño.`);
  }
  revisar((await publicado(c1)) === true && (await enCatalogo(c1)), "final C: justo después de cancelar sigue publicado (el webhook no despublica)");
  await svc.from("suscripciones").update({ gracia_hasta: new Date(Date.now() - 60_000).toISOString() }).eq("club_id", c1);
  await cron();
  revisar(!(await enCatalogo(c1)) && (await staffOpera(staff1, c1, QR1)), "final C: pasado el corte la tarea lo saca del público; la caja y la puerta siguen");
  // Se vuelve a suscribir: el checkout lo permite (llega hasta Stripe) y la suscripción nueva reemplaza a la cancelada.
  const g1 = await galletas(dueno1.email);
  const ck1 = await post("/api/mensualidad/checkout", { club_id: c1, plan_id: planA.id }, g1.galleta);
  revisar(ck1.status === 502, "final C: cancelada → el dueño puede volver a suscribirse (checkout llega hasta Stripe)", JSON.stringify(ck1));
  const SUB1n = `sub_rec1n${suf}`;
  await enviar(evento("customer.subscription.created", { ...s1("active"), id: SUB1n }));
  await enviar(evento("checkout.session.completed", { id: `cs_rec1${suf}`, object: "checkout.session", mode: "subscription", status: "complete", client_reference_id: c1, customer: CUS1, subscription: SUB1n }));
  s = await sus(c1);
  revisar(s.estado === "activa" && s.stripe_subscription_id === SUB1n && (await enCatalogo(c1)), "final C: la suscripción nueva queda como la vigente y vuelve al catálogo");

  // =====================================================================
  recorrido("2. Alta de un antro de punta a punta");
  // =====================================================================
  const gAdmin = await galletas(cred.usuarios.admin, cred.password);
  revisar(gAdmin.status === 200, "el admin inicia sesión", String(gAdmin.status));
  const correoDueno2 = `mensrec_alta_dueno_${suf}@example.com`;
  const correoStaff2 = `mensrec_alta_staff_${suf}@example.com`;
  const nombre2 = `MensRec Alta ${suf}`;
  const alta = await post(
    "/api/admin/alta-club",
    {
      datos: { nombre: nombre2, direccion: "Calle Ficticia 9, Centro", ciudad: "Querétaro", zona_horaria: "America/Mexico_City", horario: "Vie y Sáb 10pm a 3am" },
      politicas: { cover_modo: "oculto", cover_monto: null, deposito_monto: 0, edad_minima: 18, codigo_vestimenta: "", tipo_musica: "", ambiente: "", tolerancia_hora: null },
      mesas: [{ numero: "1", capacidad: 6 }, { numero: "2", capacidad: 6 }],
      rp: { modo_pago: "reserva", regla: { tipo: "fijo", cuota: 0, porcentaje_bp: null, monto_centavos: 15000 }, visibilidad: "estado_monto", tarifas_dia: [] },
      dueno: { nombre: "Dueña Alta MensRec", correo: correoDueno2 },
      personal: [{ nombre: "Staff Alta MensRec", correo: correoStaff2, rol: "staff" }],
      grupo: { modo: "ninguno" },
      publicar: false,
    },
    gAdmin.galleta,
  );
  const { data: c2fila } = await svc.from("clubs").select("id, estado_verificacion, suscripcion_activa, dueno_id").eq("nombre", nombre2).maybeSingle();
  const c2 = c2fila?.id;
  if (c2) clubs.push(c2);
  for (const u of (await svc.auth.admin.listUsers({ perPage: 1000 })).data?.users ?? []) if ((u.email ?? "").includes(`mensrec_alta_`) && (u.email ?? "").includes(suf)) ids.push(u.id);
  revisar(alta.status === 200 && c2fila?.estado_verificacion === "borrador" && c2fila.suscripcion_activa === false, "alta por /api/admin/alta-club (la ruta del asistente): borrador y sin suscripción", JSON.stringify({ status: alta.status, error: alta.cuerpo.error }));
  revisar(!(await sus(c2)) && !(await enCatalogo(c2)), "nace sin fila de mensualidad y fuera del público");
  const credDueno = (alta.cuerpo.credenciales ?? []).find((x) => x.rol === "dueno");
  const credStaff = (alta.cuerpo.credenciales ?? []).find((x) => x.rol === "staff");

  // El dueño entra con la contraseña temporal: la mensualidad lo detiene hasta que la cambie.
  const gTemp = await galletas(correoDueno2, credDueno?.password);
  revisar(gTemp.status === 200 && gTemp.cuerpo.debeCambiar === true, "el dueño entra con la contraseña temporal (debe cambiarla)");
  const ckTemp = await post("/api/mensualidad/checkout", { club_id: c2, plan_id: planA.id }, gTemp.galleta);
  revisar(ckTemp.status === 403, "con la contraseña temporal no puede abrir el pago (403)", String(ckTemp.status));
  const PASS2 = "Nueva-" + randomUUID();
  const cambio = await post("/api/auth/cambiar-contrasena", { nueva: PASS2 }, gTemp.galleta);
  revisar(cambio.status === 200, "cambia su contraseña (/api/auth/cambiar-contrasena)", JSON.stringify(cambio));
  const dueno2 = { id: c2fila?.dueno_id, c: createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts) };
  await dueno2.c.auth.signInWithPassword({ email: correoDueno2, password: PASS2 });
  const g2 = await galletas(correoDueno2, PASS2);
  revisar(g2.status === 200 && !g2.cuerpo.debeCambiar, "vuelve a entrar con su contraseña nueva");

  // Verificación: sube los dos documentos requeridos, envía a revisión y el admin aprueba.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  let subidos = 0;
  for (const tipo of ["comprobante_fiscal", "foto_local"]) {
    const ruta = `${c2}/${tipo}-${randomUUID()}.png`;
    const up = await dueno2.c.storage.from("verificacion-docs").upload(ruta, PNG, { contentType: "image/png", upsert: false });
    if (!up.error) archivos.push(ruta);
    const fila = await dueno2.c.from("verificacion_documentos").insert({ club_id: c2, tipo, storage_path: ruta });
    if (!up.error && !fila.error) subidos++;
  }
  const enviarRev = await dueno2.c.from("clubs").update({ estado_verificacion: "en_revision" }).eq("id", c2).select("estado_verificacion");
  revisar(subidos === 2 && enviarRev.data?.[0]?.estado_verificacion === "en_revision", "el dueño sube comprobante y foto del local y lo envía a revisión", enviarRev.error?.message);
  const aprobar = await admin.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), motivo_rechazo: null }).eq("id", c2).select("estado_verificacion, suscripcion_activa");
  revisar(aprobar.data?.[0]?.estado_verificacion === "verificado" && aprobar.data[0].suscripcion_activa === false, "el admin aprueba (como «Verificaciones pendientes»): verificado, sin tocar la suscripción");
  revisar(!(await enCatalogo(c2)), "verificado pero sin pagar: todavía no aparece al público");

  // El dueño va a /dueno/mensualidad: ve los planes y abre el pago.
  const planesDueno = (await dueno2.c.from("planes").select("id").eq("activo", true)).data ?? [];
  revisar(planesDueno.some((p) => p.id === planA.id), "el dueño ve los planes activos");
  const portalAntes = await post("/api/mensualidad/portal", { club_id: c2 }, g2.galleta);
  revisar(portalAntes.status === 400, "sin suscripción todavía, el portal responde 400 (no llega a Stripe)", String(portalAntes.status));
  await admin.from("planes").update({ activo: false }).eq("id", planB.id);
  const ckInactivo = await post("/api/mensualidad/checkout", { club_id: c2, plan_id: planB.id }, g2.galleta);
  await admin.from("planes").update({ activo: true }).eq("id", planB.id);
  revisar(ckInactivo.status === 400, "un plan desactivado no se puede contratar (400)", String(ckInactivo.status));
  const ck2 = await post("/api/mensualidad/checkout", { club_id: c2, plan_id: planA.id }, g2.galleta);
  revisar(ck2.status === 502 && !JSON.stringify(ck2.cuerpo).includes("sk_"), "checkout del dueño llega hasta Stripe (llave falsa → 502, sin detalles)", JSON.stringify(ck2));

  // Stripe Checkout en el orden en que suele llegar: la suscripción nace
  // incomplete, se paga la primera factura, pasa a active y al final llega
  // checkout.session.completed.
  const SUB2 = `sub_rec2${suf}`;
  const CUS2 = `cus_rec2${suf}`;
  const s2 = (status) => suscripcion({ id: SUB2, customer: CUS2, club: c2, status, price: PRECIO_A, latest: `in_rec2${suf}` });
  const fac2 = factura({ id: `in_rec2${suf}`, customer: CUS2, sub: SUB2, club: c2, status: "paid", motivo: "subscription_create", pagado: 250000 });
  await enviar(evento("customer.subscription.created", s2("incomplete")));
  s = await sus(c2);
  revisar(s?.estado === "sin_suscripcion" && !(await enCatalogo(c2)), "suscripción incompleta (pago en curso): aún no se publica");
  await enviar(evento("invoice.paid", fac2));
  await enviar(evento("invoice.payment_succeeded", fac2));
  await enviar(evento("customer.subscription.updated", s2("active")));
  const rCk = await enviar(evento("checkout.session.completed", { id: `cs_rec2${suf}`, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid", client_reference_id: c2, customer: CUS2, subscription: SUB2 }));
  s = await sus(c2);
  revisar(rCk.cuerpo.resultado === "aplicado" && s.estado === "activa" && s.plan_id === planA.id && s.stripe_customer_id === CUS2 && s.stripe_subscription_id === SUB2 && s.periodo_fin, "pagado: activa, con su plan, cliente, suscripción y próximo cobro");
  revisar((await publicado(c2)) === true && (await enCatalogo(c2)), "el antro queda publicado y el público lo ve en el catálogo");
  const anonRes = await anon.from("reservations").insert({ cliente_nombre: "Anónimo Prueba", cliente_telefono: "5522222222", club_id: c2, source: "organica", fecha: noche(1), personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
  revisar(!anonRes.error, "y ya recibe reservas sin cuenta", anonRes.error?.message);
  const p2 = await pagosDe(c2);
  revisar(p2.length === 1 && p2[0].estado === "pagado", "invoice.paid + invoice.payment_succeeded: un solo pago en el historial");
  dv = await duenoVe(dueno2, c2);
  revisar(dv.sus?.estado === "activa" && dv.sus.plan_id === planA.id, "el dueño ve «Activa» y su plan");
  const staff2 = { c: createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts) };
  await svc.auth.admin.updateUserById((await svc.from("profiles").select("id").eq("club_id", c2).eq("role", "staff").maybeSingle()).data?.id, { app_metadata: { alta_club: true, debe_cambiar: false } });
  await staff2.c.auth.signInWithPassword({ email: correoStaff2, password: credStaff?.password });
  revisar(await staffOpera(staff2, c2, null), "el staff del alta opera la caja");
  const ckOtra = await post("/api/mensualidad/checkout", { club_id: c2, plan_id: planA.id }, g2.galleta);
  revisar(ckOtra.status === 409, "ya activa: un segundo checkout se rechaza antes de llegar a Stripe (409)", String(ckOtra.status));
  const { data: vistaAdmin } = await admin.from("suscripciones").select("estado, planes(nombre)").eq("club_id", c2).maybeSingle();
  revisar(vistaAdmin?.estado === "activa" && vistaAdmin.planes?.nombre === `Plan Base ${suf}`, "/admin/mensualidad lo ve activo con su plan");

  // Variante: antro de cortesía (publicado por el admin, sin fila de
  // mensualidad) cuyo dueño intenta suscribirse y el primer pago nunca se completa.
  const duenoC = await cuenta("duenoC", "dueno");
  const cC = await clubVerificado("Cortesia", duenoC);
  await svc.from("clubs").update({ suscripcion_activa: true }).eq("id", cC);
  const SUBc = `sub_recC${suf}`;
  const sc = (status) => suscripcion({ id: SUBc, customer: `cus_recC${suf}`, club: cC, status, price: PRECIO_A });
  await enviar(evento("customer.subscription.created", sc("incomplete")));
  await cron();
  revisar((await sus(cC))?.estado === "sin_suscripcion" && (await enCatalogo(cC)), "cortesía con un pago a medias (incomplete): sigue publicado");
  await enviar(evento("customer.subscription.updated", sc("incomplete_expired")));
  await svc.from("suscripciones").update({ gracia_hasta: new Date(Date.now() - 60_000).toISOString() }).eq("club_id", cC);
  await cron();
  if (!(await enCatalogo(cC))) anotar("un antro de CORTESÍA (publicado sin suscripción) cuyo primer pago expira (incomplete_expired → «cancelada») pierde la publicación en la siguiente tarea diaria, aunque nunca pagó ni debía. La doc dice que los antros sin suscripción «no se tocan».");

  // =====================================================================
  recorrido("3. Paso de plan");
  // =====================================================================
  const dueno3 = await cuenta("dueno3", "dueno");
  const c3 = await clubVerificado("Plan", dueno3);
  const SUB3 = `sub_rec3${suf}`;
  const CUS3 = `cus_rec3${suf}`;
  const fin3 = ahoraS() + 20 * DIA;
  const s3 = (status, price, extra = {}) => suscripcion({ id: SUB3, customer: CUS3, club: c3, status, price, fin: fin3, ...extra });
  await enviar(evento("customer.subscription.created", s3("active", PRECIO_A)));
  revisar((await sus(c3))?.plan_id === planA.id, "punto de partida: activa en el Plan Base");
  // Sube de plan desde el portal (o el Dashboard): mismo item, otro precio, mismo periodo.
  const rB = await enviar(evento("customer.subscription.updated", s3("active", PRECIO_B), tic(), { data: { object: s3("active", PRECIO_B), previous_attributes: { items: { data: [{ price: { id: PRECIO_A } }] } } } }));
  s = await sus(c3);
  revisar(rB.cuerpo.resultado === "aplicado" && s.plan_id === planB.id && s.estado === "activa" && Date.parse(s.periodo_fin) === fin3 * 1000, "otro precio que es de un plan → la app lo liga a ese plan; sigue activa, mismo periodo");
  dv = await duenoVe(dueno3, c3);
  revisar(dv.sus?.plan_id === planB.id, "el dueño ve el plan nuevo");
  // Factura de prorrateo (billing_reason subscription_update).
  const IN3 = `in_rec3p${suf}`;
  await enviar(evento("invoice.paid", factura({ id: IN3, customer: CUS3, sub: SUB3, club: c3, status: "paid", motivo: "subscription_update", monto: 100000, pagado: 100000, lineas: [{ amount: -166667, period: { start: ahoraS(), end: fin3 } }, { amount: 266667, period: { start: ahoraS(), end: fin3 } }] })));
  const p3 = (await pagosDe(c3)).find((p) => p.stripe_invoice_id === IN3);
  revisar(p3?.estado === "pagado" && p3.monto_centavos === 100000, "la factura del prorrateo entra al historial con lo cobrado");
  // La gracia ahora es la del plan nuevo (3 días).
  await enviar(evento("customer.subscription.updated", s3("past_due", PRECIO_B)));
  s = await sus(c3);
  const dias3 = (Date.parse(s.gracia_hasta) - Date.now()) / 864e5;
  revisar(s.estado === "en_gracia" && dias3 > 2.9 && dias3 < 4.1, `un cobro fallido después del cambio usa la gracia del plan nuevo (${dias3.toFixed(2)} días de 3)`);
  await enviar(evento("customer.subscription.updated", s3("active", PRECIO_B)));
  // Un precio de Stripe que no está dado de alta como plan.
  const rX = await enviar(evento("customer.subscription.updated", s3("active", PRECIO_SUELTO)));
  s = await sus(c3);
  revisar(rX.cuerpo.resultado === "aplicado" && s.estado === "activa", "un precio que no es de ningún plan no rompe el webhook (sigue activa)");
  if (s.plan_id === planB.id) anotar("un precio que no es de ningún plan NO se guarda: plan_id se queda en el plan anterior (Plan Grande) y el dueño y el admin ven ese nombre y ese monto aunque Stripe cobre otro. El price_id no se guarda en ningún lado.");
  // Downgrade de regreso a A y el plan B desactivado: la base lo liga aunque el plan esté inactivo.
  await admin.from("planes").update({ activo: false }).eq("id", planB.id);
  await enviar(evento("customer.subscription.updated", s3("active", PRECIO_B)));
  s = await sus(c3);
  const planesActivos = (await dueno3.c.from("planes").select("id").eq("activo", true)).data ?? [];
  if (s.plan_id === planB.id && !planesActivos.some((p) => p.id === planB.id)) {
    anotar("si el plan está desactivado, el webhook lo liga igual (no revisa «activo»), pero /dueno/mensualidad solo carga planes activos: el dueño deja de ver el nombre de su plan.");
  }
  await admin.from("planes").update({ activo: true }).eq("id", planB.id);
  // Dos items (por ejemplo, un complemento): solo se lee el primero.
  const dosItems = s3("active", PRECIO_A, {
    items: [
      { id: "si_extra", object: "subscription_item", current_period_end: fin3, price: { id: PRECIO_SUELTO } },
      { id: "si_base", object: "subscription_item", current_period_end: fin3, price: { id: PRECIO_A } },
    ],
  });
  await enviar(evento("customer.subscription.updated", dosItems));
  if ((await sus(c3)).plan_id !== planA.id) anotar("con dos items en la suscripción solo se lee el primero (items.data[0]); si el plan va en otro item, no se reconoce.");

  // =====================================================================
  recorrido("4. Cancelación al final del periodo");
  // =====================================================================
  const dueno4 = await cuenta("dueno4", "dueno");
  const c4 = await clubVerificado("Cancela", dueno4);
  const staff4 = await cuenta("staff4", "staff", c4);
  const rp4 = await cuenta("rp4", "rp", c4);
  const SUB4 = `sub_rec4${suf}`;
  const CUS4 = `cus_rec4${suf}`;
  const fin4 = ahoraS() + 12 * DIA;
  const s4 = (status, extra = {}) => suscripcion({ id: SUB4, customer: CUS4, club: c4, status, price: PRECIO_A, fin: fin4, ...extra });
  await enviar(evento("customer.subscription.created", s4("active")));
  // El dueño cancela en el portal «al final del periodo».
  const rCan = await enviar(evento("customer.subscription.updated", s4("active", { cancelAlFinal: true, cancelAt: fin4, canceledAt: ahoraS() }), tic(), { data: { object: s4("active", { cancelAlFinal: true, cancelAt: fin4, canceledAt: ahoraS() }), previous_attributes: { cancel_at_period_end: false, cancel_at: null } } }));
  s = await sus(c4);
  revisar(rCan.cuerpo.resultado === "aplicado" && s.estado === "activa" && s.cancelar_al_final === true && Date.parse(s.periodo_fin) === fin4 * 1000, "cancel_at_period_end: sigue activa, marcada para cancelarse al fin del periodo");
  revisar((await enCatalogo(c4)) && (await clienteReserva(cliente, c4)), "mientras tanto sigue publicado y recibe reservas");
  dv = await duenoVe(dueno4, c4);
  revisar(dv.sus?.estado === "activa" && dv.sus.cancelar_al_final === true && dv.sus.periodo_fin, "el dueño ve «Se cancela el <fin del periodo>» (estado activa + cancelar_al_final + periodo_fin)");
  // Reactivación antes del fin.
  await enviar(evento("customer.subscription.updated", s4("active")));
  s = await sus(c4);
  revisar(s.estado === "activa" && s.cancelar_al_final === false, "reactiva antes del fin: vuelve a «Próximo cobro»");
  // Cancela otra vez y llega el fin del periodo.
  await enviar(evento("customer.subscription.updated", s4("active", { cancelAlFinal: true, cancelAt: fin4, canceledAt: ahoraS() })));
  const tFin = tic();
  const rDel = await enviar(evento("customer.subscription.deleted", s4("canceled", { cancelAlFinal: true, cancelAt: fin4, canceledAt: ahoraS(), endedAt: ahoraS() }), tFin));
  s = await sus(c4);
  revisar(rDel.cuerpo.resultado === "aplicado" && s.estado === "cancelada" && zonaHora(new Date(s.gracia_hasta), "America/Mexico_City") === "08:00", "fin del periodo (subscription.deleted): cancelada, publicada hasta el siguiente 08:00");
  // Un updated del mismo segundo que llega después no la revive.
  const rTarde = await enviar(evento("customer.subscription.updated", s4("active", { cancelAlFinal: true }), tFin));
  revisar(rTarde.cuerpo.resultado === "viejo" && (await sus(c4)).estado === "cancelada", "un «updated active» del mismo segundo que llega tarde no revive la cancelada");
  revisar((await publicado(c4)) === true && (await enCatalogo(c4)), "recién cancelada sigue en el catálogo hasta el corte");
  revisar(await clienteReserva(cliente, c4), "…y recibe reservas hasta el corte");
  const { data: res4 } = await svc.from("reservations").select("qr_code").eq("club_id", c4).eq("cliente_id", cliente.id).limit(1).maybeSingle();
  await cron();
  revisar(Date.parse(s.gracia_hasta) > Date.now() ? (await enCatalogo(c4)) : true, "la tarea diaria antes del corte no la quita");
  if (Date.parse(s.gracia_hasta) > Date.now()) anotar("recién cancelada (antes del corte) /dueno/mensualidad ya dice «Tu antro ya no se muestra a los clientes», pero sí se muestra hasta las 08:00.");
  await svc.from("suscripciones").update({ gracia_hasta: new Date(Date.now() - 60_000).toISOString() }).eq("club_id", c4);
  await cron();
  revisar(!(await enCatalogo(c4)) && !(await clienteReserva(cliente, c4)), "pasado el corte: fuera del catálogo y sin reservas nuevas");
  revisar(await staffOpera(staff4, c4, res4?.qr_code), "cancelada: el staff sigue operando la caja y la puerta por QR");
  const b4 = await anon.rpc("obtener_reserva_por_qr", { p_qr: res4?.qr_code ?? "" });
  revisar(b4.data?.[0]?.estado_boleto === "vigente" && b4.data[0].club_direccion === null, "cancelada: el boleto previo abre, sin la dirección del antro");
  const rp4res = await rp4.c.from("reservations").insert({ cliente_nombre: "MensRec RP", cliente_telefono: "5544444444", rp_id: rp4.id, club_id: c4, source: "rp", fecha: noche(9), personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}` });
  if (!rp4res.error) anotar("cancelada: un RP del antro también sigue creando reservas.");
  dv = await duenoVe(dueno4, c4);
  revisar(dv.club && dv.sus?.estado === "cancelada", "el dueño sigue entrando y ve «Cancelada» (con los planes para volver)");
  const g4 = await galletas(dueno4.email);
  revisar((await post("/api/mensualidad/checkout", { club_id: c4, plan_id: planA.id }, g4.galleta)).status === 502, "cancelada: puede volver a suscribirse (checkout llega hasta Stripe)");
  // Cancelación programada solo con cancel_at (sin cancel_at_period_end), como la
  // puede dejar el Dashboard con fecha o, según la versión, el portal.
  const SUB4b = `sub_rec4b${suf}`;
  await enviar(evento("customer.subscription.created", { ...s4("active"), id: SUB4b }));
  await enviar(evento("customer.subscription.updated", { ...s4("active", { cancelAt: fin4 }), id: SUB4b }));
  s = await sus(c4);
  revisar(s.estado === "activa" && s.stripe_subscription_id === SUB4b, "suscripción nueva con cancelación programada por fecha (cancel_at): activa");
  if (s.cancelar_al_final === false) anotar("con cancel_at (fecha) y cancel_at_period_end=false la app NO marca cancelar_al_final: el dueño vería «Próximo cobro» en vez de «Se cancela el…». Revisar con llaves reales qué manda el portal.");
} catch (e) {
  revisar(false, "error inesperado: " + (e?.stack ?? e?.message ?? e));
} finally {
  // ---------- Limpieza (solo dev) ----------
  await svc.from("stripe_eventos").delete().like("id", `evt_rec${suf}%`);
  if (archivos.length) await svc.storage.from("verificacion-docs").remove(archivos);
  if (clubs.length) {
    await svc.from("reservations").delete().in("club_id", clubs);
    await svc.from("reserva_intentos").delete().in("club_id", clubs);
    await svc.from("pagos_mensualidad").delete().in("club_id", clubs);
    await svc.from("suscripciones").delete().in("club_id", clubs);
    await svc.from("verificacion_documentos").delete().in("club_id", clubs);
  }
  await svc.from("reservations").delete().like("cliente_nombre", "MensRec%");
  await svc.from("planes").delete().like("clave", `%-${suf}`);
  if (ids.length) await svc.from("profiles").delete().in("id", ids);
  if (clubs.length) {
    await svc.from("club_altas").delete().in("club_id", clubs);
    await svc.from("clubs").delete().in("id", clubs);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const quedanClubs = ((await svc.from("clubs").select("id").like("nombre", `MensRec%${suf}`)).data ?? []).length;
  const quedanUsuarios = ((await svc.auth.admin.listUsers({ perPage: 1000 })).data?.users ?? []).filter((u) => (u.email ?? "").includes(suf)).length;
  const quedanEventos = ((await svc.from("stripe_eventos").select("id").like("id", `evt_rec${suf}%`)).data ?? []).length;
  const quedanPlanes = ((await svc.from("planes").select("id").like("clave", `%-${suf}`)).data ?? []).length;
  const quedan = quedanClubs + quedanUsuarios + quedanEventos + quedanPlanes;
  console.log(quedan === 0 ? "\nLimpieza: no quedó nada de la prueba." : `\nLimpieza: QUEDARON ${quedanClubs} antros, ${quedanUsuarios} cuentas, ${quedanEventos} eventos y ${quedanPlanes} planes.`);

  console.log("\nResumen por recorrido:");
  let total = 0, malos = 0;
  for (const [nombre, c] of Object.entries(cuentas)) {
    console.log(`  ${nombre}: ${c.pasan}/${c.pasan + c.fallan}`);
    total += c.pasan + c.fallan;
    malos += c.fallan;
  }
  console.log(`  Total: ${total - malos}/${total}`);
  if (notas.length) {
    console.log("\nComportamiento real anotado (riesgos o decisiones, no cuenta en N/N):");
    for (const n of notas) console.log("  - " + n);
  }
  if (malos || quedan) process.exitCode = 1;
}
