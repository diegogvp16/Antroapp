// SOLO DEV. Prueba de sql/post-junta-3/00-funciones-club.sql (banderas por
// antro y por grupo). Todo en UNA transacción que al final se deshace: no
// cambia las banderas de dev.
//
//   node scripts/dev/probar-funciones-club.mjs
//
// Sesiones simuladas como las de la app (rol authenticated + claims del JWT)
// para admin, dueño, gerente, staff de otro antro, cliente y una cuenta sin
// perfil; y el anónimo.
import { conectarDevEscritura } from "../db/conexion.mjs";

const DEMO = "0de70000-0000-4000-8000-000000000001";
const TIJUANA = "0de70000-0000-4000-8000-000000000004";
const BORRADOR = "0de70000-0000-4000-8000-000000000002";
const db = await conectarDevEscritura();
const res = [];
const nota = (t, ok, d = "") => { res.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`); };

const ids = Object.fromEntries((await db.q(`
  select split_part(u.email, '@', 1) as clave, u.id from auth.users u join public.profiles p on p.id = u.id
   where u.email in ('dev_admin@example.com','dev_dueno@example.com','dev_gerente@example.com',
                     'dev_staff_tijuana@example.com','dev_cliente@example.com')`)).map((r) => [r.clave, r.id]));
ids.sin_perfil = "11111111-2222-4333-8444-555555555555";
const [grupo] = await db.q(`select grupo_id from public.grupo_clubs where club_id = $1`, [TIJUANA]);

async function como(uid, fn) {
  await db.q("savepoint s");
  try {
    if (uid === "anon") {
      await db.q(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
      await db.q("set local role anon");
    } else {
      await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await db.q("set local role authenticated");
    }
    return await fn();
  } catch (e) {
    return { error: e.code ?? "?", mensaje: e.message };
  } finally {
    await db.q("rollback to savepoint s");
  }
}
// Las escrituras del admin no se deshacen hasta el final (savepoint propio).
async function comoAdminPersistente(sql, args) {
  await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ids.dev_admin, role: "authenticated" })]);
  await db.q("set local role authenticated");
  try { return await db.q(sql, args); } finally { await db.q("reset role"); }
}
const efectiva = async (club, f) => (await db.q(`select public.funcion_activa($1, $2) as a`, [club, f]))[0].a;
const lista = (r) => (Array.isArray(r) ? r.map((x) => x.f).sort().join(",") : r.error);

try {
  await db.q("begin");
  await db.q(`delete from public.club_funciones where club_id in ($1, $2, $3)`, [DEMO, TIJUANA, BORRADOR]);
  if (grupo) await db.q(`delete from public.grupo_funciones where grupo_id = $1`, [grupo.grupo_id]);

  nota("sin filas: todo apagado", !(await efectiva(DEMO, "antifraude")) && !(await efectiva(TIJUANA, "whatsapp")));

  // Admin enciende antifraude en Club Demo Dev.
  await comoAdminPersistente(`select public.funcion_cambiar($1, 'antifraude', true)`, [DEMO]);
  nota("admin enciende antifraude en un antro", await efectiva(DEMO, "antifraude"));
  nota("…solo en ese antro", !(await efectiva(TIJUANA, "antifraude")));

  // Grupo: whatsapp encendido en el grupo de Tijuana.
  if (grupo) {
    await comoAdminPersistente(`select public.grupo_funcion_cambiar($1, 'whatsapp', true)`, [grupo.grupo_id]);
    nota("encendida en el grupo: el antro la hereda", await efectiva(TIJUANA, "whatsapp"));
    nota("…un antro fuera del grupo no", !(await efectiva(DEMO, "whatsapp")));
    await comoAdminPersistente(`select public.funcion_cambiar($1, 'whatsapp', false)`, [TIJUANA]);
    nota("valor propio del antro gana al del grupo", !(await efectiva(TIJUANA, "whatsapp")));
    await comoAdminPersistente(`select public.funcion_cambiar($1, 'whatsapp', null)`, [TIJUANA]);
    nota("quitar el valor propio: vuelve a seguir al grupo", await efectiva(TIJUANA, "whatsapp"));
  } else nota("hay grupo de prueba en dev", false, "Tijuana sin grupo");

  const bit = await db.q(`select count(*)::int n from public.funciones_cambios where club_id = $1 or club_id = $2 or grupo_id = $3`, [DEMO, TIJUANA, grupo?.grupo_id ?? null]);
  nota("cada cambio queda en la bitácora", bit[0].n >= (grupo ? 4 : 1), `${bit[0].n} filas`);

  // mis_funciones según quién pregunta.
  nota("gerente del antro ve sus funciones", lista(await como(ids.dev_gerente, () => db.q(`select f from public.mis_funciones($1) f`, [DEMO]))) === "antifraude");
  nota("staff de otro antro: de un borrador ajeno, nada", lista(await como(ids.dev_staff_tijuana, () => db.q(`select f from public.mis_funciones($1) f`, [BORRADOR]))) === "");
  nota("cuenta sin perfil: nada de un borrador", lista(await como(ids.sin_perfil, () => db.q(`select f from public.mis_funciones($1) f`, [BORRADOR]))) === "");
  const anonMis = await como("anon", () => db.q(`select f from public.mis_funciones($1) f`, [DEMO]));
  nota("anónimo no puede llamar mis_funciones", anonMis.error === "42501", anonMis.error);

  // Cambiar: solo admin.
  for (const [quien, uid] of [["dueño", ids.dev_dueno], ["gerente", ids.dev_gerente], ["cliente", ids.dev_cliente], ["sin perfil", ids.sin_perfil]]) {
    const r = await como(uid, () => db.q(`select public.funcion_cambiar($1, 'lista_negra', true)`, [DEMO]));
    nota(`${quien} no puede encender una función`, r.error === "P0001", r.error);
    const g = grupo ? await como(uid, () => db.q(`select public.grupo_funcion_cambiar($1, 'lista_negra', true)`, [grupo.grupo_id])) : { error: "P0001" };
    nota(`${quien} no puede encenderla en el grupo`, g.error === "P0001", g.error);
  }
  const anonCambia = await como("anon", () => db.q(`select public.funcion_cambiar($1, 'lista_negra', true)`, [DEMO]));
  nota("anónimo no puede cambiar", anonCambia.error === "42501", anonCambia.error);
  nota("nada de eso encendió lista_negra", !(await efectiva(DEMO, "lista_negra")));

  // Validaciones del admin.
  const mala = await como(ids.dev_admin, () => db.q(`select public.funcion_cambiar($1, 'no_existe', true)`, [DEMO]));
  nota("función inexistente: rechazada con mensaje", mala.error === "P0001", mala.mensaje);
  const sinClub = await como(ids.dev_admin, () => db.q(`select public.funcion_cambiar('00000000-0000-4000-8000-000000000000', 'antifraude', true)`));
  nota("antro inexistente: rechazado con mensaje", sinClub.error === "P0001", sinClub.mensaje);

  // Tablas y funcion_activa: cerradas a la API.
  for (const t of ["club_funciones", "grupo_funciones", "funciones_cambios"]) {
    const r = await como(ids.dev_admin, () => db.q(`select count(*) from public.${t}`));
    nota(`${t}: ni el admin la lee directo (solo por funciones)`, r.error === "42501", r.error);
  }
  const fa = await como(ids.dev_gerente, () => db.q(`select public.funcion_activa($1, 'antifraude')`, [DEMO]));
  nota("funcion_activa no se llama desde la API", fa.error === "42501", fa.error);

  // Estado para el admin.
  const est = await como(ids.dev_admin, () => db.q(`select * from public.funciones_estado()`));
  const nClubs = (await db.q(`select count(*)::int n from public.clubs`))[0].n;
  nota("funciones_estado: 8 funciones por antro", Array.isArray(est) && est.length === nClubs * 8, `${est.length ?? est.error} filas`);
  const fila = Array.isArray(est) ? est.find((x) => x.club_id === DEMO && x.funcion === "antifraude") : null;
  nota("…con valor propio y efectivo", fila?.valor_club === true && fila?.efectiva === true);
  const estGer = await como(ids.dev_gerente, () => db.q(`select * from public.funciones_estado()`));
  nota("funciones_estado: el gerente no", estGer.error === "P0001", estGer.error);
} finally {
  await db.q("rollback").catch(() => {});
  await db.fin();
}
const ok = res.filter(Boolean).length;
console.log(`\nResultado: ${ok}/${res.length} (todo se deshizo)`);
process.exit(ok === res.length ? 0 : 1);
