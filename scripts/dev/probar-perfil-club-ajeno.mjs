// SOLO DEV. Prueba del hueco "perfil propio con club ajeno" (auditoría C2, 24/11/2026).
//
//   node scripts/dev/probar-perfil-club-ajeno.mjs            # espera que el hueco esté CERRADO
//   node scripts/dev/probar-perfil-club-ajeno.mjs --abierto  # documenta lo que deja hacer si está ABIERTO
//
// La política profiles_insert_propio deja que una cuenta recién registrada
// (signUp con la anon key, que es pública) cree su propio perfil con role
// 'dueno' y el club_id de CUALQUIER antro. current_club_id() toma ese
// club_id, y todas las políticas "rol dueño + club_id = current_club_id()"
// le abren el antro ajeno: reservas con nombre y teléfono, personal, mesas,
// turnos, tarifas y comisiones.
//
// Crea cuentas de prueba t_perfil_*@example.com y las borra al final.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const ABIERTO = process.argv.includes("--abierto");
const CLUB = "0de70000-0000-4000-8000-000000000001"; // Club Demo Dev (con datos de la noche demo)
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);

const resultados = [];
const nota = (texto, ok, detalle = "") => { resultados.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`); };
const creados = [];

async function cuentaSinPerfil(etiqueta) {
  const email = `t_perfil_${etiqueta}_${Date.now()}@example.com`;
  const password = "T-" + randomBytes(12).toString("base64url");
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error("crear cuenta: " + error.message);
  creados.push(data.user.id);
  const cli = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
  const s = await cli.auth.signInWithPassword({ email, password });
  if (s.error) throw new Error("login: " + s.error.message);
  return { cli, id: data.user.id };
}

try {
  // 1) Lo que hace el registro legítimo sigue funcionando (sin club_id).
  for (const role of ["cliente", "dueno"]) {
    const { cli, id } = await cuentaSinPerfil("legit_" + role);
    const r = await cli.from("profiles").insert({ id, nombre: "Prueba " + role, role });
    nota(`registro legítimo de ${role} (sin club_id) crea su perfil`, !r.error, r.error?.message ?? "");
  }

  // 2) El ataque: perfil propio con rol dueño o cliente y club ajeno.
  for (const role of ["dueno", "cliente"]) {
    const { cli, id } = await cuentaSinPerfil("ataque_" + role);
    const ins = await cli.from("profiles").insert({ id, nombre: "Ataque", role, club_id: CLUB });
    if (!ABIERTO) {
      nota(`perfil ${role} con club ajeno: rechazado`, !!ins.error, ins.error ? ins.error.code + " " + ins.error.message.slice(0, 80) : "SE CREÓ");
      continue;
    }
    console.log(`\n-- ${role} con club ajeno: insert ${ins.error ? "rechazado (" + ins.error.message + ")" : "ACEPTADO"}`);
    if (ins.error) continue;
    // Qué puede leer y hacer (sin cambiar nada de verdad).
    const reservas = await cli.from("reservations").select("id, cliente_nombre, cliente_telefono", { count: "exact" }).eq("club_id", CLUB).limit(1);
    console.log(`   reservas del antro ajeno: ${reservas.count ?? 0}${reservas.data?.[0]?.cliente_telefono ? " (con teléfono)" : ""}`);
    const personal = await cli.from("profiles").select("id", { count: "exact", head: true }).eq("club_id", CLUB);
    console.log(`   perfiles del personal: ${personal.count ?? 0}`);
    const mesas = await cli.from("club_tables").select("id", { count: "exact", head: true }).eq("club_id", CLUB);
    console.log(`   mesas: ${mesas.count ?? 0}`);
    const turnos = await cli.from("rp_schedule").select("id", { count: "exact", head: true }).eq("club_id", CLUB);
    console.log(`   turnos de RPs: ${turnos.count ?? 0}`);
    const overrides = await cli.from("rp_comision_overrides").select("rp_id", { count: "exact", head: true }).eq("club_id", CLUB);
    console.log(`   sueldos individuales de RPs: ${overrides.count ?? 0}`);
    const comisiones = await cli.from("commissions").select("id", { count: "exact", head: true });
    console.log(`   comisiones visibles: ${comisiones.count ?? 0}`);
    // Escritura: crea una mesa y la borra (prueba de escritura sin dejar rastro).
    const mesa = await cli.from("club_tables").insert({ club_id: CLUB, numero: "t-ataque", capacidad: 1 }).select("id").maybeSingle();
    console.log(`   puede crear mesas: ${mesa.data ? "SÍ" : "no (" + (mesa.error?.message ?? "") + ")"}`);
    if (mesa.data) await svc.from("club_tables").delete().eq("id", mesa.data.id);
    // Update sin cambio real (mismo valor) sobre un RP del antro: prueba el permiso de escritura.
    const { data: unRp } = await svc.from("profiles").select("id, activo").eq("club_id", CLUB).eq("role", "rp").limit(1).maybeSingle();
    if (unRp) {
      const up = await cli.from("profiles").update({ activo: unRp.activo }).eq("id", unRp.id).select("id");
      console.log(`   puede dar de baja/editar RPs del antro: ${up.data?.length ? "SÍ" : "no"}`);
    }
  }
} finally {
  for (const id of creados) await svc.auth.admin.deleteUser(id);
  console.log(`\nCuentas de prueba borradas: ${creados.length}`);
}
const pasan = resultados.filter(Boolean).length;
console.log(`Resultado: ${pasan}/${resultados.length}`);
process.exit(pasan === resultados.length ? 0 : 1);
