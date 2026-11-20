// Pruebas de /api/auth/login contra el servidor local de dev
// (node scripts/dev/servidor-dev.mjs, puerto 3001) y la base antroapp-dev.
//
//   node scripts/dev/probar-login.mjs [--base=http://localhost:3001]
//
// Crea un cliente y un RP inactivo de prueba, revisa:
//   1. 5 fallos del mismo correo desde la misma IP → 429.
//   2. El mismo correo desde otra IP sigue entrando (nadie deja fuera al
//      dueño de la cuenta fallando a propósito).
//   3. Un RP con activo = false recibe 403 aunque la contraseña sea buena.
//   4. Un RP que ya tenía sesión cuando lo dan de baja deja de leer sus
//      reservas y comisiones, y las funciones de su panel lo rechazan.
// y al final borra las cuentas y sus intentos de login.

import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";
// Club Demo Dev (mismo id que en sembrar-dev.mjs; no se importa porque
// importar ese archivo vuelve a sembrar la base).
const CLUB_DEMO_DEV = "0de70000-0000-4000-8000-000000000001";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const BASE = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:3001").replace(/\/$/, "");

const PASS = "Prueba-" + randomUUID();
const sufijo = randomUUID().slice(0, 8);
const correos = { cliente: `prueba_login_${sufijo}@example.com`, rp: `prueba_login_rp_${sufijo}@example.com` };
const hash = (t) => createHash("sha256").update(t).digest("hex");

let pasan = 0, fallan = 0;
function revisar(cond, texto) {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto);
}

async function login(email, password, ip) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}

const ids = [];
const reservas = [];
try {
  for (const [rol, email] of Object.entries(correos)) {
    const { data, error } = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
    if (error) throw new Error("crear " + rol + ": " + error.message);
    ids.push(data.user.id);
    const perfil = { id: data.user.id, nombre: "Prueba login " + rol, role: rol, club_id: rol === "rp" ? CLUB_DEMO_DEV : null, activo: rol !== "rp" };
    const p = await svc.from("profiles").upsert(perfil);
    if (p.error) throw new Error("perfil " + rol + ": " + p.error.message);
  }

  const ipA = "203.0.113." + (10 + Math.floor(Math.random() * 200));
  const ipB = "198.51.100." + (10 + Math.floor(Math.random() * 200));

  const bien = await login(correos.cliente, PASS, ipA);
  revisar(bien.status === 200 && bien.cuerpo.ok === true, "cliente entra con su contraseña (200)");

  for (let i = 0; i < 5; i++) {
    const r = await login(correos.cliente, "mala-" + i, ipA);
    revisar(r.status === 401, `fallo ${i + 1} desde IP A → 401`);
  }
  const bloqueado = await login(correos.cliente, PASS, ipA);
  revisar(bloqueado.status === 429, "6.º intento desde la misma IP → 429 aunque la contraseña sea buena");

  const otraIp = await login(correos.cliente, PASS, ipB);
  revisar(otraIp.status === 200, "mismo correo desde otra IP → sigue entrando (200)");

  // 4. Sesión abierta antes de la baja.
  const rpId = ids[1];
  await svc.from("profiles").update({ activo: true }).eq("id", rpId);
  const reserva = { id: randomUUID(), cliente_nombre: "Prueba login", cliente_telefono: "0000000779", club_id: CLUB_DEMO_DEV,
    source: "rp", rp_id: rpId, fecha: new Date().toISOString().slice(0, 10), personas: 2, status: "confirmada", qr_code: "antro-" + randomUUID() };
  const ins = await svc.from("reservations").insert(reserva);
  if (ins.error) throw new Error("reserva: " + ins.error.message);
  reservas.push(reserva.id);
  const sesion = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const entra = await sesion.auth.signInWithPassword({ email: correos.rp, password: PASS });
  revisar(!entra.error, "RP activo abre sesión directo con Supabase");
  const antes = await sesion.from("reservations").select("id").eq("id", reserva.id);
  revisar((antes.data ?? []).length === 1, "RP activo ve su reserva");
  await svc.from("profiles").update({ activo: false }).eq("id", rpId);
  const despues = await sesion.from("reservations").select("id").eq("id", reserva.id);
  revisar(!despues.error && (despues.data ?? []).length === 0, "RP dado de baja con sesión vieja: 0 reservas");
  const com = await sesion.from("commissions").select("id").eq("rp_id", rpId);
  revisar(!com.error && (com.data ?? []).length === 0, "RP dado de baja con sesión vieja: 0 comisiones");
  const hoy = new Date().toISOString().slice(0, 10);
  const fn = await sesion.rpc("rp_mis_reservas", { p_desde: hoy, p_hasta: hoy });
  revisar(fn.error?.message === "Tu cuenta está desactivada", "rp_mis_reservas rechaza al RP dado de baja");
  const cuota = await sesion.rpc("rp_progreso_cuota");
  revisar(cuota.error?.message === "Tu cuenta está desactivada", "rp_progreso_cuota rechaza al RP dado de baja");

  const rp = await login(correos.rp, PASS, ipB);
  revisar(rp.status === 403 && /desactivada/.test(rp.cuerpo.error ?? ""), "RP inactivo con contraseña buena → 403");
} catch (e) {
  fallan++;
  console.log("FALLA  " + e.message);
} finally {
  if (reservas.length) await svc.from("reservations").delete().in("id", reservas);
  for (const id of ids) {
    await svc.from("profiles").delete().eq("id", id);
    await svc.auth.admin.deleteUser(id);
  }
  await svc.from("login_intentos").delete().in("email_hash", Object.values(correos).map(hash));
  console.log("Cuentas de prueba borradas: " + ids.length);
}

console.log(`\nResultado: ${pasan}/${pasan + fallan} pasan`);
process.exit(fallan ? 1 : 0);
