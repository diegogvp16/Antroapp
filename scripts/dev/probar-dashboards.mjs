// Quién ve qué en los números de /grupo y el rendimiento por RP, con las
// cuentas dev reales (sembrar-dev) y sesiones reales (PostgREST + RLS).
// Solo lee. Se niega a correr fuera de dev.
//
//   node scripts/dev/probar-dashboards.mjs
//
// Gerente: solo su antro. Dueño: los suyos y los de su grupo. Dueño de otro
// antro: solo el suyo. Staff, RP, cliente y anónimo: nada.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const DEMO = cred.clubs.demo;
const TIJUANA = cred.clubs.tijuana;
const BORRADOR = cred.clubs.borrador_con_dueno;

const resultados = [];
function revisar(nombre, paso, detalle = "") {
  resultados.push(paso);
  console.log(`${paso ? "PASA " : "FALLA"}  ${nombre}${detalle ? "  — " + detalle : ""}`);
}
async function sesion(clave) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
  if (!clave) return c;
  const r = await c.auth.signInWithPassword({ email: cred.usuarios[clave], password: cred.password });
  if (r.error) throw new Error(`login ${clave}: ${r.error.message}`);
  return c;
}
const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const sumar = (f, d) => { const x = new Date(f + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const RANGO = { p_desde: sumar(hoy, -30), p_hasta: sumar(hoy, 7) };

try {
  const casos = [
    ["gerente", [DEMO]],
    ["gerente_tijuana", [TIJUANA]],
    ["dueno", [DEMO, TIJUANA]], // dueña de Club Demo Dev y del grupo (incluye Tijuana)
    ["dueno_tijuana", [TIJUANA]],
    ["dueno_borrador", [BORRADOR]],
  ];
  for (const [clave, esperados] of casos) {
    const s = await sesion(clave);
    const r = await s.rpc("grupo_resumen", RANGO);
    const ids = (r.data ?? []).map((x) => x.club_id).sort();
    revisar(`${clave}: /grupo muestra exactamente sus antros`, !r.error && JSON.stringify(ids) === JSON.stringify([...esperados].sort()), r.error?.message ?? `${ids.length} antros`);
    for (const club of [DEMO, TIJUANA]) {
      const rr = await s.rpc("grupo_rendimiento_rp", { p_club_id: club, ...RANGO });
      const debe = esperados.includes(club);
      revisar(`${clave}: rendimiento por RP de ${club === DEMO ? "Club Demo Dev" : "Tijuana"} ${debe ? "sí" : "no"}`, debe ? !rr.error : !!rr.error, rr.error?.message ?? `${rr.data?.length} RPs`);
    }
  }
  for (const clave of ["staff", "rp", "cliente"]) {
    const s = await sesion(clave);
    const r = await s.rpc("grupo_resumen", RANGO);
    revisar(`${clave}: /grupo no devuelve ningún antro`, !r.error && (r.data ?? []).length === 0, r.error?.message ?? `${(r.data ?? []).length} filas`);
    const rr = await s.rpc("grupo_rendimiento_rp", { p_club_id: DEMO, ...RANGO });
    revisar(`${clave}: rendimiento por RP rechazado`, !!rr.error, rr.error?.message ?? "NO falló");
  }
  const anon = await sesion(null);
  revisar("anónimo: /grupo rechazado", !!(await anon.rpc("grupo_resumen", RANGO)).error);
  revisar("anónimo: rendimiento por RP rechazado", !!(await anon.rpc("grupo_rendimiento_rp", { p_club_id: DEMO, ...RANGO })).error);

  // Coherencia de lo que ve el gerente: suma de RPs <= antro; conversión <= entraron <= reservas - por venir.
  const g = await sesion("gerente");
  const [fila] = (await g.rpc("grupo_resumen", RANGO)).data;
  const rps = (await g.rpc("grupo_rendimiento_rp", { p_club_id: DEMO, ...RANGO })).data;
  const ocurridas = fila.reservas - fila.reservas_por_venir;
  revisar("gerente: consumieron ≤ entraron ≤ reservas ya ocurridas", fila.reservas_con_consumo <= fila.entraron && fila.entraron <= ocurridas, `${fila.reservas_con_consumo} ≤ ${fila.entraron} ≤ ${ocurridas}`);
  revisar("gerente: consumo con reserva ≤ consumo total", Number(fila.consumo_con_reserva_centavos) <= Number(fila.consumo_centavos));
  const sumaRp = rps.reduce((a, x) => a + x.reservas, 0);
  revisar("gerente: reservas de RPs ≤ reservas del antro", sumaRp <= fila.reservas, `${sumaRp} ≤ ${fila.reservas}`);
  revisar("gerente: comisiones de RPs = comisiones del antro", rps.reduce((a, x) => a + Number(x.comisiones_centavos), 0) === Number(fila.comisiones_centavos));
  revisar("gerente: el rendimiento trae RPs con datos", rps.some((x) => x.consumieron > 0), `${rps.length} RPs`);
  console.log(`\nClub Demo Dev ${RANGO.p_desde} a ${RANGO.p_hasta}: reservas ${fila.reservas} (${fila.reservas_por_venir} por venir), entraron ${fila.entraron}, consumieron ${fila.reservas_con_consumo}, consumo ${fila.consumo_centavos / 100} (con reserva ${fila.consumo_con_reserva_centavos / 100}), ticket ${fila.ticket_promedio_centavos / 100}, comisiones ${fila.comisiones_centavos / 100}`);
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.message);
}
const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length} pasan`);
if (pasan !== resultados.length) process.exitCode = 1;
