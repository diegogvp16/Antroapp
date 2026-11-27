// Pruebas de los reportes PDF del dueño (sql/post-junta-3/70-reportes-pdf.sql,
// /grupo/reportes) contra antroapp-dev y el servidor local de dev, con
// sesiones REALES. Se niega a correr fuera de dev.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-reportes-pdf.mjs [http://localhost:3045]
//
// 1. Bandera 'reportes_pdf': la enciende (como admin) para Club Demo Dev y
//    Club Tijuana Dev solo durante la prueba y al final deja el valor que
//    tenía (en dev: sin valor = apagada). Con la bandera apagada, la base
//    rechaza y la pantalla esconde los enlaces.
// 2. Quién lo ve (en la base): admin, dueño, dueño de grupo y gerente activo
//    sí; staff, RP, cliente, dueño y gerente de otro antro, anónimo y cuenta
//    sin perfil, no.
// 3. Cifras: reporte_pdf_noche = reporte_cierre_noche; reporte_pdf_semana =
//    las 7 noches del cierre, grupo_resumen, grupo_rendimiento_rp, nómina de
//    la semana, exportes (reservas, consumos, comisiones) y los cobros de
//    caja_pagos, al centavo.
// 4. El PDF descargado desde la pantalla (dueño): lo lee pdftotext (lector
//    independiente) y se buscan las cifras de la base, renglón por renglón,
//    con sus acentos. Noche con datos, semana cerrada, semana en curso
//    (parcial), noche en curso y noche sin movimientos.
// 5. Pantalla a 390×844 y 360×740 (capturas en screenshots-n4-reportes/),
//    y las hojas del PDF dibujadas con pdf.js (si hay red) para verlas.
//
// Datos de prueba: solo una cuenta de Auth sin perfil (t_n4_rep_…), que se
// borra al final. Los datos demo se leen, no se cambian.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3045";
const SHOTS = path.join(RAIZ, "screenshots-n4-reportes") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const CLUB = cred.clubs.demo;
const TIJUANA = cred.clubs.tijuana;
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const nuevoAnon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
const TAG = "t_n4_rep_" + randomUUID().slice(0, 6);

let pasan = 0;
let fallan = 0;
const fallas = [];
function revisar(nombre, paso, detalle = "") {
  if (paso) pasan++;
  else {
    fallan++;
    fallas.push(nombre);
  }
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${!paso && detalle ? "  — " + String(detalle).slice(0, 400) : ""}`);
}
const igual = (nombre, a, b) => revisar(nombre, Number(a) === Number(b), `${a} ≠ ${b}`);
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Igual que lib/domain/reporte-pdf.ts (pesos con centavos, es-MX).
const fmtPesos = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pesos = (c) => fmtPesos.format(Number(c) / 100).replace(/[  ]/g, " ").replace(/−/g, "-");
const fmtEntero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const entero = (n) => fmtEntero.format(Number(n));
const fechaCorta = (f) => {
  const [a, m, d] = f.split("-").map(Number);
  return new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .format(new Date(Date.UTC(a, m - 1, d))).replace(/\./g, "").replace(",", "");
};
const sumarDias = (f, n) => {
  const [a, m, d] = f.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};
const lunesDe = (f) => {
  const [a, m, d] = f.split("-").map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return sumarDias(f, dia === 0 ? -6 : 1 - dia);
};

// ---------- Sesiones (otras pruebas entran a la vez: reintento con espera) ----------
const sesiones = {};
async function sesion(clave, email = cred.usuarios[clave], password = cred.password) {
  if (sesiones[clave]) return sesiones[clave];
  for (let intento = 1; intento <= 6; intento++) {
    const c = nuevoAnon();
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (!error) return (sesiones[clave] = c);
    if (!/rate|too many|429/i.test(error.message) || intento === 6) throw new Error(`login ${clave}: ${error.message}`);
    await espera(2000 * intento);
  }
}

// ---------- Bandera ----------
const db = await conectarDevEscritura();
const [{ v_demo, v_tij }] = await db.q(
  `select (select activa from public.club_funciones where club_id = $1 and funcion = 'reportes_pdf') as v_demo,
          (select activa from public.club_funciones where club_id = $2 and funcion = 'reportes_pdf') as v_tij`,
  [CLUB, TIJUANA],
);
const grupoFlag = await db.q(
  `select gf.grupo_id, gf.activa from public.grupo_funciones gf join public.grupo_clubs gc on gc.grupo_id = gf.grupo_id
    where gc.club_id = any($1::uuid[]) and gf.funcion = 'reportes_pdf'`,
  [[CLUB, TIJUANA]],
);
console.log(`Bandera antes: Club Demo Dev = ${v_demo}, Tijuana = ${v_tij}, grupo = ${JSON.stringify(grupoFlag)}`);
async function bandera(club, valor) {
  const admin = await sesion("admin");
  ok(await admin.rpc("funcion_cambiar", { p_club_id: club, p_funcion: "reportes_pdf", p_activa: valor }), "funcion_cambiar");
}
async function restaurarBanderas() {
  await bandera(CLUB, v_demo);
  await bandera(TIJUANA, v_tij);
  const [{ a, b }] = await db.q(
    `select (select activa from public.club_funciones where club_id = $1 and funcion = 'reportes_pdf') as a,
            (select activa from public.club_funciones where club_id = $2 and funcion = 'reportes_pdf') as b`,
    [CLUB, TIJUANA],
  );
  revisar(`bandera restaurada (Demo ${a}, Tijuana ${b})`, a === v_demo && b === v_tij);
}

// ---------- Cuenta sin perfil ----------
let sinPerfilId = null;
const PASS_SIN = "Prueba-" + randomUUID();
async function crearSinPerfil() {
  const u = ok(await svc.auth.admin.createUser({ email: `${TAG}_sinperfil@example.com`, password: PASS_SIN, email_confirm: true }), "crear sin perfil");
  sinPerfilId = u.user.id;
}
async function limpiar() {
  if (sinPerfilId) {
    await db.q("delete from public.profiles where id = $1", [sinPerfilId]);
    await svc.auth.admin.deleteUser(sinPerfilId);
  }
  const [r] = await db.q(
    `select (select count(*) from auth.users where email like $1)::int usuarios,
            (select count(*) from public.profiles p join auth.users u on u.id = p.id where u.email like $1)::int perfiles`,
    [`${TAG}%`],
  );
  revisar(`limpieza: 0 restos con prefijo ${TAG} (${JSON.stringify(r)})`, r.usuarios === 0 && r.perfiles === 0);
}

// ---------- Llamadas ----------
async function llamar(c, fn, args) {
  const { data, error } = await c.rpc(fn, args);
  return { data, error };
}
const noche = (c, club, fecha) => llamar(c, "reporte_pdf_noche", { p_club_id: club, p_fecha: fecha });
const semana = (c, club, lunes) => llamar(c, "reporte_pdf_semana", { p_club_id: club, p_lunes: lunes });

// Todas las páginas de un exporte (paginación por llave).
async function exporte(c, fn, desde, hasta) {
  const filas = [];
  let despues = null;
  for (;;) {
    const lote = ok(await c.rpc(fn, { p_club_id: CLUB, p_desde: desde, p_hasta: hasta, p_despues: despues, p_limite: 1000 }), fn);
    filas.push(...lote);
    if (lote.length < 1000) return filas;
    despues = lote[lote.length - 1].orden;
  }
}

// ---------- PDF → texto (lector independiente) ----------
// Dos lecturas: -layout (como se ve) y -raw (en el orden en que se escribió,
// una fila de tabla por renglón). Las búsquedas de filas usan las dos.
function pdfATexto(ruta) {
  execFileSync("pdftotext", ["-enc", "UTF-8", "-layout", ruta, ruta + ".txt"]);
  execFileSync("pdftotext", ["-enc", "UTF-8", "-raw", ruta, ruta + ".raw.txt"]);
  return readFileSync(ruta + ".txt", "utf8") + "\n" + readFileSync(ruta + ".raw.txt", "utf8");
}
// El renglón que empieza con `inicio` tiene `valores` en ese orden.
function renglonConValores(txt, inicio, valores) {
  const lineas = txt.split(/\r?\n/).filter((l) => l.trimStart().startsWith(inicio));
  return lineas.some((l) => {
    let desde = l.indexOf(inicio) + inicio.length;
    for (const v of valores) {
      const i = l.indexOf(v, desde);
      if (i < 0) return false;
      desde = i + v.length;
    }
    return true;
  });
}

const resumen = {};
let navegador = null;

try {
  await crearSinPerfil();
  const anon = nuevoAnon();
  const sinPerfil = await sesion("sin_perfil", `${TAG}_sinperfil@example.com`, PASS_SIN);
  const D = await sesion("dueno");

  // Noche y semanas de prueba, de los datos demo que haya HOY en dev.
  const [{ hoy }] = await db.q("select public.club_fecha_operacion($1)::text as hoy", [CLUB]);
  const noches = await db.q(
    `select n.fecha_operacion::text f, n.estado from public.caja_noches n
      where n.club_id = $1 and exists (select 1 from public.caja_consumos k where k.noche_id = n.id and not k.anulado)
      order by 1 desc`,
    [CLUB],
  );
  if (noches.length === 0) throw new Error("Club Demo Dev no tiene noches con consumo: regenera la demo (scripts/demo-datos.mjs).");
  const N = noches[0].f; // la noche demo más reciente con consumo
  const cerradas = noches.filter((x) => x.f < lunesDe(hoy));
  const W1 = cerradas.length ? lunesDe(cerradas[0].f) : lunesDe(N); // semana ya terminada
  const W2 = lunesDe(hoy); // semana en curso (parcial)
  const [{ vacia }] = await db.q(
    `select d::date::text as vacia from generate_series($2::date - 30, $2::date - 1, interval '1 day') d
      where not exists (select 1 from public.reservations r where r.club_id = $1 and r.fecha = d::date)
        and not exists (select 1 from public.caja_noches n where n.club_id = $1 and n.fecha_operacion = d::date)
        and not exists (select 1 from public.rp_pagos_dia p where p.club_id = $1 and p.fecha = d::date)
      order by 1 desc limit 1`,
    [CLUB, hoy],
  );
  console.log(`Noche en curso ${hoy}; noche demo ${N}; semana cerrada ${W1}; semana en curso ${W2}; noche vacía ${vacia}`);
  Object.assign(resumen, { hoy, N, W1, W2, vacia });

  // =====================================================================
  // 1. Bandera apagada: nadie lo obtiene.
  // =====================================================================
  console.log("\n— Bandera apagada —");
  await bandera(CLUB, false);
  await bandera(TIJUANA, false);
  for (const clave of ["admin", "dueno", "gerente"]) {
    const c = await sesion(clave);
    const r1 = await noche(c, CLUB, N);
    const r2 = await semana(c, CLUB, W1);
    revisar(`apagada: ${clave} rechazado en noche y semana ("no están activos")`,
      /no están activos/.test(r1.error?.message ?? "") && /no están activos/.test(r2.error?.message ?? ""), `${r1.error?.message} / ${r2.error?.message}`);
  }
  const fD = ok(await D.rpc("mis_funciones", { p_club_id: CLUB }), "mis_funciones");
  revisar("apagada: mis_funciones del dueño no trae reportes_pdf", !fD.includes("reportes_pdf"));

  // =====================================================================
  // 2. Encendida: quién lo ve.
  // =====================================================================
  console.log("\n— Acceso con la bandera encendida —");
  await bandera(CLUB, true);
  await bandera(TIJUANA, true);
  const fD2 = ok(await D.rpc("mis_funciones", { p_club_id: CLUB }), "mis_funciones");
  revisar("encendida: mis_funciones del dueño trae reportes_pdf", fD2.includes("reportes_pdf"));
  const casos = [
    ["admin", CLUB, true],
    ["dueno", CLUB, true],
    ["gerente", CLUB, true],
    ["staff", CLUB, false],
    ["rp", CLUB, false],
    ["cliente", CLUB, false],
    ["dueno_tijuana", CLUB, false],
    ["gerente_tijuana", CLUB, false],
    ["dueno", TIJUANA, true], // dueño de grupo (no es dueño directo de Tijuana)
    ["dueno_tijuana", TIJUANA, true],
    ["gerente_tijuana", TIJUANA, true],
    ["gerente", TIJUANA, false],
    ["staff_tijuana", TIJUANA, false],
    ["rp_tijuana", TIJUANA, false],
  ];
  const [{ dg }] = await db.q(
    "select exists (select 1 from public.clubs where id = $1 and dueno_id = (select id from auth.users where email = $2)) as dg",
    [TIJUANA, cred.usuarios.dueno],
  );
  revisar("dev_dueno NO es dueño directo de Tijuana (su acceso es de dueño de grupo)", dg === false);
  for (const [clave, club, debe] of casos) {
    const c = await sesion(clave);
    const r1 = await noche(c, club, N);
    const r2 = await semana(c, club, W1);
    const pasa = debe ? !r1.error && !r2.error && r1.data?.tipo === "noche" && r2.data?.tipo === "semana" : !!r1.error && !!r2.error && !r1.data && !r2.data;
    const msj = debe ? "" : /No tienes acceso/.test(r1.error?.message ?? "") ? " (No tienes acceso)" : ` (${r1.error?.message})`;
    revisar(`${clave} en ${club === CLUB ? "Club Demo Dev" : "Tijuana"}: ${debe ? "lo ve" : "rechazado"}${msj}`, pasa, `${r1.error?.message ?? "ok"} / ${r2.error?.message ?? "ok"}`);
  }
  for (const [nombre, c] of [["anónimo", anon], ["cuenta sin perfil", sinPerfil]]) {
    const r1 = await noche(c, CLUB, N);
    const r2 = await semana(c, CLUB, W1);
    revisar(`${nombre}: rechazado (${r1.error?.code ?? "?"} ${r1.error?.message?.slice(0, 50) ?? ""})`, !!r1.error && !!r2.error && !r1.data && !r2.data);
  }
  // Internas sin EXECUTE para nadie de la API.
  const intAut = await llamar(D, "reporte_pdf_autorizar", { p_club_id: CLUB });
  revisar("reporte_pdf_autorizar no se puede llamar desde la API", !!intAut.error);
  // La bandera de UN antro no abre otro.
  await bandera(TIJUANA, false);
  const rT = await noche(D, TIJUANA, N);
  revisar("Tijuana apagada y Demo encendida: dueño de grupo rechazado en Tijuana", /no están activos/.test(rT.error?.message ?? ""), rT.error?.message);
  const rT2 = await noche(await sesion("dueno_tijuana"), TIJUANA, N);
  revisar("Tijuana apagada: su dueño rechazado", /no están activos/.test(rT2.error?.message ?? ""), rT2.error?.message);
  await bandera(TIJUANA, true);
  // Validaciones.
  const rMar = await semana(D, CLUB, sumarDias(W1, 1));
  revisar("semana que no empieza en lunes: rechazada con aviso", /lunes/.test(rMar.error?.message ?? ""), rMar.error?.message);
  const rLej = await semana(D, CLUB, sumarDias(W2, 7 * 20));
  revisar("semana a más de 3 meses: rechazada", /próximos 3 meses/.test(rLej.error?.message ?? ""), rLej.error?.message);
  const rNul = await noche(D, CLUB, null);
  revisar("noche sin fecha: rechazada", /Elige la noche/.test(rNul.error?.message ?? ""), rNul.error?.message);

  // =====================================================================
  // 3. Cifras: el reporte = las fuentes de verdad.
  // =====================================================================
  console.log("\n— Cifras contra las fuentes —");
  const quitar = (o) => {
    const x = structuredClone(o);
    delete x.generado_en;
    delete x.generado_local;
    delete x.tipo;
    return JSON.stringify(x);
  };
  const datos = {};
  for (const [clave, c] of [["dueno", D], ["admin", await sesion("admin")], ["gerente", await sesion("gerente")]]) {
    const pdfN = ok(await noche(c, CLUB, N), "pdf noche");
    const cierre = ok(await c.rpc("reporte_cierre_noche", { p_club_id: CLUB, p_fecha: N }), "cierre");
    revisar(`${clave}: reporte de la noche = reporte_cierre_noche (todo el JSON)`, quitar(pdfN) === quitar(cierre));
    revisar(`${clave}: hora de generación en la zona del antro`, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(pdfN.generado_local), pdfN.generado_local);
    if (clave === "dueno") datos.noche = pdfN;
  }

  async function verificarSemana(lunes, etiqueta) {
    const domingo = sumarDias(lunes, 6);
    const s = ok(await semana(D, CLUB, lunes), "pdf semana");
    igual(`${etiqueta}: 7 noches`, s.noches.length, 7);
    revisar(`${etiqueta}: lunes a domingo`, s.lunes === lunes && s.domingo === domingo && s.noches[0].fecha === lunes && s.noches[6].fecha === domingo);
    // Cada noche = su cierre.
    let nochesOk = true;
    for (const n of s.noches) {
      const c = ok(await D.rpc("reporte_cierre_noche", { p_club_id: CLUB, p_fecha: n.fecha }), "cierre");
      const pares = [
        [n.reservas, c.reservas.reservas], [n.personas, c.reservas.personas], [n.entraron, c.reservas.entraron],
        [n.consumieron, c.reservas.consumieron], [n.no_llegaron, c.reservas.no_llegaron], [n.por_llegar, c.reservas.por_llegar],
        [n.cuentas, c.walk_ins.cuentas_total], [n.consumo_centavos, c.consumo.total_centavos],
        [n.cuentas_con_consumo, c.consumo.cuentas_con_consumo], [n.ticket_promedio_centavos, c.consumo.ticket_promedio_centavos],
        [n.efectivo_centavos, c.cobros.efectivo_centavos], [n.tarjeta_centavos, c.cobros.tarjeta_centavos],
        [n.otro_centavos, c.cobros.otro_centavos], [n.cobrado_centavos, c.cobros.total_centavos],
        [n.comisiones_centavos, c.comisiones.total_centavos], [n.grupos, c.mesas.grupos], [n.mesas_usadas, c.mesas.mesas_usadas],
        [n.consumos_anulados, c.anulaciones.consumos], [n.consumos_anulados_centavos, c.anulaciones.consumos_centavos],
        [n.cobros_anulados, c.anulaciones.cobros], [n.cobros_anulados_centavos, c.anulaciones.cobros_centavos],
        [n.mesas_reabiertas, c.anulaciones.mesas_reabiertas], [n.diferencia_centavos ?? 0, c.cuadre?.diferencia_centavos ?? 0],
      ];
      if (!pares.every(([a, b]) => Number(a) === Number(b)) || n.termino !== c.termino || n.con_cuadre !== (c.cuadre !== null)) {
        nochesOk = false;
        console.log("   noche distinta:", n.fecha, JSON.stringify(pares));
      }
    }
    revisar(`${etiqueta}: cada noche = reporte_cierre_noche de esa noche`, nochesOk);
    // /grupo.
    const g = ok(await D.rpc("grupo_resumen", { p_desde: lunes, p_hasta: domingo }), "grupo_resumen").find((x) => x.club_id === CLUB);
    const t = s.totales;
    igual(`${etiqueta}: consumo = /grupo`, t.consumo_centavos, g.consumo_centavos);
    igual(`${etiqueta}: cuentas con consumo = /grupo`, t.cuentas_con_consumo, g.cuentas_con_consumo);
    igual(`${etiqueta}: ticket promedio = /grupo`, t.ticket_promedio_centavos, g.ticket_promedio_centavos);
    igual(`${etiqueta}: reservas = /grupo`, t.reservas, g.reservas);
    igual(`${etiqueta}: entraron = /grupo`, t.entraron, g.entraron);
    igual(`${etiqueta}: consumieron = /grupo`, t.consumieron, g.reservas_con_consumo);
    igual(`${etiqueta}: comisiones = /grupo`, t.comisiones_centavos, g.comisiones_centavos);
    const sumaNoches = (k) => s.noches.reduce((a, n) => a + Number(n[k]), 0);
    revisar(`${etiqueta}: totales = suma de las noches`, ["consumo_centavos", "cobrado_centavos", "comisiones_centavos", "reservas", "cuentas", "efectivo_centavos", "tarjeta_centavos", "otro_centavos"].every((k) => sumaNoches(k) === Number(t[k])));
    igual(`${etiqueta}: ticket = round(consumo / cuentas con consumo)`, t.ticket_promedio_centavos, t.cuentas_con_consumo ? Math.round(t.consumo_centavos / t.cuentas_con_consumo) : 0);
    // Rendimiento por RP.
    const rend = ok(await D.rpc("grupo_rendimiento_rp", { p_club_id: CLUB, p_desde: lunes, p_hasta: domingo }), "rendimiento").filter((r) => r.reservas > 0 || r.comisiones_centavos > 0);
    igual(`${etiqueta}: RPs = rendimiento de /grupo con datos`, s.rps.length, rend.length);
    revisar(`${etiqueta}: cada RP = /grupo (reservas, llegaron, consumieron, consumo, comisión)`, rend.every((r) => {
      const x = s.rps.find((y) => y.rp_id === r.rp_id);
      return x && ["reservas", "entraron", "consumieron", "consumo_centavos", "comisiones_centavos"].every((k) => Number(x[k]) === Number(r[k]));
    }));
    // Nómina.
    const iso = s.semana_iso;
    const nom = ok(await D.rpc("nomina_semana", { p_club_id: CLUB, p_anio: iso.anio, p_semana: iso.semana }), "nomina");
    igual(`${etiqueta}: comisiones = nómina de la semana ${iso.semana} (suma)`, t.comisiones_centavos, nom.reduce((a, r) => a + Number(r.total_centavos), 0));
    revisar(`${etiqueta}: comisión de cada RP = su nómina`, nom.filter((r) => Number(r.total_centavos) !== 0).every((r) => Number(s.rps.find((x) => x.rp_id === r.rp_id)?.comisiones_centavos) === Number(r.total_centavos)));
    // Exportes.
    const xr = await exporte(D, "reporte_reservas", lunes, domingo);
    const xc = await exporte(D, "reporte_consumos", lunes, domingo);
    const xm = await exporte(D, "reporte_comisiones", lunes, domingo);
    igual(`${etiqueta}: reservas = exporte de reservas`, t.reservas, xr.length);
    igual(`${etiqueta}: consumieron = exporte (estado consumio)`, t.consumieron, xr.filter((r) => r.estado === "consumio").length);
    igual(`${etiqueta}: consumo = exporte de consumos sin anulados`, t.consumo_centavos, xc.filter((r) => !r.anulado).reduce((a, r) => a + Number(r.monto_centavos), 0));
    igual(`${etiqueta}: comisiones = exporte de comisiones sin anuladas`, t.comisiones_centavos, xm.filter((r) => r.estado !== "anulada").reduce((a, r) => a + Number(r.monto_centavos), 0));
    // Cobros (caja_pagos directo, como scripts/verificar-cuadre.mjs).
    const [p] = await db.q(
      `select coalesce(sum(p.monto_centavos) filter (where p.metodo = 'efectivo'), 0)::bigint ef,
              coalesce(sum(p.monto_centavos) filter (where p.metodo = 'tarjeta'), 0)::bigint ta,
              coalesce(sum(p.monto_centavos) filter (where p.metodo = 'otro'), 0)::bigint ot
         from public.caja_pagos p join public.caja_noches n on n.id = p.noche_id
        where n.club_id = $1 and n.fecha_operacion between $2 and $3 and not p.anulado`,
      [CLUB, lunes, domingo],
    );
    revisar(`${etiqueta}: cobrado por método = caja_pagos (${pesos(p.ef)} / ${pesos(p.ta)} / ${pesos(p.ot)})`,
      Number(t.efectivo_centavos) === Number(p.ef) && Number(t.tarjeta_centavos) === Number(p.ta) && Number(t.otro_centavos) === Number(p.ot));
    revisar(`${etiqueta}: parcial = ${s.parcial}`, s.parcial === s.noches.some((n) => !n.termino));
    const [an] = await db.q(
      `select (select count(*) from public.caja_consumos k join public.caja_noches n on n.id = k.noche_id
                where n.club_id = $1 and n.fecha_operacion between $2 and $3 and k.anulado)::int ca,
              (select coalesce(sum(k.monto_centavos), 0) from public.caja_consumos k join public.caja_noches n on n.id = k.noche_id
                where n.club_id = $1 and n.fecha_operacion between $2 and $3 and k.anulado)::bigint cac,
              (select count(*) from public.caja_pagos p join public.caja_noches n on n.id = p.noche_id
                where n.club_id = $1 and n.fecha_operacion between $2 and $3 and p.anulado)::int pa,
              (select coalesce(sum(p.monto_centavos), 0) from public.caja_pagos p join public.caja_noches n on n.id = p.noche_id
                where n.club_id = $1 and n.fecha_operacion between $2 and $3 and p.anulado)::bigint pac,
              (select count(*) from public.caja_eventos e join public.caja_noches n on n.id = e.noche_id
                where n.club_id = $1 and n.fecha_operacion between $2 and $3 and e.tipo = 'reabrir_mesa')::int re,
              (select count(*) from (select distinct q.noche_id from public.caja_cuadres q join public.caja_noches n on n.id = q.noche_id
                where n.club_id = $1 and n.fecha_operacion between $2 and $3 and q.tipo = 'noche') x)::int nq,
              (select coalesce(sum(d), 0) from (select distinct on (q.noche_id) q.diferencia_centavos d from public.caja_cuadres q
                join public.caja_noches n on n.id = q.noche_id where n.club_id = $1 and n.fecha_operacion between $2 and $3 and q.tipo = 'noche'
                order by q.noche_id, q.hecho_en desc) y)::bigint dif`,
      [CLUB, lunes, domingo],
    );
    revisar(`${etiqueta}: anulaciones = caja (consumos ${an.ca}/${pesos(an.cac)}, cobros ${an.pa}/${pesos(an.pac)}, reabiertas ${an.re})`,
      Number(t.consumos_anulados) === an.ca && Number(t.consumos_anulados_centavos) === Number(an.cac) && Number(t.cobros_anulados) === an.pa &&
      Number(t.cobros_anulados_centavos) === Number(an.pac) && Number(t.mesas_reabiertas) === an.re);
    revisar(`${etiqueta}: cuadres = caja_cuadres (${an.nq} noches, diferencia ${pesos(an.dif)})`,
      Number(t.noches_con_cuadre) === an.nq && Number(t.diferencia_centavos) === Number(an.dif));
    return s;
  }
  datos.w1 = await verificarSemana(W1, `semana ${W1}`);
  datos.w2 = await verificarSemana(W2, `semana ${W2} (en curso)`);
  revisar("la semana en curso sale parcial", datos.w2.parcial === true);
  resumen.noche = { consumo: pesos(datos.noche.consumo.total_centavos), ticket: pesos(datos.noche.consumo.ticket_promedio_centavos), cuentas: datos.noche.consumo.cuentas_con_consumo, cobrado: pesos(datos.noche.cobros.total_centavos), comisiones: pesos(datos.noche.comisiones.total_centavos), rps: datos.noche.rps.length };
  resumen.semana = { consumo: pesos(datos.w1.totales.consumo_centavos), ticket: pesos(datos.w1.totales.ticket_promedio_centavos), cuentas: datos.w1.totales.cuentas_con_consumo, cobrado: pesos(datos.w1.totales.cobrado_centavos), comisiones: pesos(datos.w1.totales.comisiones_centavos), rps: datos.w1.rps.length };

  // =====================================================================
  // 4 y 5. Pantalla y PDF descargado.
  // =====================================================================
  console.log("\n— Pantalla y PDF —");
  const desde = process.env.PLAYWRIGHT_DESDE;
  let playwright;
  try {
    playwright = req("playwright");
  } catch {
    if (!desde) throw new Error("Falta Playwright: define PLAYWRIGHT_DESDE.");
    playwright = await import(pathToFileURL(path.join(desde, "node_modules", "playwright", "index.mjs")).href);
  }
  navegador = await playwright.chromium.launch();
  const contextos = {};
  async function pantalla(clave, destino) {
    if (contextos[clave]) return contextos[clave];
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const p = await ctx.newPage();
    const errores = [];
    p.on("pageerror", (e) => errores.push(e.message.slice(0, 160)));
    p.on("console", (m) => {
      if (m.type() === "error" && !/DevTools|favicon|Download the React/.test(m.text())) errores.push(m.text().slice(0, 160));
    });
    for (let intento = 1; intento <= 4; intento++) {
      await p.goto(BASE + "/cliente/login");
      await p.fill("#email", cred.usuarios[clave]);
      await p.fill("#password", cred.password);
      await p.click("button[type=submit]");
      const entro = await p.waitForURL(destino, { timeout: 90000 }).then(() => true).catch(() => false);
      if (entro) break;
      if (intento === 4) throw new Error(`no entró ${clave}: ${p.url()}`);
      await espera(3000 * intento);
    }
    return (contextos[clave] = { ctx, p, errores });
  }
  const textoDe = (p) => p.locator("body").innerText();
  const sinScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  async function abrirReporte(p, tipo, fecha, club = CLUB) {
    await p.goto(`${BASE}/grupo/reportes?club=${club}&tipo=${tipo}&fecha=${fecha}`);
    await p.getByRole("heading", { name: "Reportes PDF" }).waitFor({ timeout: 90000 });
    const boton = p.getByRole("button", { name: "Descargar PDF" });
    await boton.waitFor({ timeout: 60000 }).catch(() => {});
    await p.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Descargar PDF"));
      return b && !b.disabled;
    }, null, { timeout: 90000 }).catch(() => {});
    await p.waitForTimeout(400);
  }
  async function descargar(p, nombre) {
    const [d] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.getByRole("button", { name: "Descargar PDF" }).click()]);
    const ruta = path.join(SHOTS, nombre);
    await d.saveAs(ruta);
    return { ruta, sugerido: d.suggestedFilename(), bytes: readFileSync(ruta) };
  }

  const { p: pd, errores: erroresDueno } = await pantalla("dueno", /dueno\/panel/);
  // Enlaces (bandera encendida).
  await pd.goto(BASE + "/dueno/panel");
  await pd.getByRole("heading", { name: "Panel de tu antro" }).waitFor({ timeout: 90000 });
  const enlacePanel = pd.getByRole("link", { name: /Reportes PDF/ });
  revisar("encendida: el panel del dueño muestra «Reportes PDF»", await enlacePanel.waitFor({ timeout: 30000 }).then(() => true).catch(() => false));
  await pd.screenshot({ path: SHOTS + "panel-dueno-enlace-390.png" });
  await pd.goto(BASE + "/grupo");
  revisar("encendida: /grupo muestra «Reportes PDF»", await pd.getByRole("link", { name: /Reportes PDF/ }).waitFor({ timeout: 60000 }).then(() => true).catch(() => false));

  // Noche con datos.
  await abrirReporte(pd, "noche", N);
  const tN = await textoDe(pd);
  const n = datos.noche;
  revisar(`pantalla noche ${N}: consumo, ticket, cobrado y comisiones = base`,
    [n.consumo.total_centavos, n.consumo.ticket_promedio_centavos, n.cobros.total_centavos, n.comisiones.total_centavos].every((c) => tN.includes(pesos(c))), tN.slice(0, 600));
  revisar("pantalla noche: con dos antros (Demo y Tijuana) hay selector", (await pd.locator("#pdf-antro option").count()) === 2);
  revisar("pantalla noche 390: sin scroll horizontal", await sinScroll(pd));
  await pd.screenshot({ path: SHOTS + `reporte-noche-390.png`, fullPage: true });
  const pdfN = await descargar(pd, `reporte-noche-${N}.pdf`);
  revisar(`PDF noche: nombre de archivo (${pdfN.sugerido})`, /^reporte-noche-club-demo-dev-\d{4}-\d{2}-\d{2}\.pdf$/.test(pdfN.sugerido));
  revisar("PDF noche: es un PDF", pdfN.bytes.subarray(0, 8).toString("latin1") === "%PDF-1.4");
  const txN = pdfATexto(pdfN.ruta);
  writeFileSync(SHOTS + `reporte-noche-${N}.txt`, txN);
  revisar("PDF noche: título, antro y periodo con acentos", txN.includes("Reporte de la noche") && txN.includes("Club Demo Dev") && /Noche del (lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d+ de \w+ de \d{4}/.test(txN));
  revisar("PDF noche: hora de generación y zona del antro", /Generado el \d+ de \w+ de \d{4}, \d{2}:\d{2} \(hora del antro, America\/\w+\)/.test(txN));
  for (const [que, valor] of [
    ["consumo total", pesos(n.consumo.total_centavos)],
    ["ticket promedio", pesos(n.consumo.ticket_promedio_centavos)],
    ["con reserva", pesos(n.consumo.con_reserva_centavos)],
    ["sin reserva", pesos(n.consumo.sin_reserva_centavos)],
  ]) revisar(`PDF noche: ${que} ${valor}`, txN.includes(valor));
  revisar(`PDF noche: cuentas ${n.walk_ins.cuentas_total} y cuentas con consumo ${n.consumo.cuentas_con_consumo}`, txN.includes(`÷ ${entero(n.consumo.cuentas_con_consumo)} cuentas con consumo`) && renglonConValores(txN, "Cuentas", []) && txN.includes(entero(n.walk_ins.cuentas_total)));
  revisar(`PDF noche: mesas usadas ${n.mesas.mesas_usadas} de ${n.mesas.mesas_antro}`, txN.includes(`${entero(n.mesas.mesas_usadas)} de ${entero(n.mesas.mesas_antro)}`));
  revisar(`PDF noche: reservas ${n.reservas.reservas} y ${n.reservas.personas} personas`, txN.includes(`${entero(n.reservas.personas)} personas · llegaron ${entero(n.reservas.entraron)} · consumieron ${entero(n.reservas.consumieron)}`));
  revisar("PDF noche: cobrado por método (renglón por renglón)",
    renglonConValores(txN, "Efectivo", [pesos(n.cobros.efectivo_centavos)]) && renglonConValores(txN, "Tarjeta", [pesos(n.cobros.tarjeta_centavos)]) &&
    renglonConValores(txN, "Otro", [pesos(n.cobros.otro_centavos)]) && renglonConValores(txN, "Total cobrado", [pesos(n.cobros.total_centavos)]) &&
    renglonConValores(txN, "Por cobrar", [pesos(n.cobros.por_cobrar_centavos)]));
  revisar("PDF noche: comisiones (por reserva, por día, total)",
    renglonConValores(txN, "Comisiones por reserva", [pesos(n.comisiones.comision_centavos)]) && renglonConValores(txN, "Pagos por día", [pesos(n.comisiones.pago_dia_centavos)]) &&
    renglonConValores(txN, "Total de comisiones", [pesos(n.comisiones.total_centavos)]));
  revisar(`PDF noche: ${n.rps.length} RPs, cada renglón = base (reservas, llegaron, consumieron, consumo, comisión)`,
    n.rps.length > 0 && n.rps.every((r) => renglonConValores(txN, r.rp_nombre, [entero(r.reservas), entero(r.entraron), entero(r.consumieron), pesos(r.consumo_centavos), pesos(r.comisiones_centavos)])),
    n.rps.filter((r) => !renglonConValores(txN, r.rp_nombre, [entero(r.reservas), entero(r.entraron), entero(r.consumieron), pesos(r.consumo_centavos), pesos(r.comisiones_centavos)])).map((r) => r.rp_nombre).join(", "));
  revisar("PDF noche: definición del ticket impresa", txN.replace(/\s+/g, " ").includes("Ticket promedio = consumo total ÷ cuentas con consumo, redondeado al centavo."));
  revisar("PDF noche: pie con la fuente de las cifras y «Página 1 de»", /Fuente: AntroApp, cierre de la noche/.test(txN) && /Página 1 de \d/.test(txN));
  revisar("PDF noche: acentos y signos (Comisión, Definiciones, día, ÷; el − sale como guion)", ["Comisión", "Definiciones", "Pagos por día", "÷", "consumo - cobrado"].every((s) => txN.includes(s)));
  revisar("PDF noche: anulaciones = base (consumos, cobros, mesas reabiertas)",
    renglonConValores(txN, "Consumos anulados", [entero(n.anulaciones.consumos), pesos(n.anulaciones.consumos_centavos)]) &&
    renglonConValores(txN, "Cobros anulados", [entero(n.anulaciones.cobros), pesos(n.anulaciones.cobros_centavos)]) &&
    renglonConValores(txN, "Mesas reabiertas", [entero(n.anulaciones.mesas_reabiertas)]));
  revisar(`PDF noche: cuadre según la base (${n.cuadre ? "con cuadre" : "sin cuadre"})`,
    n.cuadre ? txN.includes("Diferencia del cuadre") && txN.includes(n.cuadre.diferencia_centavos === 0 ? "Cuadra" : pesos(Math.abs(n.cuadre.diferencia_centavos)))
             : txN.includes("Sin cuadre general"));
  revisar("PDF noche: el pie dice cuadre y anulaciones (y ahora sí vienen)", txN.replace(/\s+/g, " ").includes("cobros, cuadre, anulaciones y comisiones") && txN.includes("Anulaciones"));
  revisar(`PDF noche: aviso correcto según su estado (termino=${n.termino}, caja ${n.noche.estado})`,
    n.termino ? (n.noche.estado === "abierta" ? txN.includes("sigue abierta") : !txN.includes("Noche en curso")) : txN.includes("Noche en curso"));

  // Semana cerrada.
  await abrirReporte(pd, "semana", W1);
  const tW = await textoDe(pd);
  const w = datos.w1;
  revisar(`pantalla semana ${W1}: consumo, ticket, cobrado y comisiones = base`,
    [w.totales.consumo_centavos, w.totales.ticket_promedio_centavos, w.totales.cobrado_centavos, w.totales.comisiones_centavos].every((c) => tW.includes(pesos(c))));
  revisar("pantalla semana 390: sin scroll horizontal", await sinScroll(pd));
  await pd.screenshot({ path: SHOTS + `reporte-semana-390.png`, fullPage: true });
  const pdfW = await descargar(pd, `reporte-semana-${W1}.pdf`);
  revisar(`PDF semana: nombre de archivo (${pdfW.sugerido})`, pdfW.sugerido === `reporte-semana-club-demo-dev-${W1}.pdf`);
  const txW = pdfATexto(pdfW.ruta);
  writeFileSync(SHOTS + `reporte-semana-${W1}.txt`, txW);
  revisar(`PDF semana: título y semana ISO ${w.semana_iso.semana}`, txW.includes("Reporte de la semana") && txW.includes(`Semana ${w.semana_iso.semana} de ${w.semana_iso.anio}`));
  revisar("PDF semana: cada noche en su renglón = base (reservas, llegaron, cuentas, consumo, ticket, cobrado, comisiones)",
    w.noches.every((x) => renglonConValores(txW, fechaCorta(x.fecha), [entero(x.reservas), entero(x.entraron), entero(x.cuentas), pesos(x.consumo_centavos), pesos(x.ticket_promedio_centavos), pesos(x.cobrado_centavos), pesos(x.comisiones_centavos)])),
    w.noches.filter((x) => !renglonConValores(txW, fechaCorta(x.fecha), [entero(x.reservas), entero(x.entraron), entero(x.cuentas), pesos(x.consumo_centavos)])).map((x) => x.fecha).join(", "));
  const tt = w.totales;
  revisar("PDF semana: renglón «Semana» = totales de la base",
    renglonConValores(txW, "Semana ", [entero(tt.reservas), entero(tt.entraron), entero(tt.cuentas), pesos(tt.consumo_centavos), pesos(tt.ticket_promedio_centavos), pesos(tt.cobrado_centavos), pesos(tt.comisiones_centavos)]));
  revisar("PDF semana: cobrado por método y comisiones",
    renglonConValores(txW, "Efectivo", [pesos(tt.efectivo_centavos)]) && renglonConValores(txW, "Tarjeta", [pesos(tt.tarjeta_centavos)]) &&
    renglonConValores(txW, "Otro", [pesos(tt.otro_centavos)]) && renglonConValores(txW, "Total de comisiones", [pesos(tt.comisiones_centavos)]) &&
    renglonConValores(txW, "Comisiones por reserva", [pesos(tt.comision_reserva_centavos)]) && renglonConValores(txW, "Pagos por día", [pesos(tt.pago_dia_centavos)]));
  revisar(`PDF semana: ${w.rps.length} RPs = base`, w.rps.every((r) => renglonConValores(txW, r.rp_nombre, [entero(r.reservas), entero(r.entraron), entero(r.consumieron), pesos(r.consumo_centavos), pesos(r.comisiones_centavos)])));
  revisar("PDF semana: definición del ticket de la semana", txW.replace(/\s+/g, " ").includes("no es el promedio de los tickets de cada noche"));
  revisar("PDF semana: sin aviso de parcial (semana terminada)", !txW.includes("Semana en curso"));
  revisar("PDF semana: anulaciones y cuadres = base",
    renglonConValores(txW, "Consumos anulados", [entero(tt.consumos_anulados), pesos(tt.consumos_anulados_centavos)]) &&
    renglonConValores(txW, "Cobros anulados", [entero(tt.cobros_anulados), pesos(tt.cobros_anulados_centavos)]) &&
    renglonConValores(txW, "Mesas reabiertas", [entero(tt.mesas_reabiertas)]) &&
    renglonConValores(txW, "Noches cerradas con cuadre", [`${entero(tt.noches_con_cuadre)} de 7`]) &&
    (tt.noches_con_cuadre === 0 || renglonConValores(txW, "Diferencia de los cuadres", [tt.diferencia_centavos === 0 ? "Cuadra" : pesos(Math.abs(tt.diferencia_centavos))])));

  // Noche cerrada en caja: su cuadre completo en el PDF.
  const [cerradaConCuadre] = await db.q(
    `select n.fecha_operacion::text f from public.caja_noches n where n.club_id = $1 and n.estado = 'cerrada'
       and exists (select 1 from public.caja_cuadres q where q.noche_id = n.id and q.tipo = 'noche') order by 1 desc limit 1`, [CLUB]);
  if (cerradaConCuadre) {
    const F = cerradaConCuadre.f;
    const cq = ok(await D.rpc("reporte_cierre_noche", { p_club_id: CLUB, p_fecha: F }), "cierre cerrada");
    await abrirReporte(pd, "noche", F);
    const txC = pdfATexto((await descargar(pd, `reporte-noche-cerrada-${F}.pdf`)).ruta);
    const q = cq.cuadre;
    revisar(`PDF noche cerrada ${F}: cobrado y contado por método = cuadre de la base`,
      renglonConValores(txC, "Efectivo", [pesos(cq.cobros.efectivo_centavos), pesos(q.contado_efectivo_centavos)]) &&
      renglonConValores(txC, "Tarjeta", [pesos(cq.cobros.tarjeta_centavos), pesos(q.contado_tarjeta_centavos)]) &&
      renglonConValores(txC, "Otro", [pesos(cq.cobros.otro_centavos), pesos(q.contado_otro_centavos)]));
    revisar(`PDF noche cerrada ${F}: diferencia ${q.diferencia_centavos === 0 ? "Cuadra" : pesos(q.diferencia_centavos)}`,
      renglonConValores(txC, "Diferencia del cuadre", [q.diferencia_centavos === 0 ? "Cuadra" : (q.diferencia_centavos > 0 ? "Sobran " : "Faltan ") + pesos(Math.abs(q.diferencia_centavos))]));
    revisar(`PDF noche cerrada ${F}: registrado y saldo del cuadre`, txC.replace(/\s+/g, " ").includes(`registrado en caja ${pesos(q.registrado_centavos)} · saldo sin cobrar al cerrar ${pesos(q.saldo_sin_cobrar_centavos)}`));
    revisar(`PDF noche cerrada ${F}: anulaciones = base`, renglonConValores(txC, "Consumos anulados", [entero(cq.anulaciones.consumos), pesos(cq.anulaciones.consumos_centavos)]));
  } else revisar("hay una noche cerrada con cuadre para probar", false);

  // Semana en curso (parcial), noche en curso y noche vacía.
  await abrirReporte(pd, "semana", W2);
  revisar("pantalla semana en curso: aviso de parcial", /Semana en curso/.test(await textoDe(pd)));
  const txW2 = pdfATexto((await descargar(pd, `reporte-semana-${W2}.pdf`)).ruta);
  revisar("PDF semana en curso: aviso de parcial y noches «en curso» o «todavía no empieza»", txW2.includes("Semana en curso") && /en curso \(parcial\)|todavía no empieza/.test(txW2));
  revisar("PDF semana en curso: consumo = base", txW2.includes(pesos(datos.w2.totales.consumo_centavos)));
  await abrirReporte(pd, "noche", hoy);
  const txHoy = pdfATexto((await descargar(pd, `reporte-noche-${hoy}.pdf`)).ruta);
  revisar(`PDF noche en curso (${hoy}): aviso de cifras parciales`, txHoy.includes("Noche en curso"));
  if (vacia) {
    await abrirReporte(pd, "noche", vacia);
    revisar(`pantalla noche vacía (${vacia}): «Sin movimientos»`, /Sin movimientos/.test(await textoDe(pd)));
    await pd.screenshot({ path: SHOTS + `reporte-noche-vacia-390.png`, fullPage: true });
    const txV = pdfATexto((await descargar(pd, `reporte-noche-vacia-${vacia}.pdf`)).ruta);
    revisar("PDF noche vacía: «Sin movimientos» y definiciones", txV.includes("Sin movimientos") && txV.includes("Definiciones"));
  } else revisar("hay una noche vacía en los últimos 30 días para probar", false);

  // Entrega en «teléfono» (pantalla táctil) con navigator.share simulado.
  {
    const ctxM = await navegador.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
    await ctxM.addInitScript(() => {
      window.__compartidos = [];
      window.__modo = "ok";
      Object.defineProperty(Navigator.prototype, "canShare", { configurable: true, writable: true, value: (d) => window.__modo !== "nocomparte" && !!d?.files?.length });
      Object.defineProperty(Navigator.prototype, "share", { configurable: true, writable: true, value: async (d) => {
        if (window.__modo === "cancela") throw new DOMException("cancelado", "AbortError");
        const f = d.files[0];
        const b = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (const x of b) bin += String.fromCharCode(x);
        window.__compartidos.push({ nombre: f.name, tipo: f.type, b64: btoa(bin), titulo: d.title });
      } });
    });
    const pm = await ctxM.newPage();
    for (let intento = 1; intento <= 4; intento++) {
      await pm.goto(BASE + "/cliente/login");
      await pm.fill("#email", cred.usuarios.dueno);
      await pm.fill("#password", cred.password);
      await pm.click("button[type=submit]");
      if (await pm.waitForURL(/dueno\/panel/, { timeout: 90000 }).then(() => true).catch(() => false)) break;
      await espera(3000 * intento);
    }
    await abrirReporte(pm, "noche", N);
    let descargo = false;
    pm.on("download", () => { descargo = true; });
    await pm.getByRole("button", { name: "Descargar PDF" }).click();
    await pm.getByText("Se generó el PDF.", { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    const comp = await pm.evaluate(() => window.__compartidos);
    revisar("teléfono: usa la hoja de compartir con UN archivo PDF (sin descarga)", comp.length === 1 && comp[0].tipo === "application/pdf" && !descargo, JSON.stringify(comp.map((c) => c.nombre)));
    if (comp[0]) {
      const ruta = path.join(SHOTS, "compartido-" + comp[0].nombre);
      writeFileSync(ruta, Buffer.from(comp[0].b64, "base64"));
      const txS = pdfATexto(ruta);
      revisar(`teléfono: el archivo compartido (${comp[0].nombre}) es el reporte con las cifras de la base`,
        comp[0].nombre === `reporte-noche-club-demo-dev-${N}.pdf` && txS.includes(pesos(n.consumo.total_centavos)) && txS.includes("Reporte de la noche"));
    }
    revisar("teléfono: mensaje «Se generó el PDF.»", (await pm.getByText("Se generó el PDF.", { exact: true }).count()) === 1);
    await pm.evaluate(() => { window.__modo = "cancela"; });
    await pm.getByRole("button", { name: "Descargar PDF" }).click();
    revisar("teléfono: si cancela la hoja de compartir, lo dice", await pm.getByText("Se generó el PDF, pero no se guardó ni se compartió.").waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
    await pm.evaluate(() => { window.__modo = "nocomparte"; });
    const [dM] = await Promise.all([pm.waitForEvent("download", { timeout: 20000 }).catch(() => null), pm.getByRole("button", { name: "Descargar PDF" }).click()]);
    revisar("teléfono sin compartir archivos: descarga normal y lo dice", !!dM && (await pm.getByText("Se generó el PDF. Si no lo ves, revisa tus descargas.").waitFor({ timeout: 15000 }).then(() => true).catch(() => false)));
    await ctxM.close();
  }
  // Computadora: no usa compartir aunque exista; sin <a download>, abre en otra pestaña.
  revisar("computadora: mensaje de descarga (sin «Listo: se descargó»)", (await textoDe(pd)).includes("Se generó el PDF. Si no lo ves, revisa tus descargas.") && !(await textoDe(pd)).includes("Listo"));
  await pd.evaluate(() => {
    window.__abiertos = [];
    delete HTMLAnchorElement.prototype.download;
    window.open = (u) => { window.__abiertos.push(String(u)); return {}; };
  });
  await pd.getByRole("button", { name: "Descargar PDF" }).click();
  revisar("navegador sin descarga: abre el PDF (blob) en otra pestaña y lo dice",
    await pd.getByText("Se generó el PDF y se abrió en otra pestaña.").waitFor({ timeout: 15000 }).then(() => true).catch(() => false) &&
    (await pd.evaluate(() => window.__abiertos)).some((u) => u.startsWith("blob:")));
  await pd.reload();

  // Dueño de grupo: elegir Tijuana.
  await abrirReporte(pd, "noche", N);
  await pd.selectOption("#pdf-antro", TIJUANA);
  await pd.waitForFunction((id) => location.search.includes(id), TIJUANA, { timeout: 30000 }).catch(() => {});
  await pd.waitForTimeout(1500);
  revisar("dueño de grupo: elige Tijuana y carga su reporte", (await textoDe(pd)).includes("Club Demo Dev Tijuana") && (await pd.locator("p[role=alert]").count()) === 0);

  // 360 px.
  await pd.setViewportSize({ width: 360, height: 740 });
  for (const [tipo, fecha] of [["noche", N], ["semana", W1]]) {
    await abrirReporte(pd, tipo, fecha);
    revisar(`360: ${tipo} sin scroll horizontal`, await sinScroll(pd));
    const bajos = await pd.evaluate(() => [...document.querySelectorAll("button, a, select, input")]
      .filter((e) => e.offsetParent !== null)
      .map((e) => [e.textContent?.trim().slice(0, 24) || e.getAttribute("aria-label") || e.tagName, Math.round(e.getBoundingClientRect().height)])
      .filter(([, h]) => h < 40));
    revisar(`360: ${tipo} controles de al menos 40 px`, bajos.length === 0, JSON.stringify(bajos));
    await pd.screenshot({ path: SHOTS + `reporte-${tipo}-360.png`, fullPage: true });
  }
  revisar("dueño: sin errores en consola", erroresDueno.length === 0, erroresDueno.join(" | "));

  // Gerente y staff.
  const { p: pg } = await pantalla("gerente", /staff\/panel/);
  await abrirReporte(pg, "noche", N);
  revisar("gerente: ve el reporte de su antro con las cifras de la base", (await textoDe(pg)).includes(pesos(n.consumo.total_centavos)));
  const { p: ps } = await pantalla("staff", /staff\/panel/);
  await ps.goto(`${BASE}/grupo/reportes?club=${CLUB}`);
  revisar("staff: «son para dueños y gerentes», sin cifras", await ps.getByText("Los reportes PDF son para dueños y gerentes.").waitFor({ timeout: 60000 }).then(() => true).catch(() => false));
  await ps.screenshot({ path: SHOTS + "staff-sin-acceso-390.png" });

  // Bandera apagada: sin enlaces y pantalla sin reporte.
  await bandera(CLUB, false);
  await bandera(TIJUANA, false);
  await pd.setViewportSize({ width: 390, height: 844 });
  await pd.goto(BASE + "/dueno/panel");
  await pd.getByRole("heading", { name: "Panel de tu antro" }).waitFor({ timeout: 90000 });
  await pd.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await pd.waitForTimeout(1500);
  revisar("apagada: el panel del dueño NO muestra «Reportes PDF»", (await pd.getByRole("link", { name: /Reportes PDF/ }).count()) === 0);
  await pd.screenshot({ path: SHOTS + "panel-dueno-apagada-390.png" });
  await pd.goto(BASE + "/grupo");
  await pd.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await pd.waitForTimeout(2000);
  revisar("apagada: /grupo NO muestra «Reportes PDF»", (await pd.getByRole("link", { name: /Reportes PDF/ }).count()) === 0);
  await pd.goto(`${BASE}/grupo/reportes?club=${CLUB}&tipo=noche&fecha=${N}`);
  revisar("apagada: /grupo/reportes dice «no están activos»", await pd.getByText("Los reportes PDF no están activos para tus antros.").waitFor({ timeout: 60000 }).then(() => true).catch(() => false));
  await pd.screenshot({ path: SHOTS + "reportes-apagada-390.png" });

  // Las hojas del PDF dibujadas (pdf.js desde cdnjs, solo para verlas).
  try {
    const ctx = await navegador.newContext({ viewport: { width: 900, height: 1200 } });
    const p = await ctx.newPage();
    await p.setContent("<!doctype html><html><body style='margin:0;background:#888'></body></html>");
    await p.addScriptTag({ url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" });
    for (const [nombre, archivo] of [["noche", pdfN.ruta], ["semana", pdfW.ruta]]) {
      const b64 = readFileSync(archivo).toString("base64");
      const hojas = await p.evaluate(async (datos) => {
        const lib = window.pdfjsLib;
        lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        document.body.innerHTML = "";
        const doc = await lib.getDocument({ data: Uint8Array.from(atob(datos), (c) => c.charCodeAt(0)) }).promise;
        for (let i = 1; i <= doc.numPages; i++) {
          const hoja = await doc.getPage(i);
          const vista = hoja.getViewport({ scale: 1.4 });
          const lienzo = document.createElement("canvas");
          lienzo.width = vista.width;
          lienzo.height = vista.height;
          lienzo.style.display = "block";
          lienzo.style.margin = "8px";
          document.body.appendChild(lienzo);
          await hoja.render({ canvasContext: lienzo.getContext("2d"), viewport: vista }).promise;
        }
        return doc.numPages;
      }, b64);
      await p.screenshot({ path: SHOTS + `pdf-${nombre}-hojas.png`, fullPage: true });
      revisar(`pdf.js abre el PDF de la ${nombre} (${hojas} hojas)`, hojas >= 1);
    }
    await ctx.close();
  } catch (e) {
    console.log(`  (no se pudo dibujar el PDF con pdf.js: ${e.message.slice(0, 120)}; pdftotext sí lo leyó)`);
  }
} catch (e) {
  revisar(`la prueba terminó sin excepción`, false, e.stack ?? e.message);
} finally {
  if (navegador) await navegador.close().catch(() => {});
  try {
    await restaurarBanderas();
  } catch (e) {
    revisar("restaurar la bandera", false, e.message);
  }
  await limpiar().catch((e) => revisar("limpieza", false, e.message));
  await db.fin();
  console.log(`\nResumen de cifras: ${JSON.stringify(resumen)}`);
  console.log(`${pasan} pasan, ${fallan} fallan${fallas.length ? "\nFallas: " + fallas.join(" | ") : ""}`);
  process.exit(fallan ? 1 : 0);
}
