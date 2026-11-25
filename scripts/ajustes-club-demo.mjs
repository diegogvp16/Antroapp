// Ajustes de Club Demo en PRODUCCIÓN después del pase (24/11/2026).
//
//   node scripts/ajustes-club-demo.mjs                 simula: dice qué haría, no escribe
//   node scripts/ajustes-club-demo.mjs --si            aplica
//   node scripts/ajustes-club-demo.mjs --rollback      simula el rollback
//   node scripts/ajustes-club-demo.mjs --rollback --si aplica el rollback
//   ... --dev   lo mismo contra antroapp-dev (.env.dev), sobre "Antro Borrador Dev",
//               para probar el ciclo completo antes de producción
//
// Qué hace (todo ficticio, correos @example.com):
//   a) Cuentas demo para recorrer los 6 roles: admin, cliente, staff y
//      gerente de Club Demo (el RP ya existe: demo_mariana). Ojo: staff.demo
//      es además el staff que necesita demo-datos.mjs (demo-caja.mjs exige un
//      staff y un gerente en Club Demo).
//   b) Ficha de Club Demo: música, vestimenta, edad mínima y horario con
//      miércoles.
//   c) "Club Demo Tijuana" (oculto: borrador, sin suscripción, zona
//      America/Tijuana, 10 mesas), su gerente demo, y un dueño de grupo demo
//      (dueño de Tijuana) con un grupo que junta Club Demo y Club Demo Tijuana.
//
// Cada cuenta tiene su propia contraseña aleatoria. Contraseñas e ids se
// guardan SOLO en backups/2026-11-24-prod-cuentas-demo.json (backups/ está en
// .gitignore). Nunca se imprimen.
//
// El rollback trabaja objeto por objeto y solo sobre lo que creó este script
// (ids del archivo o, si una respuesta se perdió, cuentas con la marca
// creado_por del script; siempre comprueba correo y nombre):
//   - lo que nada más usa, se borra;
//   - una cuenta a la que ya apuntan caja, reservas, asistencias… (por
//     ejemplo staff.demo después de demo-datos: la caja no se borra) se
//     DESACTIVA (activo = false y bloqueo de inicio de sesión) en vez de
//     borrarse;
//   - un antro o grupo con datos ajenos se deja y se reporta.
// La ficha vuelve a como estaba solo si nadie la cambió después.
import { createRequire } from "node:module";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(path.join(RAIZ, "package.json"));
const { createClient } = req("@supabase/supabase-js");

const SI = process.argv.includes("--si");
const ROLLBACK = process.argv.includes("--rollback");
const DEV = process.argv.includes("--dev");
const REF_PROD = "kigltjvakwuuulvzbyri";
const REF_DEV = "ygumrpckbtlngzspqdvo";
const REF = DEV ? REF_DEV : REF_PROD;
const CLUB_DEMO = DEV ? "0de70000-0000-4000-8000-000000000002" : "d2f531df-8116-442e-b967-4a1004fcd02e";
const NOMBRE_CLUB_DEMO = DEV ? "Antro Borrador Dev" : "Club Demo";
const ARCHIVO = path.join(RAIZ, DEV ? "backups/dev-2026-11-24-prueba-ajustes-club-demo.json" : "backups/2026-11-24-prod-cuentas-demo.json");
const MARCA = "ajustes-club-demo-2026-11-24";
const NOMBRE_TJ = "Club Demo Tijuana";
const NOMBRE_GRUPO = "Grupo Club Demo";

// Cuentas que crea el script. La clave es la del archivo de backups/.
const CUENTAS = [
  { clave: "admin", email: "admin.demo@example.com", nombre: "Admin Demo", role: "admin", club: null },
  { clave: "cliente", email: "cliente.demo@example.com", nombre: "Cliente Demo", role: "cliente", club: null },
  { clave: "staff", email: "staff.demo@example.com", nombre: "Staff Demo", role: "staff", club: "demo" },
  { clave: "gerente", email: "gerente.demo@example.com", nombre: "Gerente Demo", role: "gerente", club: "demo" },
  { clave: "dueno", email: "dueno.grupo.demo@example.com", nombre: "Dueño de Grupo Demo", role: "dueno", club: null },
  { clave: "gerente_tijuana", email: "gerente.tijuana.demo@example.com", nombre: "Gerente Tijuana Demo", role: "gerente", club: "tijuana" },
];

// b) Ficha de Club Demo.
const FICHA = {
  horario: "Mié a Sáb 9pm a 3am",
  tipo_musica: "Reggaetón, house y pop",
  codigo_vestimenta: "Casual elegante",
  edad_minima: 18,
};

const TIJUANA = {
  nombre: NOMBRE_TJ,
  ciudad: "Tijuana",
  direccion: "Dirección de demostración, Tijuana, B.C.",
  horario: "Mié a Sáb 9pm a 3am",
  deposito_monto: 100,
  ambiente: "Sucursal de demostración de AntroApp para probar el panel de grupo.",
  tipo_musica: "Reggaetón, house y pop",
  codigo_vestimenta: "Casual elegante",
  edad_minima: 18,
  estado_verificacion: "borrador",
  suscripcion_activa: false,
  zona_horaria: "America/Tijuana",
};

// ---------- Entorno: solo producción, por .env.local ----------
function leerEnv(archivo) {
  const texto = readFileSync(path.join(RAIZ, archivo), "utf8");
  return Object.fromEntries(
    texto.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
  );
}
const refDe = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).ref ?? null; } catch { return null; } };
const env = leerEnv(DEV ? ".env.dev" : ".env.local");
const otro = DEV ? REF_PROD : REF_DEV;
if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(REF) || env.NEXT_PUBLIC_SUPABASE_URL.includes(otro) || refDe(env.SUPABASE_SERVICE_ROLE_KEY ?? "") !== REF) {
  console.log(`ERROR: ${DEV ? ".env.dev" : ".env.local"} no apunta a ${DEV ? "antroapp-dev" : "producción"}. No se toca nada.`);
  process.exit(1);
}
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
// Los mensajes de error nunca llevan la contraseña: solo el texto de Supabase.
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };
const salir = (m) => { console.log("ALTO: " + m); process.exit(1); };

async function todosLosUsuarios() {
  const lista = [];
  for (let pagina = 1; ; pagina++) {
    const { data, error } = await svc.auth.admin.listUsers({ page: pagina, perPage: 1000 });
    if (error) throw new Error("listUsers: " + error.message);
    lista.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return lista;
}

const leerArchivo = () => (existsSync(ARCHIVO) ? JSON.parse(readFileSync(ARCHIVO, "utf8")) : null);
// Se guarda ANTES de cada escritura con lo que se va a crear (ids generados
// aquí): si la respuesta se pierde, el rollback igual lo encuentra.
const guardar = (estado) => writeFileSync(ARCHIVO, JSON.stringify(estado, null, 2));

// =====================================================================
if (!ROLLBACK) {
  console.log(DEV ? "[DEV antroapp-dev]" : "[PRODUCCIÓN]");
  console.log(SI ? "APLICANDO" : "SIMULACIÓN (no escribe; usa --si para aplicar)");
  if (leerArchivo()) salir(`ya existe ${path.relative(RAIZ, ARCHIVO)}: los ajustes ya se aplicaron (o quedaron a medias). Usa --rollback antes de volver a correr.`);

  // Revisiones previas: nada de esto debe existir.
  const usuarios = await todosLosUsuarios();
  const repetidos = CUENTAS.filter((c) => usuarios.some((u) => u.email?.toLowerCase() === c.email));
  if (repetidos.length) salir(`ya existen cuentas: ${repetidos.map((c) => c.email).join(", ")}`);
  const tj = ok(await svc.from("clubs").select("id").ilike("nombre", NOMBRE_TJ), "buscar Tijuana");
  if (tj.length) salir(`ya existe un antro "${NOMBRE_TJ}"`);
  const gr = ok(await svc.from("grupos").select("id").eq("nombre", NOMBRE_GRUPO), "buscar grupo");
  if (gr.length) salir(`ya existe el grupo "${NOMBRE_GRUPO}"`);
  const grupoDemo = ok(await svc.from("grupo_clubs").select("grupo_id").eq("club_id", CLUB_DEMO), "grupo de Club Demo");
  if (grupoDemo.length) salir("Club Demo ya está en un grupo");
  const demo = ok(await svc.from("clubs").select("id, nombre, " + Object.keys(FICHA).join(", ")).eq("id", CLUB_DEMO).single(), "leer Club Demo");
  if (demo.nombre !== NOMBRE_CLUB_DEMO) salir(`el antro ${CLUB_DEMO} no se llama "${NOMBRE_CLUB_DEMO}"`);
  const fichaAntes = Object.fromEntries(Object.keys(FICHA).map((k) => [k, demo[k]]));

  console.log("a) Cuentas nuevas (cada una con su contraseña):");
  for (const c of CUENTAS) console.log(`   - ${c.email} (${c.role}${c.club ? ", " + (c.club === "demo" ? "Club Demo" : NOMBRE_TJ) : ""})`);
  console.log("b) Ficha de Club Demo:");
  for (const [k, v] of Object.entries(FICHA)) console.log(`   - ${k}: ${JSON.stringify(fichaAntes[k])} -> ${JSON.stringify(v)}`);
  console.log(`c) "${NOMBRE_TJ}" oculto (borrador, sin suscripción, America/Tijuana, 10 mesas), dueño: dueno.grupo.demo; grupo "${NOMBRE_GRUPO}" = Club Demo + ${NOMBRE_TJ}, con dueno.grupo.demo como dueño de grupo.`);
  console.log("Nota: staff.demo será el staff que use demo-datos el 25/11; después de eso su rollback lo desactiva en vez de borrarlo (la caja no se borra).");
  if (!SI) { console.log("\nSimulación terminada: no se escribió nada."); process.exit(0); }

  const estado = {
    nota: `Cuentas y registros demo creados en PRODUCCIÓN por scripts/ajustes-club-demo.mjs (${MARCA}). Solo local. Rollback: node scripts/ajustes-club-demo.mjs --rollback --si`,
    cuentas: Object.fromEntries(CUENTAS.map((c) => [c.clave, { email: c.email, role: c.role, id: null, password: "Demo-" + randomBytes(15).toString("base64url") }])),
    tijuana_id: randomUUID(),
    tijuana_creado: false,
    grupo_id: randomUUID(),
    grupo_creado: false,
    mesas_tijuana: [],
    ficha_antes: fichaAntes,
    ficha_despues: FICHA,
    ficha_aplicada: false,
  };
  guardar(estado);

  async function crearCuenta(c, clubId) {
    const datos = estado.cuentas[c.clave];
    const u = ok(await svc.auth.admin.createUser({ email: c.email, password: datos.password, email_confirm: true, user_metadata: { creado_por: MARCA } }), "crear " + c.email);
    datos.id = u.user.id;
    guardar(estado);
    ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: c.nombre, role: c.role, club_id: clubId, activo: true }), "perfil " + c.email);
    console.log(`   creada ${c.email}`);
  }

  // a) Cuentas de Club Demo y sin club.
  for (const c of CUENTAS.filter((c) => c.club !== "tijuana")) await crearCuenta(c, c.club === "demo" ? CLUB_DEMO : null);

  // b) Ficha (se marca antes: el rollback compara con ficha_despues y no pisa cambios ajenos).
  estado.ficha_aplicada = true;
  guardar(estado);
  ok(await svc.from("clubs").update(FICHA).eq("id", CLUB_DEMO), "ficha Club Demo");
  console.log("   ficha de Club Demo actualizada");

  // c) Tijuana, sus mesas, su gerente, el grupo.
  estado.tijuana_creado = true;
  guardar(estado);
  const tjNuevo = ok(await svc.from("clubs").insert({ id: estado.tijuana_id, ...TIJUANA, dueno_id: estado.cuentas.dueno.id }).select("id, estado_verificacion, suscripcion_activa, zona_horaria").single(), "crear Tijuana");
  if (tjNuevo.estado_verificacion !== "borrador" || tjNuevo.suscripcion_activa || tjNuevo.zona_horaria !== "America/Tijuana")
    salir(`Tijuana quedó distinto de lo pedido: ${JSON.stringify(tjNuevo)} (correr --rollback --si)`);
  console.log(`   creado ${NOMBRE_TJ} (oculto)`);
  estado.mesas_tijuana = Array.from({ length: 10 }, () => randomUUID());
  guardar(estado);
  ok(await svc.from("club_tables").insert(estado.mesas_tijuana.map((id, i) => ({ id, club_id: estado.tijuana_id, numero: String(i + 1), capacidad: 8 }))), "mesas Tijuana");
  for (const c of CUENTAS.filter((c) => c.club === "tijuana")) await crearCuenta(c, estado.tijuana_id);
  estado.grupo_creado = true;
  guardar(estado);
  ok(await svc.from("grupos").insert({ id: estado.grupo_id, nombre: NOMBRE_GRUPO }), "grupo");
  ok(await svc.from("grupo_clubs").insert([{ grupo_id: estado.grupo_id, club_id: CLUB_DEMO }, { grupo_id: estado.grupo_id, club_id: estado.tijuana_id }]), "grupo_clubs");
  ok(await svc.from("grupo_miembros").insert({ grupo_id: estado.grupo_id, profile_id: estado.cuentas.dueno.id, rol_grupo: "dueno_grupo" }), "grupo_miembros");
  console.log(`   creado el grupo "${NOMBRE_GRUPO}"`);
  console.log(`\nListo. Contraseñas e ids en ${path.relative(RAIZ, ARCHIVO)} (no se imprimen).`);
  process.exit(0);
}

// =====================================================================
// ROLLBACK
console.log(DEV ? "[DEV antroapp-dev]" : "[PRODUCCIÓN]");
console.log(SI ? "ROLLBACK" : "SIMULACIÓN del rollback (no escribe; usa --si para aplicar)");
const estado = leerArchivo();
if (!estado) salir(`no existe ${path.relative(RAIZ, ARCHIVO)}: no hay nada que revertir.`);

const contar = async (tabla, col, valor) => {
  const r = await svc.from(tabla).select(col, { count: "exact", head: true }).eq(col, valor);
  if (r.error) throw new Error(`${tabla}.${col}: ${r.error.message}`);
  return r.count ?? 0;
};
// Llaves foráneas SIN cascada hacia profiles (catálogo de producción, 24/11/2026).
const REFS_PERFIL = [
  ["caja_consumos", "anulado_por"], ["caja_consumos", "registrado_por"], ["caja_consumos", "rp_id"],
  ["caja_cuadres", "hecho_por"], ["caja_eventos", "hecho_por"], ["caja_noches", "cerrada_por"], ["caja_noches", "abierta_por"],
  ["caja_pagos", "registrado_por"], ["caja_pagos", "anulado_por"], ["caja_permisos", "profile_id"], ["caja_permisos", "actualizado_por"],
  ["commissions", "estado_cambiado_por"], ["commissions", "pagada_por"], ["commissions", "rp_id"],
  ["mesa_cuentas", "rp_id"], ["mesa_cuentas", "creada_por"], ["mesa_sesiones", "abierta_por"], ["mesa_sesiones", "cuadrada_por"], ["mesa_sesiones", "cerrada_por"],
  ["reservations", "entrada_por"], ["reservations", "rp_id"], ["reservations", "cliente_id"], ["reservations", "en_puerta_por"],
  ["rp_attendance", "marcado_por"], ["rp_pagos_dia", "rp_id"], ["rp_pagos_dia", "pagada_por"], ["rp_pagos_dia", "estado_cambiado_por"],
];
// Filas que dependen de un club: sin cascada (bloquean) o con cascada pero que no creó el script.
const REFS_CLUB = ["caja_consumos", "caja_cuadres", "caja_eventos", "caja_noches", "caja_pagos", "caja_permisos", "mesa_cuentas", "mesa_sesiones", "reservations", "rp_pagos_dia",
  "rp_schedule", "rp_attendance", "club_photos", "verificacion_documentos", "club_dia_tarifas", "rp_comision_overrides", "rp_dia_tarifa_overrides"];

// 1) Identificar lo creado (por id del archivo o por la marca del script).
const usuarios = await todosLosUsuarios();
const cuentas = [];
for (const c of CUENTAS) {
  const idGuardado = estado.cuentas?.[c.clave]?.id;
  const u = idGuardado
    ? usuarios.find((x) => x.id === idGuardado)
    : usuarios.find((x) => x.email?.toLowerCase() === c.email && x.user_metadata?.creado_por === MARCA);
  if (!u) continue;
  if (u.email?.toLowerCase() !== c.email) salir(`el id guardado de ${c.clave} es de otro correo; no se toca nada`);
  cuentas.push({ ...c, id: u.id });
}
let tijuana = null;
if (estado.tijuana_creado && estado.tijuana_id) {
  tijuana = ok(await svc.from("clubs").select("id, nombre").eq("id", estado.tijuana_id).maybeSingle(), "leer Tijuana");
  if (tijuana && tijuana.nombre !== NOMBRE_TJ) salir(`el id guardado de Tijuana ya no se llama "${NOMBRE_TJ}"; no se toca nada`);
}
let grupo = null;
if (estado.grupo_creado && estado.grupo_id) {
  grupo = ok(await svc.from("grupos").select("id, nombre").eq("id", estado.grupo_id).maybeSingle(), "leer grupo");
  if (grupo && grupo.nombre !== NOMBRE_GRUPO) salir(`el id guardado del grupo ya no se llama "${NOMBRE_GRUPO}"; no se toca nada`);
}

// 2) Bloqueos por objeto.
const plan = { grupo: null, tijuana: null, cuentas: {} }; // valores: "borrar" | "dejar: motivo" | "desactivar: motivo"
if (grupo) {
  const motivos = [];
  const ajenosM = ok(await svc.from("grupo_miembros").select("profile_id").eq("grupo_id", grupo.id), "miembros").filter((m) => !cuentas.some((c) => c.id === m.profile_id));
  if (ajenosM.length) motivos.push(`${ajenosM.length} miembro(s) ajenos`);
  const ajenosC = ok(await svc.from("grupo_clubs").select("club_id").eq("grupo_id", grupo.id), "clubs del grupo").filter((g) => g.club_id !== CLUB_DEMO && g.club_id !== tijuana?.id);
  if (ajenosC.length) motivos.push(`${ajenosC.length} antro(s) ajenos`);
  plan.grupo = motivos.length ? "dejar: " + motivos.join(", ") : "borrar";
}
for (const c of cuentas) {
  const motivos = [];
  for (const [t, col] of REFS_PERFIL) { const n = await contar(t, col, c.id); if (n) motivos.push(`${t}.${col}=${n}`); }
  const duenoDe = ok(await svc.from("clubs").select("id").eq("dueno_id", c.id), "clubs del dueño").filter((x) => x.id !== tijuana?.id);
  if (duenoDe.length) motivos.push(`dueño de ${duenoDe.length} antro(s) ajenos`);
  const grupos = ok(await svc.from("grupo_miembros").select("grupo_id").eq("profile_id", c.id), "grupos").filter((g) => !(g.grupo_id === grupo?.id && plan.grupo === "borrar"));
  if (grupos.length) motivos.push("miembro de un grupo que se queda");
  plan.cuentas[c.clave] = motivos.length ? "desactivar: " + motivos.join(", ") : "borrar";
}
if (tijuana) {
  const motivos = [];
  for (const t of REFS_CLUB) { const n = await contar(t, "club_id", tijuana.id); if (n) motivos.push(`${t}=${n}`); }
  const mesas = ok(await svc.from("club_tables").select("id").eq("club_id", tijuana.id), "mesas Tijuana").filter((m) => !(estado.mesas_tijuana ?? []).includes(m.id));
  if (mesas.length) motivos.push(`${mesas.length} mesa(s) ajenas`);
  const gerenteTj = cuentas.find((c) => c.clave === "gerente_tijuana");
  const personal = ok(await svc.from("profiles").select("id").eq("club_id", tijuana.id), "personal Tijuana")
    .filter((p) => !(p.id === gerenteTj?.id && plan.cuentas.gerente_tijuana === "borrar"));
  if (personal.length) motivos.push(`${personal.length} cuenta(s) que se quedan ligadas al antro`);
  const otrosGrupos = ok(await svc.from("grupo_clubs").select("grupo_id").eq("club_id", tijuana.id), "grupos de Tijuana").filter((g) => !(g.grupo_id === grupo?.id && plan.grupo === "borrar"));
  if (otrosGrupos.length) motivos.push("está en un grupo que se queda");
  plan.tijuana = motivos.length ? "dejar: " + motivos.join(", ") : "borrar";
  // Si Tijuana se queda, su dueño no se borra (quedaría un antro sin dueño).
  if (plan.tijuana !== "borrar" && plan.cuentas.dueno === "borrar") plan.cuentas.dueno = "desactivar: es dueño de Tijuana, que se queda";
}

// Ficha: se regresa solo si sigue como la dejó el script.
let ficha = "nada";
if (estado.ficha_aplicada) {
  const actual = ok(await svc.from("clubs").select(Object.keys(FICHA).join(", ")).eq("id", CLUB_DEMO).single(), "ficha actual");
  const comoScript = Object.entries(estado.ficha_despues).every(([k, v]) => actual[k] === v);
  const comoAntes = Object.entries(estado.ficha_antes).every(([k, v]) => actual[k] === v);
  ficha = comoScript ? "restaurar" : comoAntes ? "ya estaba como antes" : "dejar: cambió después del script";
}

console.log("Plan:");
if (plan.grupo) console.log(`   - grupo "${NOMBRE_GRUPO}": ${plan.grupo}`);
if (plan.tijuana) console.log(`   - antro "${NOMBRE_TJ}" y sus mesas: ${plan.tijuana}`);
for (const c of cuentas) console.log(`   - ${c.email}: ${plan.cuentas[c.clave]}`);
console.log(`   - ficha de Club Demo: ${ficha}`);
if (!SI) { console.log("\nSimulación terminada: no se tocó nada."); process.exit(0); }

// 3) Aplicar, en orden de llaves foráneas.
async function quitarCuenta(c) {
  if (plan.cuentas[c.clave] === "borrar") {
    ok(await svc.auth.admin.deleteUser(c.id), "borrar " + c.email); // cascada: profiles
    console.log(`   borrada ${c.email}`);
  } else {
    ok(await svc.from("profiles").update({ activo: false }).eq("id", c.id), "desactivar " + c.email);
    ok(await svc.auth.admin.updateUserById(c.id, { ban_duration: "876000h" }), "bloquear " + c.email);
    console.log(`   desactivada ${c.email}`);
  }
}
if (plan.grupo === "borrar") { ok(await svc.from("grupos").delete().eq("id", grupo.id), "borrar grupo"); console.log("   borrado el grupo"); } // cascada: grupo_clubs, grupo_miembros
for (const c of cuentas.filter((c) => c.clave === "gerente_tijuana")) await quitarCuenta(c);
if (plan.tijuana === "borrar") { ok(await svc.from("clubs").delete().eq("id", tijuana.id), "borrar Tijuana"); console.log("   borrado Tijuana"); } // cascada: club_tables
for (const c of cuentas.filter((c) => c.clave !== "gerente_tijuana")) await quitarCuenta(c);
if (ficha === "restaurar") { ok(await svc.from("clubs").update(estado.ficha_antes).eq("id", CLUB_DEMO), "restaurar ficha"); console.log("   ficha restaurada"); }

// 4) Comprobación final y archivo.
const despues = await todosLosUsuarios();
const quedanCuentas = cuentas.filter((c) => despues.some((u) => u.id === c.id));
const pendientes = quedanCuentas.filter((c) => plan.cuentas[c.clave] === "borrar");
const tjQueda = tijuana ? ok(await svc.from("clubs").select("id").eq("id", tijuana.id), "Tijuana después").length : 0;
const grQueda = grupo ? ok(await svc.from("grupos").select("id").eq("id", grupo.id), "grupo después").length : 0;
if (pendientes.length || (plan.tijuana === "borrar" && tjQueda) || (plan.grupo === "borrar" && grQueda))
  salir(`no se borró todo lo planeado: ${pendientes.map((c) => c.email).join(", ")} ${tjQueda ? "Tijuana" : ""} ${grQueda ? "grupo" : ""}`);
if (!quedanCuentas.length && !tjQueda && !grQueda) {
  writeFileSync(ARCHIVO.replace(/\.json$/, "-revertido.json"), JSON.stringify({ ...estado, cuentas: Object.fromEntries(Object.entries(estado.cuentas).map(([k, v]) => [k, { ...v, password: "(borrada al revertir)" }])), revertido: true }, null, 2));
  unlinkSync(ARCHIVO);
  console.log("\nRollback completo: no queda nada de este script.");
} else {
  estado.rollback = { fecha: new Date().toISOString(), plan, ficha };
  guardar(estado);
  console.log(`\nRollback parcial: quedan ${quedanCuentas.length} cuenta(s) desactivadas${tjQueda ? ", Tijuana" : ""}${grQueda ? ", el grupo" : ""}. El archivo de backups/ se conserva.`);
}
