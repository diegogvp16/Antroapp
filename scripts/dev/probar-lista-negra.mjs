// SOLO DEV. Pruebas en la base de la lista negra / no-show
// (sql/post-junta-3/40-lista-negra.sql) y de las plantillas de WhatsApp
// (sql/post-junta-3/60-whatsapp-plantillas.sql).
//
//   node scripts/dev/probar-lista-negra.mjs            # 1 y 2 (no cambia dev)
//   node scripts/dev/probar-lista-negra.mjs --rest     # + 3 (API real)
//   node scripts/dev/probar-lista-negra.mjs --carga    # + 4 (20,000 reservas sintéticas, se deshace)
//
// 1. Sesiones simuladas como las de la app (rol + claims del JWT) para admin,
//    dueño, dueño del grupo, gerente, staff, RP, otro RP del mismo antro,
//    cliente, gerente/staff/RP/dueño del otro antro, anónimo, cuenta sin
//    perfil y staff dado de baja. TODO en una transacción que al final se
//    deshace: banderas, bloqueos y reservas de prueba no quedan en dev.
// 2. Permisos como en producción (allá todo lo nuevo nace con EXECUTE/ALL
//    para anon y authenticated): en una transacción que se deshace, se
//    copian esos privilegios por defecto, se quitan y se vuelven a crear 60 y
//    40, y se revisa que anon/authenticated no ganen nada que no se probó.
// 3. (--rest) Por la API real (PostgREST) con la anon key y con sesiones
//    reales de RP y cliente: bandera encendida un momento en Club Demo Dev,
//    un bloqueo de prueba (t_n4_cli_), los tres caminos de alta rechazados y
//    la bandera de vuelta como estaba. Borra todo y revisa 0 restos.
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
registerHooks({
  resolve(esp, ctx, siguiente) {
    if (esp.startsWith("@/")) {
      const ruta = path.join(RAIZ, esp.slice(2));
      return siguiente(pathToFileURL(/\.[cm]?[jt]s$/.test(ruta) ? ruta : ruta + ".ts").href, ctx);
    }
    return siguiente(esp, ctx);
  },
});
const wa = await import(pathToFileURL(path.join(RAIZ, "lib/domain/whatsapp.ts")).href);
const ln = await import(pathToFileURL(path.join(RAIZ, "lib/domain/lista-negra.ts")).href);

const DEMO = "0de70000-0000-4000-8000-000000000001";
const TIJUANA = "0de70000-0000-4000-8000-000000000004";
const CON_REST = process.argv.includes("--rest");
const res = [];
const nota = (t, ok, d = "") => { res.push(ok); console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`); };
const db = await conectarDevEscritura();

const correos = ["dev_admin", "dev_dueno", "dev_dueno_tijuana", "dev_gerente", "dev_staff", "dev_rp", "dev_cliente",
  "dev_gerente_tijuana", "dev_staff_tijuana", "dev_rp_tijuana", "demo_mariana"];
const ids = Object.fromEntries((await db.q(
  `select split_part(u.email, '@', 1) as clave, u.id from auth.users u join public.profiles p on p.id = u.id
    where split_part(u.email, '@', 1) = any($1) and u.email like '%@example.com'`, [correos])).map((r) => [r.clave, r.id]));
for (const c of correos) if (!ids[c]) throw new Error(`falta la cuenta ${c}@example.com en dev`);
ids.sin_perfil = "11111111-2222-4333-8444-555555555555";
ids.staff_baja = randomUUID();

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
    const r = await fn();
    await db.q("release savepoint s").catch(() => {});
    return r;
  } catch (e) {
    await db.q("rollback to savepoint s").catch(() => {});
    return { error: e.code ?? "?", mensaje: e.message };
  } finally {
    await db.q("reset role").catch(() => {});
    await db.q(`select set_config('request.jwt.claims', '', true)`).catch(() => {});
  }
}
// Igual que como() pero siempre deshace (lecturas y pruebas de "no puede").
async function intento(uid, sql, args) {
  await db.q("savepoint t");
  try {
    return await como(uid, () => db.q(sql, args));
  } finally {
    await db.q("rollback to savepoint t").catch(() => {});
  }
}
const flag = (club, f, on) =>
  on === null
    ? db.q(`delete from public.club_funciones where club_id = $1 and funcion = $2`, [club, f])
    : db.q(`insert into public.club_funciones (club_id, funcion, activa) values ($1, $2, $3)
            on conflict (club_id, funcion) do update set activa = excluded.activa`, [club, f, on]);
const hoyDe = async (club) => (await db.q(`select public.club_fecha_operacion($1)::text as d`, [club]))[0].d;
const masDias = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let nQr = 0;
function reservaSql(r) {
  return [
    `insert into public.reservations (cliente_nombre, cliente_telefono, rp_id, club_id, cliente_id, source, fecha, personas, status, qr_code)
     values ($1, $2, $3, $4, $5, $6, $7, 2, 'pendiente', $8)`,
    [r.nombre ?? "T n4 cli", r.tel, r.rp ?? null, r.club, r.cliente ?? null, r.rp ? "rp" : "organica", r.fecha,
     `antro-t_n4_cli_${randomUUID()}-${++nQr}`],
  ];
}
// Sin "returning": el anónimo y el RP no tienen SELECT en reservations (como
// la app, que tampoco pide la fila de vuelta). El id se lee como postgres.
async function reservar(uid, r) {
  const [s, a] = reservaSql(r);
  const x = await como(uid, () => db.q(s, a));
  if (!Array.isArray(x)) return x;
  return db.q(`select id from public.reservations where qr_code = $1`, [a[7]]);
}
const ok = (r) => Array.isArray(r);
const err = (r) => (Array.isArray(r) ? "ok" : `${r.error}: ${r.mensaje}`);

// ============================================================================
// 1. Sesiones simuladas (todo se deshace)
// ============================================================================
async function parte1() {
  console.log("\n== 1. Base con sesiones simuladas ==");
  await db.q("begin");
  try {
    const HOY = await hoyDe(DEMO);
    const HOY_TJ = await hoyDe(TIJUANA);
    const F = (n) => masDias(HOY, n);
    // Staff dado de baja (cuenta de Auth + perfil, solo dentro de esta transacción).
    await db.q(`insert into auth.users (id, email) values ($1, $2)`, [ids.staff_baja, `t_n4_cli_baja_${ids.staff_baja.slice(0, 8)}@example.com`]);
    await db.q(`insert into public.profiles (id, nombre, role, club_id, activo) values ($1, 'T n4 cli staff baja', 'staff', $2, false)`, [ids.staff_baja, DEMO]);
    for (const c of [DEMO, TIJUANA]) for (const f of ["lista_negra", "whatsapp"]) await flag(c, f, null);

    const X = "5590000001"; // se bloquea a mano en Club Demo Dev
    const Z = "5590000002"; // acumula no-shows
    const Y = "5590000003"; // limpio

    // ---------- Bandera apagada: todo como hoy ----------
    await db.q(`insert into public.club_bloqueos (club_id, telefono, motivo) values ($1, $2, 't_n4_cli bloqueo con bandera apagada')`, [DEMO, X]);
    nota("apagada: anónimo reserva con un teléfono que tiene fila de bloqueo", ok(await reservar("anon", { club: DEMO, tel: X, fecha: F(3) })), "");
    nota("apagada: cliente con cuenta reserva igual", ok(await reservar(ids.dev_cliente, { club: DEMO, tel: X, fecha: F(3), cliente: ids.dev_cliente })));
    nota("apagada: RP reserva igual", ok(await reservar(ids.dev_rp, { club: DEMO, tel: X, fecha: F(3), rp: ids.dev_rp })));
    const offGest = await intento(ids.dev_gerente, `select * from public.lista_negra_bloqueos($1)`, [DEMO]);
    nota("apagada: la gestión responde «no está activa»", offGest.error === "P0001" && /no está activa/.test(offGest.mensaje), err(offGest));
    const offAviso = await intento(ids.dev_staff, `select public.lista_negra_aviso(null, null) as a`);
    nota("apagada: aviso sin reserva → activa false", ok(offAviso) && offAviso[0].a.activa === false);
    const offNoche = await intento(ids.dev_staff, `select * from public.clientes_noche($1, 0)`, [DEMO]);
    nota("apagadas las dos: clientes_noche responde que no está activa", offNoche.error === "P0001", err(offNoche));
    const offPl = await intento(ids.dev_gerente, `select * from public.whatsapp_plantillas($1)`, [DEMO]);
    nota("apagada whatsapp: plantillas vacías", ok(offPl) && offPl.length === 0);
    const offPlG = await intento(ids.dev_gerente, `select public.whatsapp_plantilla_guardar($1, 'confirmacion', 'Hola {nombre}')`, [DEMO]);
    nota("apagada whatsapp: no se guardan plantillas", offPlG.error === "P0001", err(offPlG));
    await db.q(`set local antroapp.borrado_pruebas = 'on'`);
    await db.q(`delete from public.club_bloqueos where club_id = $1`, [DEMO]);
    await db.q(`set local antroapp.borrado_pruebas = 'off'`);

    // ---------- Encender en los dos antros ----------
    for (const c of [DEMO, TIJUANA]) for (const f of ["lista_negra", "whatsapp"]) await flag(c, f, true);

    // Normalización igual que en el código.
    const formatos = ["5590000001", "55 9000 0001", "+52 55 9000 0001", "+52 1 55 9000 0001", "5215590000001", "(55) 9000-0001",
      "tel 55.9000.0001", "123", "044 55 9000 0001", "045 55 9000 0001", "01 55 9000 0001", "+1 212 555 1234", "+52 1 331 999 8877 1", "1".repeat(16)];
    const enBase = await db.q(`select x, public.lista_negra_tel(x) as t from unnest($1::text[]) x`, [formatos]);
    nota(`lista_negra_tel = claveTelefono en ${formatos.length} formatos`, enBase.every((r) => r.t === wa.claveTelefono(r.x)),
      enBase.map((r) => `${r.x}→${r.t}`).join(" | "));

    // ---------- Bloquear (gerente) ----------
    const b1 = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_bloquear($1, $2, null, $3, null, 'T n4 cli X') as id`, [DEMO, "55 9000 0001", "t_n4_cli Agresivo en la puerta"]));
    nota("gerente bloquea por teléfono", ok(b1), err(b1));
    const bloqueoX = ok(b1) ? b1[0].id : null;
    const dup = await intento(ids.dev_gerente, `select public.lista_negra_bloquear($1, $2, null, 'otro motivo', null)`, [DEMO, "+52 1 55 9000 0001"]);
    nota("bloquearlo otra vez (otro formato): «ya está bloqueado»", dup.error === "P0001" && /ya está bloqueado/.test(dup.mensaje), err(dup));
    const sinMotivo = await intento(ids.dev_gerente, `select public.lista_negra_bloquear($1, $2, null, ' a ', null)`, [DEMO, Y]);
    nota("sin motivo: rechazado", sinMotivo.error === "P0001", err(sinMotivo));
    const telMalo = await intento(ids.dev_gerente, `select public.lista_negra_bloquear($1, '12345', null, 'motivo válido', null)`, [DEMO]);
    nota("teléfono inválido: rechazado", telMalo.error === "P0001", err(telMalo));
    const venceMalo = await intento(ids.dev_gerente, `select public.lista_negra_bloquear($1, $2, null, 'motivo válido', 0)`, [DEMO, Y]);
    nota("vencimiento de 0 días: rechazado", venceMalo.error === "P0001", err(venceMalo));

    // ---------- Rechazo al reservar (los tres caminos) ----------
    for (const [quien, uid, extra] of [
      ["anónimo", "anon", {}],
      ["cliente con cuenta", ids.dev_cliente, { cliente: ids.dev_cliente }],
    ]) {
      for (const [i, formato] of ["5590000001", "+52 1 55 9000 0001", "55-9000-0001"].entries()) {
        const r = await reservar(uid, { club: DEMO, tel: formato, fecha: F(4 + i), ...extra });
        nota(`${quien} con teléfono bloqueado (${formato}): rechazo neutro`, r.error === "P0001" && r.mensaje === ln.MENSAJE_RECHAZO_CLIENTE, err(r));
      }
    }
    // Enumeración: una inserción que de todos modos se rechazaría (RLS)
    // responde IGUAL con un teléfono bloqueado y con uno libre: el trigger
    // es AFTER y no llega a correr.
    const invalida = async (uid, tel, extra) => {
      const [sq, a] = reservaSql({ club: DEMO, tel, fecha: F(6), ...extra });
      const r = await como(uid, () => db.q(sq.replace("'pendiente'", "'confirmada'"), a));
      return Array.isArray(r) ? "ok" : r.error;
    };
    for (const [quien, uid, extra] of [["anónimo", "anon", {}], ["cliente", ids.dev_cliente, { cliente: ids.dev_cliente }], ["RP", ids.dev_rp, { rp: ids.dev_rp }]]) {
      const bloq = await invalida(uid, X, extra);
      const libre = await invalida(uid, Y, extra);
      nota(`enumeración — ${quien}, inserción inválida: misma respuesta con teléfono bloqueado y libre (${bloq})`, bloq === libre && bloq === "42501", `${bloq} / ${libre}`);
    }
    const ajeno = await como(ids.dev_cliente, () => { const [sq, a] = reservaSql({ club: DEMO, tel: X, fecha: F(6), cliente: ids.dev_gerente }); return db.q(sq, a); });
    nota("enumeración — cliente a nombre de otra cuenta con teléfono bloqueado: RLS, no P0001", ajeno.error === "42501", err(ajeno));
    const intentosAntes = (await db.q(`select count(*)::int n from public.reserva_intentos where telefono_hash = encode(sha256(convert_to('5590000001', 'UTF8')), 'hex')`))[0].n;
    const rX = await reservar("anon", { club: DEMO, tel: X, fecha: F(6) });
    const intentosDespues = (await db.q(`select count(*)::int n from public.reserva_intentos where telefono_hash = encode(sha256(convert_to('5590000001', 'UTF8')), 'hex')`))[0].n;
    nota("un rechazo por lista negra deshace también su intento (no gasta el tope por IP: lo dice el doc)", rX.error === "P0001" && intentosAntes === intentosDespues, `${intentosAntes}→${intentosDespues}`);

    // Esquivar con dígitos de más o con otro formato.
    for (const truco of ["+52 1 55 9000 0001 1", "55 9000 0001 99", "0445590000001"]) {
      const r = await reservar("anon", { club: DEMO, tel: truco, fecha: F(7) });
      nota(`no se esquiva con «${truco}»`, r.error === "P0001", err(r));
    }

    const rpX = await reservar(ids.dev_rp, { club: DEMO, tel: "55 9000 0001", fecha: F(4), rp: ids.dev_rp });
    nota("RP con teléfono bloqueado: mensaje para RP", rpX.error === "P0001" && rpX.mensaje === ln.MENSAJE_RECHAZO_RP, err(rpX));
    nota("…ningún mensaje trae el motivo", ![rpX.mensaje].some((m) => /Agresivo|t_n4_cli/.test(m ?? "")));
    nota("anónimo con teléfono limpio: reserva", ok(await reservar("anon", { club: DEMO, tel: Y, fecha: F(4) })));
    nota("RP con teléfono limpio: reserva", ok(await reservar(ids.dev_rp, { club: DEMO, tel: Y, fecha: F(5), rp: ids.dev_rp })));

    // Cambiar el teléfono de una reserva (staff) a uno bloqueado: rechazado.
    const limpia = await reservar("anon", { club: DEMO, tel: "5590000066", fecha: F(5) });
    const upd = await como(ids.dev_staff, () => db.q(`update public.reservations set cliente_telefono = '55 9000 0001' where id = $1`, [limpia[0]?.id]));
    nota("staff cambia el teléfono de una reserva a uno bloqueado: P0001 sin motivo", upd.error === "P0001" && !/Agresivo/.test(upd.mensaje), err(upd));
    const upd2 = await como(ids.dev_staff, () => db.q(`update public.reservations set cliente_telefono = '55 9000 0067', personas = 3 where id = $1`, [limpia[0]?.id]));
    nota("…a uno libre: pasa", ok(upd2), err(upd2));
    const upd3 = await como(ids.dev_staff, () => db.q(`update public.reservations set cliente_telefono = '5590000067' where id = $1`, [limpia[0]?.id]));
    nota("…mismo teléfono con otro formato: pasa sin revisar", ok(upd3), err(upd3));

    // Aislamiento: el mismo teléfono en el otro antro.
    nota("otro antro: anónimo con el mismo teléfono reserva", ok(await reservar("anon", { club: TIJUANA, tel: X, fecha: masDias(HOY_TJ, 4) })));
    nota("otro antro: su RP con el mismo teléfono reserva", ok(await reservar(ids.dev_rp_tijuana, { club: TIJUANA, tel: X, fecha: masDias(HOY_TJ, 5), rp: ids.dev_rp_tijuana })));

    // Bloqueo por cuenta: desde una reserva de cliente con cuenta, con otro teléfono.
    const resCli = await reservar(ids.dev_cliente, { club: DEMO, tel: "5590000044", fecha: F(9), cliente: ids.dev_cliente });
    const idResCli = ok(resCli) ? resCli[0].id : null;
    const b2 = await como(ids.dev_dueno, () => db.q(`select public.lista_negra_bloquear($1, null, $2, 't_n4_cli Fraude con tarjeta', 30) as id`, [DEMO, idResCli]));
    nota("dueño bloquea desde una reserva (toma teléfono y cuenta), con 30 días", ok(b2), err(b2));
    const cliOtroTel = await reservar(ids.dev_cliente, { club: DEMO, tel: "5590000055", fecha: F(10), cliente: ids.dev_cliente });
    nota("cliente bloqueado por su cuenta, aunque cambie de teléfono: rechazo neutro", cliOtroTel.error === "P0001" && cliOtroTel.mensaje === ln.MENSAJE_RECHAZO_CLIENTE, err(cliOtroTel));
    const cliTj = await reservar(ids.dev_cliente, { club: TIJUANA, tel: "5590000055", fecha: masDias(HOY_TJ, 10), cliente: ids.dev_cliente });
    nota("…en el otro antro sí reserva", ok(cliTj), err(cliTj));

    // ---------- Quién ve y gestiona la lista ----------
    const puede = async (uid, club) => {
      const r = await intento(uid, `select * from public.lista_negra_bloqueos($1)`, [club]);
      return ok(r) ? `ve ${r.length}` : r.error;
    };
    for (const [quien, uid, esperado] of [
      ["admin", ids.dev_admin, "ve 2"], ["dueño", ids.dev_dueno, "ve 2"], ["gerente", ids.dev_gerente, "ve 2"],
      ["staff", ids.dev_staff, "P0001"], ["RP", ids.dev_rp, "P0001"], ["cliente", ids.dev_cliente, "P0001"],
      ["gerente del otro antro", ids.dev_gerente_tijuana, "P0001"], ["staff del otro antro", ids.dev_staff_tijuana, "P0001"],
      ["RP del otro antro", ids.dev_rp_tijuana, "P0001"], ["dueño del otro antro", ids.dev_dueno_tijuana, "P0001"],
      ["cuenta sin perfil", ids.sin_perfil, "P0001"], ["staff dado de baja", ids.staff_baja, "P0001"], ["anónimo", "anon", "42501"],
    ]) {
      const r = await puede(uid, DEMO);
      nota(`lista de Club Demo Dev — ${quien}: ${esperado}`, r === esperado, r);
    }
    // Dueño del grupo: dev_dueno es dueño del grupo de Tijuana.
    const bTj = await como(ids.dev_gerente_tijuana, () => db.q(`select public.lista_negra_bloquear($1, '5590000077', null, 't_n4_cli motivo de Tijuana', null) as id`, [TIJUANA]));
    nota("gerente de Tijuana bloquea en su antro", ok(bTj), err(bTj));
    nota("dueño del grupo ve la lista de un antro de su grupo", (await puede(ids.dev_dueno, TIJUANA)) === "ve 1");
    nota("dueño de Tijuana ve la suya", (await puede(ids.dev_dueno_tijuana, TIJUANA)) === "ve 1");
    nota("gerente de Club Demo Dev no ve la de Tijuana", (await puede(ids.dev_gerente, TIJUANA)) === "P0001");
    const listaDemo = await intento(ids.dev_gerente, `select * from public.lista_negra_bloqueos($1, true)`, [DEMO]);
    nota("la lista de Club Demo Dev no trae nada de Tijuana", ok(listaDemo) && !listaDemo.some((b) => /Tijuana/.test(b.motivo)));
    for (const t of ["club_bloqueos", "club_noshow_politica", "lista_negra_eventos", "club_whatsapp_plantillas", "whatsapp_plantillas_cambios"]) {
      const r = await intento(ids.dev_admin, `select count(*) from public.${t}`);
      nota(`${t}: ni el admin la lee directo`, r.error === "42501", err(r));
    }
    for (const f of ["_lista_negra_noshows($1, current_date, null)", "_lista_negra_manual($1, null, null)", "_lista_negra_auto($1, '5590000001')"]) {
      const r = await intento(ids.dev_gerente, `select * from public.${f}`, [DEMO]);
      nota(`ayudante interno ${f.split("(")[0]} cerrado a la API`, r.error === "42501", err(r));
    }
    // lista_negra_tel sí (la pide el índice): pura, solo devuelve dígitos de lo que uno manda.
    const telAnon = await intento("anon", `select public.lista_negra_tel('+52 1 55 9000 0001') as t`);
    nota("lista_negra_tel: el anónimo la puede llamar (pura) y solo normaliza", ok(telAnon) && telAnon[0].t === X, err(telAnon));

    // Teléfono enmascarado y completo a pedido (con registro).
    const fila = ok(listaDemo) ? listaDemo.find((b) => b.id === bloqueoX) : null;
    nota("lista: teléfono enmascarado ***0001", fila?.telefono_mascara === "***0001", fila?.telefono_mascara);
    const ver = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_ver_telefono($1, $2) as t`, [DEMO, bloqueoX]));
    nota("ver teléfono completo: gerente", ok(ver) && ver[0].t === X);
    const verStaff = await intento(ids.dev_staff, `select public.lista_negra_ver_telefono($1, $2) as t`, [DEMO, bloqueoX]);
    nota("ver teléfono completo: staff no", verStaff.error === "P0001");
    const verAjeno = await intento(ids.dev_gerente_tijuana, `select public.lista_negra_ver_telefono($1, $2) as t`, [TIJUANA, bloqueoX]);
    nota("ver teléfono de un bloqueo ajeno pidiéndolo por su antro: no", verAjeno.error === "P0001");

    // ---------- Nada se borra ----------
    const borrar = await (async () => { await db.q("savepoint d"); try { await db.q(`delete from public.club_bloqueos where id = $1`, [bloqueoX]); return "borró"; } catch (e) { return e.message; } finally { await db.q("rollback to savepoint d"); } })();
    nota("un bloqueo no se borra (ni como postgres)", /nada se borra/.test(borrar), borrar);
    const editar = await (async () => { await db.q("savepoint d"); try { await db.q(`update public.club_bloqueos set motivo = 'cambiado' where id = $1`, [bloqueoX]); return "editó"; } catch (e) { return e.message; } finally { await db.q("rollback to savepoint d"); } })();
    nota("el motivo de un bloqueo no se edita", /no se edita/.test(editar), editar);

    // ---------- Desbloquear ----------
    const des0 = await intento(ids.dev_gerente, `select public.lista_negra_desbloquear($1, $2, null, 'x')`, [DEMO, bloqueoX]);
    nota("desbloquear sin motivo: rechazado", des0.error === "P0001");
    const desStaff = await intento(ids.dev_staff, `select public.lista_negra_desbloquear($1, $2, null, 'Ya pagó lo que debía')`, [DEMO, bloqueoX]);
    nota("staff no desbloquea", desStaff.error === "P0001");
    const des = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_desbloquear($1, $2, null, 't_n4_cli Habló con el dueño')`, [DEMO, bloqueoX]));
    nota("gerente desbloquea con motivo", ok(des), err(des));
    nota("después del desbloqueo, anónimo reserva con ese teléfono", ok(await reservar("anon", { club: DEMO, tel: X, fecha: F(7) })));
    const hist = await intento(ids.dev_gerente, `select * from public.lista_negra_bloqueos($1, true)`, [DEMO]);
    const fx = ok(hist) ? hist.find((b) => b.id === bloqueoX) : null;
    nota("el historial conserva el bloqueo cerrado, con quién y motivo", fx?.estado === "desbloqueado" && fx?.motivo_desbloqueo === "t_n4_cli Habló con el dueño" && !!fx?.desbloqueado_por, JSON.stringify(fx?.estado));
    const activos = await intento(ids.dev_gerente, `select * from public.lista_negra_bloqueos($1)`, [DEMO]);
    nota("la lista de activos ya no lo trae", ok(activos) && !activos.some((b) => b.id === bloqueoX));

    // Vencimiento: un bloqueo con 1 día, pasado ese día.
    const bv = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_bloquear($1, $2, null, 't_n4_cli vence pronto', 1) as id`, [DEMO, Y]));
    const rv1 = await reservar("anon", { club: DEMO, tel: Y, fecha: F(8) });
    nota("bloqueo con vencimiento: mientras vale, rechaza", rv1.error === "P0001", err(rv1));
    await db.q(`set local antroapp.borrado_pruebas = 'on'`);
    await db.q(`update public.club_bloqueos set bloqueado_en = now() - interval '3 days', vence_en = now() - interval '1 day' where id = $1`, [bv[0].id]);
    await db.q(`set local antroapp.borrado_pruebas = 'off'`);
    nota("…vencido, ya deja reservar", ok(await reservar("anon", { club: DEMO, tel: Y, fecha: F(8) })));
    const rebloq = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_bloquear($1, $2, null, 't_n4_cli otra vez', null) as id`, [DEMO, Y]));
    nota("…y se puede volver a bloquear (el vencido queda en el historial)", ok(rebloq), err(rebloq));
    const hv = await intento(ids.dev_gerente, `select estado from public.lista_negra_bloqueos($1, true) where id = $2`, [DEMO, bv[0].id]);
    nota("…como «vencido»", ok(hv) && hv[0]?.estado === "vencido", JSON.stringify(hv));
    await como(ids.dev_gerente, () => db.q(`select public.lista_negra_desbloquear($1, $2, null, 't_n4_cli limpiar')`, [DEMO, rebloq[0].id]));

    // ---------- No-show: definición igual a la de hoy ----------
    // a) Con los datos demo de dev: no-shows por teléfono = reservas en
    //    «no_llego» según el mismo criterio que rp_mis_reservas.
    const desde30 = F(-30);
    const porEstado = await db.q(`
      select public.lista_negra_tel(r.cliente_telefono) as tel,
             public._clientes_estado(r.id, r.club_id, r.fecha, r.status, r.puerta_estado) as estado
        from public.reservations r where r.club_id = $1 and r.fecha between $2 and $3`, [DEMO, desde30, HOY]);
    const esperados = new Map();
    for (const r of porEstado) if (r.tel && r.estado === "no_llego") esperados.set(r.tel, (esperados.get(r.tel) ?? 0) + 1);
    const enFuncion = new Map((await db.q(`select telefono, no_shows from public._lista_negra_noshows($1, $2, null)`, [DEMO, desde30])).map((r) => [r.telefono, r.no_shows]));
    const igualesMapa = esperados.size === enFuncion.size && [...esperados].every(([k, v]) => enFuncion.get(k) === v);
    const estados = porEstado.reduce((a, r) => ((a[r.estado] = (a[r.estado] ?? 0) + 1), a), {});
    nota("no-shows de 30 noches de datos demo = reservas «No llegó»", igualesMapa && esperados.size > 0, `${esperados.size} teléfonos; estados ${JSON.stringify(estados)}`);
    // b) El estado de la base = el que ve el RP en rp_mis_reservas.
    const delRp = await como(ids.demo_mariana, () => db.q(`select reservation_id, estado from public.rp_mis_reservas($1, $2)`, [desde30, HOY]));
    let difs = 0;
    if (ok(delRp)) {
      const nuestros = new Map((await db.q(`select r.id, public._clientes_estado(r.id, r.club_id, r.fecha, r.status, r.puerta_estado) as e from public.reservations r where r.id = any($1)`, [delRp.map((x) => x.reservation_id)])).map((x) => [x.id, x.e]));
      difs = delRp.filter((x) => nuestros.get(x.reservation_id) !== x.estado).length;
    }
    nota("estado de cada reserva = rp_mis_reservas (RP demo, 30 noches)", ok(delRp) && delRp.length > 0 && difs === 0, ok(delRp) ? `${delRp.length} reservas, ${difs} distintas` : err(delRp));

    // c) Casos armados: Z con 3 no-shows en Club Demo Dev, 1 que sí entró y
    //    1 en Tijuana (no cuenta aquí).
    const insPostgres = async (club, tel, fecha, extra = "", rp = null) =>
      (await db.q(`insert into public.reservations (cliente_nombre, cliente_telefono, club_id, source, rp_id, fecha, personas, status, qr_code${extra ? ", puerta_estado, entrada_en" : ""})
                   values ('T n4 cli Z', $1, $2, $6, $7, $3, 2, $4, $5${extra ? ", 'entro', now()" : ""}) returning id`,
        [tel, club, fecha, extra ? "usada" : "pendiente", `antro-t_n4_cli_${randomUUID()}`, rp ? "rp" : "organica", rp]))[0].id;
    const zIds = [];
    for (const d of [-1, -2, -9]) zIds.push(await insPostgres(DEMO, Z, F(d), "", ids.dev_rp));
    await insPostgres(DEMO, "+52 1 55 9000 0002", F(-3), "entro");
    await insPostgres(TIJUANA, Z, masDias(HOY_TJ, -1));
    const cuentaZ = await db.q(`select no_shows, cuentan from public._lista_negra_noshows($1, $2, $3)`, [DEMO, F(-90), Z]);
    nota("Z: 3 no-shows en Club Demo Dev (la que entró y la de Tijuana no cuentan)", cuentaZ[0]?.no_shows === 3 && cuentaZ[0]?.cuentan === 3, JSON.stringify(cuentaZ));
    // W: tres reservas sin cuenta la MISMA noche con formatos distintos = 1
    // noche; y dos noches más sin cuenta: avisan, pero no cuentan para el
    // automático.
    const W = "5590000005";
    for (const t of ["5590000005", "+52 55 9000 0005", "(55) 9000-0005"]) await insPostgres(DEMO, t, F(-4));
    await insPostgres(DEMO, W, F(-5));
    await insPostgres(DEMO, W, F(-6));
    const cuentaW = await db.q(`select no_shows, cuentan from public._lista_negra_noshows($1, $2, $3)`, [DEMO, F(-90), W]);
    nota("W: 5 reservas sin cuenta en 3 noches = 3 no-shows (por noche), 0 para el automático", cuentaW[0]?.no_shows === 3 && cuentaW[0]?.cuentan === 0, JSON.stringify(cuentaW));
    const zHoy = await reservar("anon", { club: DEMO, tel: Z, fecha: HOY });
    nota("Z reserva esta noche (sin bloqueo automático por defecto)", ok(zHoy), err(zHoy));

    // Avisos sin motivo.
    const avStaff = await como(ids.dev_staff, () => db.q(`select public.lista_negra_aviso($1) as a`, [zHoy[0]?.id]));
    const a1 = ok(avStaff) ? avStaff[0].a : {};
    nota("staff: aviso de Z (3 en 90 días, desde 2) y «bloqueado» false", a1.activa && a1.no_shows === 3 && a1.aviso === true && a1.bloqueado === false, JSON.stringify(a1));
    nota("…el aviso no trae motivo ni datos de otros antros", !("motivo" in a1) && Object.keys(a1).sort().join() === "activa,aviso,bloqueado,no_shows,ventana_dias");
    const rpZ = await reservar(ids.dev_rp, { club: DEMO, tel: Z, fecha: F(1), rp: ids.dev_rp });
    const avRp = await como(ids.dev_rp, () => db.q(`select public.lista_negra_aviso($1) as a`, [rpZ[0]?.id]));
    nota("RP: aviso de SU reserva con 3 no-shows, sin «bloqueado»", ok(avRp) && avRp[0].a.no_shows === 3 && avRp[0].a.bloqueado === null, JSON.stringify(avRp[0]?.a));
    const qrZ = (await db.q(`select qr_code from public.reservations where id = $1`, [rpZ[0]?.id]))[0]?.qr_code;
    const avQr = await como(ids.dev_rp, () => db.q(`select public.lista_negra_aviso(null, $1) as a`, [qrZ]));
    nota("RP: aviso por QR de la reserva que acaba de crear", ok(avQr) && avQr[0].a.no_shows === 3);
    for (const [quien, uid] of [["otro RP del mismo antro", ids.demo_mariana], ["RP del otro antro", ids.dev_rp_tijuana], ["staff del otro antro", ids.dev_staff_tijuana], ["cliente", ids.dev_cliente], ["sin perfil", ids.sin_perfil], ["staff dado de baja", ids.staff_baja]]) {
      const r = await intento(uid, `select public.lista_negra_aviso($1) as a`, [rpZ[0]?.id]);
      nota(`aviso de una reserva ajena — ${quien}: nada`, ok(r) && r[0].a.activa === false && !("no_shows" in r[0].a), JSON.stringify(ok(r) ? r[0].a : r.error));
    }
    const avAnon = await intento("anon", `select public.lista_negra_aviso($1) as a`, [rpZ[0]?.id]);
    nota("aviso — anónimo: sin permiso", avAnon.error === "42501");

    // Política: avisar desde 2 en 30 días, bloquear desde 3.
    const pStaff = await intento(ids.dev_staff, `select public.lista_negra_politica_guardar($1, 2, 30, 3)`, [DEMO]);
    nota("staff no cambia la política", pStaff.error === "P0001");
    const pMala = await intento(ids.dev_gerente, `select public.lista_negra_politica_guardar($1, 3, 30, 2)`, [DEMO]);
    nota("bloqueo automático menor que el aviso: rechazado", pMala.error === "P0001", err(pMala));
    const pDef = await intento(ids.dev_gerente, `select public.lista_negra_politica($1) as p`, [DEMO]);
    nota("política de fábrica: 2 / 90 / sin bloqueo automático", ok(pDef) && JSON.stringify(pDef[0].p) === JSON.stringify({ propia: false, avisar_desde: 2, ventana_dias: 90, bloquear_desde: null }), JSON.stringify(pDef[0]?.p));
    const pOk = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_politica_guardar($1, 2, 30, 3)`, [DEMO]));
    nota("gerente: avisar desde 2 en 30 días, bloquear desde 3", ok(pOk), err(pOk));
    const zAuto = await reservar("anon", { club: DEMO, tel: Z, fecha: F(2) });
    nota("bloqueo automático: Z (3 no-shows) ya no reserva — rechazo neutro", zAuto.error === "P0001" && zAuto.mensaje === ln.MENSAJE_RECHAZO_CLIENTE, err(zAuto));
    const zAutoRp = await reservar(ids.dev_rp, { club: DEMO, tel: Z, fecha: F(2), rp: ids.dev_rp });
    nota("…ni con RP (mensaje de RP)", zAutoRp.error === "P0001" && zAutoRp.mensaje === ln.MENSAJE_RECHAZO_RP, err(zAutoRp));
    nota("…en el otro antro sí", ok(await reservar("anon", { club: TIJUANA, tel: Z, fecha: masDias(HOY_TJ, 2) })));
    nota("W (3 noches, todas sin cuenta) sigue reservando con el automático en 3", ok(await reservar("anon", { club: DEMO, tel: W, fecha: F(2) })));
    const nsList = await intento(ids.dev_gerente, `select * from public.lista_negra_noshows($1)`, [DEMO]);
    const nz = ok(nsList) ? nsList.find((x) => x.telefono_mascara === "***0002") : null;
    nota("lista de no-show: Z con 3, aviso y bloqueo automático", nz?.no_shows === 3 && nz?.aviso && nz?.bloqueado_auto && !nz?.bloqueado_manual, JSON.stringify(nz));
    nota("…sin teléfono completo", ok(nsList) && nsList.every((x) => /^\*\*\*\d{4}$/.test(x.telefono_mascara) && !("telefono" in x)));
    const nsStaff = await intento(ids.dev_staff, `select * from public.lista_negra_noshows($1)`, [DEMO]);
    nota("lista de no-show: staff no", nsStaff.error === "P0001");
    const avAuto = await como(ids.dev_staff, () => db.q(`select public.lista_negra_aviso($1) as a`, [zHoy[0]?.id]));
    nota("staff ve «bloqueado» true en la reserva de esta noche de Z", ok(avAuto) && avAuto[0].a.bloqueado === true);
    // Perdón: desbloquear desde la lista de no-show.
    const per = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_desbloquear($1, null, $2, 't_n4_cli Le damos otra oportunidad')`, [DEMO, nz?.ref_reserva]));
    nota("gerente quita el bloqueo automático (desde la lista de no-show)", ok(per), err(per));
    nota("…Z vuelve a reservar", ok(await reservar("anon", { club: DEMO, tel: Z, fecha: F(2) })));
    const nz2 = (await intento(ids.dev_gerente, `select * from public.lista_negra_noshows($1)`, [DEMO])).find?.((x) => x.telefono_mascara === "***0002");
    nota("…sigue mostrando sus 3 no-shows, pero ya no cuentan para el automático", nz2?.no_shows === 3 && nz2?.cuentan === 0 && nz2?.bloqueado_auto === false, JSON.stringify(nz2));
    const perdonEv = await db.q(`select detalle ->> 'perdona_hasta' as h from public.lista_negra_eventos where club_id = $1 and tipo = 'desbloqueo' and telefono = $2 order by id desc limit 1`, [DEMO, Z]);
    nota("el desbloqueo guarda hasta qué noche perdona (la última terminada)", perdonEv[0]?.h === F(-1) || perdonEv[0]?.h === HOY, perdonEv[0]?.h);
    const noHay = await intento(ids.dev_gerente, `select public.lista_negra_desbloquear($1, null, $2, 'motivo de prueba')`, [DEMO, nz?.ref_reserva]);
    nota("desbloquear a quien no está bloqueado: «no está bloqueado»", noHay.error === "P0001" && /no está bloqueado/.test(noHay.mensaje), err(noHay));

    // Noche de hoy con caja cerrada: la reserva de hoy de Z ya cuenta.
    const nocheHoy = await db.q(`select estado from public.caja_noches where club_id = $1 and fecha_operacion = $2`, [DEMO, HOY]);
    if (nocheHoy.length === 0) {
      await db.q(`insert into public.caja_noches (club_id, fecha_operacion, estado, cerrada_en) values ($1, $2, 'cerrada', now())`, [DEMO, HOY]);
      const c2 = await db.q(`select no_shows from public._lista_negra_noshows($1, $2, $3)`, [DEMO, F(-90), Z]);
      nota("con la caja de esta noche cerrada, la reserva de hoy sin entrar ya es no-show", c2[0]?.no_shows === 4, JSON.stringify(c2));
      // K=1: Q no llegó HOY (reserva de RP) y la caja ya cerró. Desbloquear
      // tiene que perdonar esa noche (antes contaba "desde la noche del
      // desbloqueo" y con K=1 no servía).
      const Q = "5590000008";
      await insPostgres(DEMO, Q, HOY, "", ids.dev_rp);
      await como(ids.dev_gerente, () => db.q(`select public.lista_negra_politica_guardar($1, 1, 30, 1)`, [DEMO]));
      const q1 = await reservar("anon", { club: DEMO, tel: Q, fecha: F(3) });
      nota("K=1: Q (no llegó hoy, caja cerrada) queda bloqueado en automático", q1.error === "P0001", err(q1));
      const refQ = (await db.q(`select id from public.reservations where club_id = $1 and cliente_telefono = $2 and fecha = $3`, [DEMO, Q, HOY]))[0].id;
      const dq = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_desbloquear($1, null, $2, 't_n4_cli perdón de hoy')`, [DEMO, refQ]));
      nota("…el gerente lo desbloquea (perdona hasta la noche de hoy, ya cerrada)", ok(dq), err(dq));
      nota("…y Q vuelve a reservar con K=1", ok(await reservar("anon", { club: DEMO, tel: Q, fecha: F(3) })));
      await como(ids.dev_gerente, () => db.q(`select public.lista_negra_politica_guardar($1, 2, 30, 3)`, [DEMO]));
    } else {
      nota(`caja de esta noche ya existe (${nocheHoy[0].estado}): prueba de noche cerrada omitida`, true);
    }

    // Bitácora.
    const ev = await intento(ids.dev_gerente, `select tipo, count(*)::int n from public.lista_negra_historial($1, 500) group by tipo`, [DEMO]);
    const tipos = ok(ev) ? Object.fromEntries(ev.map((e) => [e.tipo, e.n])) : {};
    nota("bitácora: bloqueos, desbloqueos, ver teléfono y política", tipos.bloqueo >= 3 && tipos.desbloqueo >= 3 && tipos.ver_telefono === 1 && tipos.politica >= 1, JSON.stringify(tipos));

    // ---------- Tachar (solo admin) ----------
    for (const [quien, uid, cod] of [["gerente", ids.dev_gerente, "P0001"], ["dueño", ids.dev_dueno, "P0001"], ["anónimo", "anon", "42501"]]) {
      const r = await intento(uid, `select public.lista_negra_tachar($1)`, [bloqueoX]);
      nota(`tachar — ${quien}: no`, r.error === cod, err(r));
    }
    const tach = await como(ids.dev_admin, () => db.q(`select public.lista_negra_tachar($1)`, [bloqueoX]));
    nota("admin tacha el motivo de un bloqueo", ok(tach), err(tach));
    const bt = (await db.q(`select motivo, motivo_desbloqueo, nombre from public.club_bloqueos where id = $1`, [bloqueoX]))[0];
    nota("…motivo y motivo de desbloqueo «[tachado]», sin nombre", bt.motivo === "[tachado]" && bt.motivo_desbloqueo === "[tachado]" && bt.nombre === null, JSON.stringify(bt));
    const evT = await db.q(`select count(*) filter (where detalle ->> 'motivo' like 't_n4_cli%')::int quedan, count(*) filter (where tipo = 'tachado')::int t from public.lista_negra_eventos where club_id = $1 and telefono = $2`, [DEMO, X]);
    nota("…en la bitácora no queda el motivo y hay un evento «tachado»", evT[0].quedan === 0 && evT[0].t === 1, JSON.stringify(evT[0]));
    const finta = await (async () => { await db.q("savepoint d"); try { await db.q(`select set_config('antroapp.tachado', 'on', true)`); await db.q(`update public.club_bloqueos set motivo = 'otro texto' where id = $1`, [bloqueoX]); return "editó"; } catch (e) { return e.message; } finally { await db.q("rollback to savepoint d"); } })();
    nota("con el permiso de tachar solo se puede poner «[tachado]»", /Solo se puede tachar/.test(finta), finta);

    const evStaff = await intento(ids.dev_staff, `select * from public.lista_negra_historial($1)`, [DEMO]);
    nota("bitácora: staff no", evStaff.error === "P0001");

    // ---------- Lista de la noche (puerta) ----------
    const noche = await como(ids.dev_staff, () => db.q(`select * from public.clientes_noche($1, 0)`, [DEMO]));
    const fz = ok(noche) ? noche.find((x) => x.reservation_id === zHoy[0]?.id) : null;
    nota("staff: lista de esta noche con no-shows y QR", ok(noche) && fz?.no_shows === 4 - (nocheHoy.length ? 1 : 0) && !!fz?.qr_code && !!fz?.cliente_telefono, JSON.stringify(fz && { ns: fz.no_shows, aviso: fz.aviso, estado: fz.estado }));
    for (const [quien, uid, cod] of [["RP", ids.dev_rp, "P0001"], ["cliente", ids.dev_cliente, "P0001"], ["staff del otro antro", ids.dev_staff_tijuana, "P0001"], ["dueño del otro antro", ids.dev_dueno_tijuana, "P0001"], ["staff dado de baja", ids.staff_baja, "P0001"], ["anónimo", "anon", "42501"]]) {
      const r = await intento(uid, `select * from public.clientes_noche($1, 0)`, [DEMO]);
      nota(`lista de la noche — ${quien}: no`, r.error === cod, err(r));
    }
    const fuera = await intento(ids.dev_staff, `select * from public.clientes_noche($1, 30)`, [DEMO]);
    nota("lista de la noche: más de 7 noches de distancia, rechazada", fuera.error === "P0001");
    await flag(DEMO, "whatsapp", false);
    const sinWa = await como(ids.dev_staff, () => db.q(`select * from public.clientes_noche($1, 0)`, [DEMO]));
    nota("sin whatsapp: la lista no trae teléfonos ni QR", ok(sinWa) && sinWa.every((x) => x.cliente_telefono === null && x.qr_code === null));
    await flag(DEMO, "whatsapp", true);
    await flag(DEMO, "lista_negra", false);
    const sinLn = await como(ids.dev_staff, () => db.q(`select * from public.clientes_noche($1, 0)`, [DEMO]));
    nota("sin lista_negra: la lista no trae no-shows", ok(sinLn) && sinLn.every((x) => x.no_shows === null && x.aviso === null && x.bloqueado === null));
    await flag(DEMO, "lista_negra", true);

    // ---------- Plantillas de WhatsApp ----------
    const g = (uid, tipo, texto) => intento(uid, `select public.whatsapp_plantilla_guardar($1, $2, $3)`, [DEMO, tipo, texto]);
    for (const [caso, texto] of [["variable desconocida", "Hola {mesa}"], ["llave suelta", "Hola {nombre"], ["doble llave", "Hola {{nombre}}"], ["más de 1000", "a".repeat(1001)], ["vacío", "   "]]) {
      const r = await g(ids.dev_gerente, "confirmacion", texto);
      const dom = wa.validarPlantilla(texto);
      nota(`plantilla con ${caso}: la base la rechaza (igual que el código)`, r.error === "P0001" && !dom.ok, err(r));
    }
    const tipoMalo = await g(ids.dev_gerente, "promocion", "Hola {nombre}");
    nota("tipo que no existe: rechazado", tipoMalo.error === "P0001");
    const TEXTO = "t_n4_cli Hola {nombre}, te esperamos en {antro} el {fecha}. QR: {enlace_boleto}";
    for (const [quien, uid] of [["staff", ids.dev_staff], ["RP", ids.dev_rp], ["gerente del otro antro", ids.dev_gerente_tijuana], ["dueño del otro antro", ids.dev_dueno_tijuana], ["cliente", ids.dev_cliente]]) {
      const r = await g(uid, "confirmacion", TEXTO);
      nota(`${quien} no cambia las plantillas`, r.error === "P0001", err(r));
    }
    const gOk = await como(ids.dev_gerente, () => db.q(`select public.whatsapp_plantilla_guardar($1, 'confirmacion', $2)`, [DEMO, TEXTO]));
    nota("gerente guarda una confirmación propia válida", ok(gOk), err(gOk));
    nota("…y el código la acepta igual", wa.validarPlantilla(TEXTO).ok);
    const dOk = await como(ids.dev_dueno, () => db.q(`select public.whatsapp_plantilla_guardar($1, 'no_show', 't_n4_cli {nombre}, te extrañamos')`, [DEMO]));
    nota("dueño guarda un aviso de no-show propio", ok(dOk), err(dOk));
    const lee = async (uid) => { const r = await intento(uid, `select tipo from public.whatsapp_plantillas($1) order by tipo`, [DEMO]); return ok(r) ? r.map((x) => x.tipo).join(",") : r.error; };
    for (const [quien, uid, esp] of [["staff", ids.dev_staff, "confirmacion,no_show"], ["RP", ids.dev_rp, "confirmacion,no_show"], ["admin", ids.dev_admin, "confirmacion,no_show"],
      ["RP del otro antro", ids.dev_rp_tijuana, ""], ["dueño del otro antro", ids.dev_dueno_tijuana, ""], ["cliente", ids.dev_cliente, ""], ["staff dado de baja", ids.staff_baja, ""], ["sin perfil", ids.sin_perfil, ""], ["anónimo", "anon", "42501"]]) {
      const r = await lee(uid);
      nota(`plantillas de Club Demo Dev — ${quien}: ${esp || "vacío"}`, r === esp, r);
    }
    const reset = await como(ids.dev_gerente, () => db.q(`select public.whatsapp_plantilla_guardar($1, 'no_show', null)`, [DEMO]));
    nota("volver al texto de fábrica (borra el propio)", ok(reset) && (await lee(ids.dev_gerente)) === "confirmacion");
    const hc = (await db.q(`select count(*)::int n from public.whatsapp_plantillas_cambios where club_id = $1`, [DEMO]))[0].n;
    nota("cada cambio de plantilla queda en la bitácora", hc === 3, `${hc}`);

    // Datos de una reserva para el mensaje.
    const wr = (uid, id) => intento(uid, `select public.whatsapp_reserva($1) as d`, [id]);
    const wrRp = await wr(ids.dev_rp, rpZ[0]?.id);
    nota("RP: datos de SU reserva para el mensaje (con teléfono y QR)", ok(wrRp) && wrRp[0].d.qr_code === qrZ && wa.normalizarTelefonoMx(wrRp[0].d.cliente_telefono) === Z, err(wrRp));
    nota("…mensaje armado con la plantilla propia y wa.me/52…", ok(wrRp) && (() => {
      const d = wrRp[0].d;
      const texto = wa.renderPlantilla(wa.plantillaEfectiva("confirmacion", { confirmacion: TEXTO }), wa.datosDeReserva({ ...d, origen: "https://x.test" }));
      const e = wa.enlaceWa(d.cliente_telefono, texto);
      return e.directo && e.href.startsWith(`https://wa.me/52${Z}?text=`) && texto.includes("https://x.test/r/" + qrZ);
    })());
    for (const [quien, uid] of [["otro RP del mismo antro", ids.demo_mariana], ["RP del otro antro", ids.dev_rp_tijuana], ["cliente", ids.dev_cliente], ["staff dado de baja", ids.staff_baja]]) {
      const r = await wr(uid, rpZ[0]?.id);
      nota(`datos de la reserva de otro — ${quien}: «no encontramos»`, r.error === "P0001" && /No encontramos/.test(r.mensaje), err(r));
    }
    nota("staff del antro: sí", ok(await wr(ids.dev_staff, rpZ[0]?.id)));

    // ---------- Apagar otra vez: todo como hoy ----------
    const bOff = await como(ids.dev_gerente, () => db.q(`select public.lista_negra_bloquear($1, $2, null, 't_n4_cli bloqueo antes de apagar', null) as id`, [DEMO, X]));
    nota("(bloqueo activo antes de apagar)", ok(bOff));
    await flag(DEMO, "lista_negra", false);
    nota("apagada otra vez: anónimo con teléfono bloqueado reserva", ok(await reservar("anon", { club: DEMO, tel: X, fecha: F(11) })));
    nota("apagada otra vez: RP también", ok(await reservar(ids.dev_rp, { club: DEMO, tel: X, fecha: F(11), rp: ids.dev_rp })));
    nota("apagada otra vez: Z (bloqueo automático) también", ok(await reservar("anon", { club: DEMO, tel: Z, fecha: F(12) })));
    const offPl2 = await intento(ids.dev_rp, `select * from public.whatsapp_plantillas($1)`, [DEMO]);
    nota("whatsapp sigue encendida: el RP lee la plantilla propia", ok(offPl2) && offPl2.length === 1);
    // La reserva con servicio (scripts) no pasa por el trigger.
    await flag(DEMO, "lista_negra", true);
    const [sSql, sArgs] = reservaSql({ club: DEMO, tel: X, fecha: F(13) });
    await db.q(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    const svc = await (async () => { await db.q("savepoint v"); try { await db.q(sSql, sArgs); return true; } catch (e) { return e.message; } finally { await db.q("rollback to savepoint v"); } })();
    await db.q(`select set_config('request.jwt.claims', '', true)`);
    nota("service role (scripts) no pasa por la lista negra", svc === true, String(svc));
  } finally {
    await db.q("rollback").catch(() => {});
  }
  const quedan = await db.q(`select (select count(*) from public.reservations where qr_code like 'antro-t_n4_cli_%')::int r,
                                    (select count(*) from public.club_bloqueos)::int b,
                                    (select count(*) from public.club_funciones where funcion in ('lista_negra','whatsapp'))::int f`);
  nota("parte 1 deshecha: 0 reservas de prueba, 0 bloqueos, banderas sin tocar", quedan[0].r === 0 && quedan[0].b === 0, JSON.stringify(quedan[0]));
}

// ============================================================================
// 2. Privilegios como en producción (todo se deshace)
// ============================================================================
async function parte2() {
  console.log("\n== 2. Privilegios como en producción ==");
  const leer = (p) => readFileSync(path.join(RAIZ, "sql/post-junta-3", p), "utf8").replace(/\r/g, "").replace(/^\s*(begin|commit);\s*$/gim, "");
  const FOTO = `
    select p.oid::regprocedure::text as objeto, 'funcion' as tipo,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth, p.prorettype = 'trigger'::regtype as trg, null::boolean as rls
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (p.proname ~ '(lista_negra|whatsapp|clientes_)')
    union all
    select c.oid::regclass::text, 'tabla',
           has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'),
           has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'), false, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname in ('club_bloqueos','club_noshow_politica','lista_negra_eventos','club_whatsapp_plantillas','whatsapp_plantillas_cambios')`;
  // Quitar y volver a crear el trigger y el índice pide un candado exclusivo
  // de reservations: con otras pistas usando dev puede chocar (deadlock o
  // espera). Se reintenta; todo se deshace igual.
  let foto = null;
  for (let intentoP = 1; intentoP <= 4 && !foto; intentoP++) {
    await db.q("begin");
    try {
      await db.q("set local lock_timeout = '15s'");
      await db.q(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role`);
      await db.q(`alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role`);
      await db.q(`alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role`);
      await db.q(leer("60-whatsapp-plantillas-rollback.sql"));
      await db.q(leer("40-lista-negra-rollback.sql"));
      await db.q(leer("40-lista-negra.sql"));
      await db.q(leer("60-whatsapp-plantillas.sql"));
      foto = await db.q(FOTO);
    } catch (e) {
      await db.q("rollback").catch(() => {});
      if (!["40P01", "55P03"].includes(e.code) || intentoP === 4) throw e;
      console.log(`  (candado ocupado por otra pista: reintento ${intentoP})`);
      await new Promise((r) => setTimeout(r, 3000 * intentoP));
    }
  }
  try {
    // lista_negra_tel: a propósito (pura, la pide el índice por expresión).
    const anonAbierto = foto.filter((f) => f.anon && !f.trg && f.objeto !== "lista_negra_tel(text)");
    nota("como en producción: anon no ejecuta ni lee nada nuevo (salvo lista_negra_tel, pura)", anonAbierto.length === 0, anonAbierto.map((f) => f.objeto).join(", "));
    const tel = foto.find((f) => f.objeto === "lista_negra_tel(text)");
    nota("lista_negra_tel: ejecutable por anon/authenticated y NO es SECURITY DEFINER",
      !!tel && tel.anon && (await db.q(`select prosecdef, provolatile from pg_proc where oid = 'public.lista_negra_tel(text)'::regprocedure`))[0].prosecdef === false);
    const publicas = ["lista_negra_tel", "lista_negra_tachar", "clientes_noche", "lista_negra_aviso", "lista_negra_bloquear", "lista_negra_bloqueos", "lista_negra_desbloquear",
      "lista_negra_historial", "lista_negra_noshows", "lista_negra_politica", "lista_negra_politica_guardar", "lista_negra_ver_telefono",
      "whatsapp_plantilla_guardar", "whatsapp_plantillas", "whatsapp_reserva"];
    const authDeMas = foto.filter((f) => f.tipo === "funcion" && f.auth && !f.trg && !publicas.includes(f.objeto.split("(")[0].replace("public.", "")));
    nota("como en producción: authenticated solo ejecuta las 15 funciones de la app", authDeMas.length === 0, authDeMas.map((f) => f.objeto).join(", "));
    const tablas = foto.filter((f) => f.tipo === "tabla");
    nota("como en producción: las 5 tablas con RLS y sin permisos para anon/authenticated", tablas.length === 5 && tablas.every((t) => t.rls && !t.anon && !t.auth), JSON.stringify(tablas.map((t) => [t.objeto, t.anon, t.auth, t.rls])));
  } finally {
    await db.q("rollback").catch(() => {});
  }
}

// ============================================================================
// 4. Carga: 20,000 reservas sintéticas en Club Demo Dev (todo se deshace)
// ============================================================================
async function parte4() {
  console.log("\n== 4. Carga (20,000 reservas, se deshace) ==");
  await db.q("begin");
  try {
    const HOY = await hoyDe(DEMO);
    await flag(DEMO, "lista_negra", true);
    await db.q(`insert into public.club_noshow_politica (club_id, avisar_desde, ventana_dias, bloquear_desde) values ($1, 2, 90, 3)
                on conflict (club_id) do update set avisar_desde = 2, ventana_dias = 90, bloquear_desde = 3`, [DEMO]);
    // 2,000 teléfonos × 10 noches pasadas, hechas por RP (cuentan para el automático).
    await db.q(`insert into public.reservations (cliente_nombre, cliente_telefono, club_id, source, rp_id, fecha, personas, status, qr_code)
                select 'T n4 cli carga', '55' || lpad((g % 2000)::text, 8, '0'), $1, 'rp', $2, $3::date - 1 - (g % 85), 2, 'pendiente',
                       'antro-t_n4_cli_carga_' || g
                  from generate_series(1, 20000) g`, [DEMO, ids.dev_rp, HOY]);
    const n = (await db.q(`select count(*)::int n from public.reservations where club_id = $1`, [DEMO]))[0].n;
    const plan = (await db.q(`explain select r.id from public.reservations r
       where r.club_id = '${DEMO}' and public.lista_negra_tel(r.cliente_telefono) = '5500000777'
         and r.fecha >= '${masDias(HOY, -90)}' and r.fecha <= '${HOY}'`)).map((x) => x["QUERY PLAN"]).join(" | ");
    nota("el conteo por teléfono usa el índice reservations_club_tel_fecha", /reservations_club_tel_fecha/.test(plan), plan.slice(0, 160));

    const medir = async (fn, veces = 15) => {
      const t = [];
      for (let i = 0; i < veces; i++) { const a = performance.now(); await fn(i); t.push(performance.now() - a); }
      t.sort((x, y) => x - y);
      return { mediana: Math.round(t[Math.floor(t.length / 2)] * 10) / 10, max: Math.round(t[t.length - 1] * 10) / 10 };
    };
    // Tiempo en el servidor (EXPLAIN ANALYZE, sin la red).
    const servidor = async (sql, args, veces) => {
      const t = [];
      for (let i = 0; i < veces; i++) {
        const r = await db.q("explain analyze " + sql, args);
        t.push(Number((/Execution Time: ([0-9.]+)/.exec(r.map((x) => x["QUERY PLAN"]).join(" ")) ?? [])[1]));
      }
      t.sort((x, y) => x - y);
      return Math.round(t[Math.floor(t.length / 2)] * 100) / 100;
    };
    const porTel = await servidor(`select * from public._lista_negra_noshows($1, $2, '5500000777')`, [DEMO, masDias(HOY, -90)], 9);
    const todoClub = await servidor(`select count(*) from public._lista_negra_noshows($1, $2, null)`, [DEMO, masDias(HOY, -90)], 3);
    nota(`conteo de un teléfono con ${n} reservas en el antro: ${porTel} ms en el servidor (todo el antro, lista del gerente: ${todoClub} ms)`, porTel < 20, JSON.stringify({ porTel, todoClub }));
    // Reserva sin cuenta con el bloqueo automático encendido (trigger completo).
    // Tiempo en el servidor (EXPLAIN ANALYZE): el del trigger y el total de la inserción.
    const tiempos = [];
    for (let i = 0; i < 15; i++) {
      const [sq, args] = reservaSql({ club: DEMO, tel: `56000007${String(10 + i).padStart(2, "0")}`, fecha: masDias(HOY, 5) });
      const r = await como("anon", () => db.q("explain analyze " + sq, args));
      if (!Array.isArray(r)) throw new Error(r.mensaje);
      const txt = r.map((x) => x["QUERY PLAN"]).join(" ");
      const trg = Number((/Trigger reservations_lista_negra: time=([0-9.]+)/.exec(txt) ?? [])[1]);
      const total = Number((/Execution Time: ([0-9.]+)/.exec(txt) ?? [])[1]);
      tiempos.push({ trg, total });
    }
    const med = (k) => { const v = tiempos.map((t) => t[k]).sort((x, y) => x - y); return Math.round(v[7] * 100) / 100; };
    nota(`reserva sin cuenta con bloqueo automático y ${n} reservas: trigger ${med("trg")} ms, inserción ${med("total")} ms (medianas en el servidor)`, med("trg") < 20, JSON.stringify(tiempos.slice(0, 3)));
    const bloqueado = await reservar("anon", { club: DEMO, tel: "5500000777", fecha: masDias(HOY, 6) });
    nota("con 20k reservas, el teléfono con 10 noches sin llegar (de RP) sí queda bloqueado", bloqueado.error === "P0001", err(bloqueado));
    const noche = await medir(() => como(ids.dev_staff, () => db.q(`select count(*) from public.clientes_noche($1, -1)`, [DEMO])), 3);
    nota(`lista de anoche (staff) con 20k reservas: mediana ${noche.mediana} ms`, noche.mediana < 2000, JSON.stringify(noche));
  } finally {
    await db.q("rollback").catch(() => {});
  }
  const q = (await db.q(`select count(*)::int n from public.reservations where qr_code like 'antro-t_n4_cli_carga_%'`))[0].n;
  nota("parte 4 deshecha: 0 reservas sintéticas", q === 0, String(q));
}

// ============================================================================
// 5. Borrar un antro con lista negra (cascada), en su propia transacción
//    corta (dentro de la larga de la parte 1 chocaba con otras pistas).
// ============================================================================
async function parte5() {
  console.log("\n== 5. Cascada al borrar un antro ==");
  // Transacción corta y propia; si choca con otra pista (deadlock), se
  // reintenta entera. Todo se deshace.
  let cascada = null;
  for (let intentoC = 1; intentoC <= 5 && cascada !== true; intentoC++) {
    await db.q("begin");
    try {
      const [c] = await db.q(`insert into public.clubs (nombre, direccion, horario) values ('T n4 cli antro cascada', 'x', 'x') returning id`);
      const [b] = await db.q(`insert into public.club_bloqueos (club_id, telefono, motivo) values ($1, '5590000077', 't_n4_cli cascada') returning id`, [c.id]);
      await db.q(`insert into public.lista_negra_eventos (club_id, tipo, telefono, bloqueo_id) values ($1, 'bloqueo', '5590000077', $2)`, [c.id, b.id]);
      await db.q(`delete from public.clubs where id = $1`, [c.id]);
      const q = await db.q(`select count(*)::int n from public.club_bloqueos where club_id = $1`, [c.id]);
      cascada = q[0].n === 0 ? true : "quedaron filas";
    } catch (e) {
      cascada = e.message;
      if (e.code === "40P01") await new Promise((r) => setTimeout(r, 2000 * intentoC));
    } finally {
      await db.q("rollback").catch(() => {});
    }
  }
  nota("borrar un antro con bloqueos (cascada) sí se puede", cascada === true, String(cascada));
}

// ============================================================================
// 3. API real (PostgREST + Auth): anon, cliente y RP
// ============================================================================
async function parte3() {
  console.log("\n== 3. API real (anon key y sesiones reales) ==");
  const env = verificarEnvDev();
  const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
  const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
  const nuevo = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  async function entrar(correo) {
    for (let i = 0; i < 5; i++) {
      const c = nuevo();
      const { error } = await c.auth.signInWithPassword({ email: correo, password: cred.password });
      if (!error) return c;
      if (!/rate|too many/i.test(error.message)) throw new Error(`login ${correo}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
    throw new Error(`login ${correo}: límite de intentos`);
  }
  const antes = await db.q(`select activa from public.club_funciones where club_id = $1 and funcion = 'lista_negra'`, [DEMO]);
  const TEL = "5590000099";
  const HOY = await hoyDe(DEMO);
  try {
    await flag(DEMO, "lista_negra", true);
    await db.q(`insert into public.club_bloqueos (club_id, telefono, nombre, motivo) values ($1, $2, 'T n4 cli REST', 't_n4_cli prueba por la API')`, [DEMO, TEL]);
    const fila = (tel, fecha, extra = {}) => ({ cliente_nombre: "T n4 cli REST", cliente_telefono: tel, club_id: DEMO, source: "organica", fecha, personas: 2, status: "pendiente", qr_code: `antro-t_n4_cli_${randomUUID()}`, ...extra });

    const anon = nuevo();
    const r1 = await anon.from("reservations").insert(fila("55 9000 0099", masDias(HOY, 20)));
    nota("API anon: teléfono bloqueado → P0001 neutro", r1.error?.code === "P0001" && r1.error.message === ln.MENSAJE_RECHAZO_CLIENTE, r1.error ? `${r1.error.code} ${r1.error.message}` : "insertó");
    const inv1 = await anon.from("reservations").insert(fila("5590000099", masDias(HOY, 20), { status: "confirmada" }));
    const inv2 = await anon.from("reservations").insert(fila("5590000097", masDias(HOY, 20), { status: "confirmada" }));
    nota("API anon: inserción inválida responde igual con teléfono bloqueado y libre", inv1.error?.code === inv2.error?.code && inv1.error?.code === "42501", `${inv1.error?.code} / ${inv2.error?.code}`);
    const r2 = await anon.from("reservations").insert(fila("5590000098", masDias(HOY, 20)));
    nota("API anon: teléfono limpio → reserva (como hoy)", !r2.error, r2.error?.message);

    const cli = await entrar(cred.usuarios.cliente);
    const { data: u } = await cli.auth.getUser();
    const r3 = await cli.from("reservations").insert(fila("+52 1 55 9000 0099", masDias(HOY, 21), { cliente_id: u.user.id }));
    nota("API cliente con sesión: teléfono bloqueado → P0001 neutro", r3.error?.code === "P0001" && r3.error.message === ln.MENSAJE_RECHAZO_CLIENTE, r3.error ? `${r3.error.code} ${r3.error.message}` : "insertó");

    const rp = await entrar(cred.usuarios.rp);
    const { data: urp } = await rp.auth.getUser();
    const r4 = await rp.from("reservations").insert(fila("5590000099", masDias(HOY, 22), { source: "rp", rp_id: urp.user.id }));
    nota("API RP con sesión: teléfono bloqueado → P0001 para RP", r4.error?.code === "P0001" && r4.error.message === ln.MENSAJE_RECHAZO_RP, r4.error ? `${r4.error.code} ${r4.error.message}` : "insertó");
    const r5 = await rp.rpc("lista_negra_bloqueos", { p_club: DEMO });
    nota("API RP: no ve la lista", r5.error?.code === "P0001");
    const r6 = await anon.rpc("lista_negra_bloqueos", { p_club: DEMO });
    nota("API anon: no puede llamar la gestión", !!r6.error && r6.error.code !== "P0001", r6.error?.code);
    await cli.auth.signOut().catch(() => {});
    await rp.auth.signOut().catch(() => {});
  } finally {
    // Bandera como estaba, y limpieza (bloqueos y bitácora solo con el permiso de pruebas).
    if (antes.length) await flag(DEMO, "lista_negra", antes[0].activa); else await flag(DEMO, "lista_negra", null);
    await db.q("begin");
    await db.q(`set local antroapp.borrado_pruebas = 'on'`);
    await db.q(`delete from public.lista_negra_eventos where club_id = $1 and telefono = $2`, [DEMO, TEL]);
    await db.q(`delete from public.club_bloqueos where club_id = $1 and motivo like 't_n4_cli%'`, [DEMO]);
    await db.q(`delete from public.reservations where qr_code like 'antro-t_n4_cli_%'`);
    await db.q(`delete from public.reserva_intentos where club_id = $1 and telefono_hash in (encode(sha256(convert_to('5590000098','UTF8')),'hex'), encode(sha256(convert_to('5590000099','UTF8')),'hex'))`, [DEMO]);
    await db.q("commit");
  }
  const q = (await db.q(`select (select count(*) from public.reservations where qr_code like 'antro-t_n4_cli_%' or cliente_nombre like 'T n4 cli%')::int r,
                                (select count(*) from public.club_bloqueos where motivo like 't_n4_cli%')::int b,
                                (select count(*) from public.reserva_intentos where telefono_hash in (encode(sha256(convert_to('5590000098','UTF8')),'hex'), encode(sha256(convert_to('5590000099','UTF8')),'hex')))::int i,
                                (select count(*) from public.club_funciones where club_id = $1 and funcion = 'lista_negra')::int f`, [DEMO]))[0];
  nota("API: 0 restos (reservas, bloqueos, intentos) y bandera como estaba", q.r === 0 && q.b === 0 && q.i === 0 && q.f === antes.length, JSON.stringify(q));
}

// Otras pistas cambian el esquema de dev a la vez (DDL sobre reservations):
// una parte que choca (deadlock o candado) se repite entera; sus notas de
// la vuelta fallida se descartan. Cada parte deshace lo suyo.
async function conReintento(fn) {
  for (let i = 1; ; i++) {
    const antes = res.length;
    try {
      return await fn();
    } catch (e) {
      if (!["40P01", "55P03"].includes(e.code) || i === 4) throw e;
      res.length = antes;
      console.log(`  (choque con otra pista: se repite, vuelta ${i + 1})`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

try {
  await conReintento(parte1);
  await conReintento(parte2);
  await conReintento(parte5);
  if (CON_REST) await conReintento(parte3);
  if (process.argv.includes("--carga")) await conReintento(parte4);
} finally {
  await db.fin();
}
const nOk = res.filter(Boolean).length;
console.log(`\nResultado: ${nOk}/${res.length}`);
process.exit(nOk === res.length ? 0 : 1);
