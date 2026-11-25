// Pruebas de la configuración por grupo (sql/post-junta-2/12-config-grupo.sql)
// contra antroapp-dev, con datos propios (prefijo t_alta_) que se borran al
// final aunque algo falle.
//
//   node scripts/dev/probar-config-grupo.mjs
//
// Escenario:
//   G1 = antros A y B (A con una regla vieja de la semana pasada).
//   G2 = antro C. D = antro fuera de todo grupo.
//   Cuentas: dueño de G1, dueño de G2, dueño de A, gerente/staff/RP de A,
//   staff de C, una cuenta sin perfil, un dueño de G1 con contraseña
//   temporal, el anónimo y dev_admin (solo inicia sesión; no se le cambia
//   nada).
// Cubre: herencia y «propio», la regla desde el lunes siguiente (sin tocar
// lo de esta semana, con una comisión real por la caja), visibilidad,
// permisos de caja, modo de pago, cover bloqueado, hora límite, volver a
// heredar, quitar, bitácora, el alta dentro del grupo (heredar y propio) y
// los rechazos por rol.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const TAG = "cg" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const ids = [];
const clubIds = [];
const grupoIds = [];
const altaIds = [];
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Inicio de sesión con reintento: el límite de Supabase Auth lo comparten
// varios agentes desde la misma IP.
async function entrar(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  for (let i = 0; i < 6; i++) {
    const r = await c.auth.signInWithPassword({ email, password });
    if (!r.error) return c;
    if (!/rate|too many|429/i.test(r.error.message)) throw new Error("login " + email + ": " + r.error.message);
    await espera(5000 * (i + 1));
  }
  throw new Error("login " + email + ": límite de Auth");
}
async function cuenta(clave, role, club_id = null, appMeta = null) {
  const email = `t_alta_${TAG}_${clave}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, ...(appMeta ? { app_metadata: appMeta } : {}) }), "usuario " + clave);
  ids.push(u.user.id);
  if (role) ok(await svc.from("profiles").insert({ id: u.user.id, nombre: `${clave} ${TAG}`, role, club_id, activo: true }), "perfil " + clave);
  return { id: u.user.id, c: await entrar(email, PASS) };
}
const hoyMx = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
const lunesDe = (f) => {
  const d = new Date(f + "T12:00:00Z");
  const dia = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dia * 86400e3).toISOString().slice(0, 10);
};
const sumar = (f, n) => new Date(Date.parse(f + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
const err = (r) => r.error?.message ?? "";
const rechazado = (r) => !!r.error;

const db = await conectarDevEscritura();
const q = db.q;

// Una reserva del RP que entra, se sienta, consume, paga y se cuadra (camino real de la caja).
async function noche(club, ger, rp, centavos) {
  const r = { id: randomUUID(), cliente_nombre: `Cliente ${TAG}`, cliente_telefono: "0000000555", personas: 4, status: "usada", puerta_estado: "entro", entrada_en: new Date().toISOString(), source: "rp", rp_id: rp, club_id: club.id, fecha: club.noche, qr_code: `antro-${randomUUID()}` };
  ok(await svc.from("reservations").insert(r), "reserva");
  const mesa = club.mesas.shift();
  const sesion = ok(await ger.rpc("caja_abrir_mesa", { p_mesa_id: mesa }), "abrir mesa");
  const cta = ok(await ger.rpc("caja_sentar_cliente", { p_sesion_id: sesion, p_reservation_id: r.id }), "sentar");
  ok(await ger.rpc("caja_registrar_consumo", { p_cuenta_id: cta, p_monto_centavos: centavos, p_concepto: "Botella prueba" }), "consumo");
  ok(await ger.rpc("caja_registrar_pago", { p_sesion_id: sesion, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: centavos }), "pago");
  ok(await ger.rpc("caja_cerrar_mesa", { p_sesion_id: sesion }), "cerrar");
  ok(await ger.rpc("caja_cuadrar_mesa", { p_sesion_id: sesion }), "cuadrar");
  const com = ok(await svc.from("commissions").select("monto, regla_id").eq("reservation_id", r.id).maybeSingle(), "comisión");
  return { centavos: com ? Math.round(Number(com.monto) * 100) : null, regla: com?.regla_id ?? null };
}
const vigente = async (club, fecha) =>
  (await q("select tipo, cuota, porcentaje_bp, monto_centavos::int as monto, vigente_desde::text as desde, vigente_hasta::text as hasta, id from public.regla_comision_vigente($1, $2::date)", [club, fecha]))[0];
const marcas = async (club) => (await q("select clave from public.club_config_propia where club_id = $1 order by clave", [club])).map((x) => x.clave);
const clubFila = async (club) => (await q("select pago_rp_modo, cover_modo, cover_monto::text, to_char(tolerancia_hora, 'HH24:MI') as tol from public.clubs where id = $1", [club]))[0];
const vis = async (club) => (await q("select public.rp_nivel_visibilidad($1) as v", [club]))[0].v;

try {
  const hoy = hoyMx();
  const lunes = lunesDe(hoy);
  const sigLunes = sumar(lunes, 7);

  // ---------- Escenario ----------
  const duenoG1 = await cuenta("duenog1", "dueno");
  const duenoG2 = await cuenta("duenog2", "dueno");
  const duenoA = await cuenta("duenoa", "dueno");
  const nuevoClub = async (k, extra = {}) => {
    const c = ok(await svc.from("clubs").insert({ nombre: `T alta CG ${k} ${TAG}`, direccion: "Calle 1", horario: "Vie", pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0, ...extra }).select("id").single(), "club " + k);
    clubIds.push(c.id);
    return c.id;
  };
  const A = { id: await nuevoClub("A", { dueno_id: duenoA.id }), noche: hoy };
  const B = { id: await nuevoClub("B") };
  const C = { id: await nuevoClub("C") };
  const D = { id: await nuevoClub("D") };
  A.mesas = ok(await svc.from("club_tables").insert(Array.from({ length: 4 }, (_, i) => ({ club_id: A.id, numero: String(i + 1), capacidad: 6 }))).select("id"), "mesas A").map((m) => m.id);
  const gerenteA = await cuenta("gerentea", "gerente", A.id);
  const staffA = await cuenta("staffa", "staff", A.id);
  const rpA = await cuenta("rpa", "rp", A.id);
  const staffC = await cuenta("staffc", "staff", C.id);
  const sinPerfil = await cuenta("sinperfil", null);
  const temporal = await cuenta("temporal", "dueno", null, { debe_cambiar: true });
  const cred = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
  const admin = { c: await entrar("dev_admin@example.com", cred.password) };

  // Antes de entrar al grupo: A tiene una regla desde el lunes PASADO y un
  // permiso de caja por rol y otro por persona.
  await q("insert into public.reglas_comision (club_id, tipo, monto_centavos, vigente_desde, creada_por) values ($1, 'fijo', 10000, $2::date, $3)", [A.id, sumar(lunes, -7), duenoA.id]);
  await q("insert into public.caja_permisos (club_id, permiso, rol, permitido) values ($1, 'cerrar_noche', 'gerente', false)", [A.id]);
  await q("insert into public.caja_permisos (club_id, permiso, profile_id, permitido) values ($1, 'registrar_consumo', $2, false)", [A.id, staffA.id]);

  const g1 = ok(await svc.from("grupos").insert({ nombre: `T alta grupo 1 ${TAG}` }).select("id").single(), "G1").id;
  const g2 = ok(await svc.from("grupos").insert({ nombre: `T alta grupo 2 ${TAG}` }).select("id").single(), "G2").id;
  grupoIds.push(g1, g2);
  ok(await svc.from("grupo_miembros").insert([
    { grupo_id: g1, profile_id: duenoG1.id, rol_grupo: "dueno_grupo" },
    { grupo_id: g1, profile_id: temporal.id, rol_grupo: "dueno_grupo" },
    { grupo_id: g2, profile_id: duenoG2.id, rol_grupo: "dueno_grupo" },
  ]), "miembros");
  ok(await svc.from("grupo_clubs").insert([{ grupo_id: g1, club_id: A.id }, { grupo_id: g1, club_id: B.id }, { grupo_id: g2, club_id: C.id }]), "grupo_clubs");

  // ---------- Entrar a un grupo por fuera del alta: conserva lo suyo ----------
  revisar((await marcas(A.id)).length === 6 && (await marcas(B.id)).length === 6, "un antro que el admin agrega al grupo directo en la tabla queda «propio» en las 6 claves");
  // A partir de aquí, A y B siguen al grupo (como si hubieran entrado por el alta con «usar lo del grupo»).
  await q("delete from public.club_config_propia where club_id = any($1::uuid[])", [[A.id, B.id]]);

  // ---------- Nadie fuera del dueño del grupo y el admin ----------
  const cambiar = (s, clave, valor, bloqueado = false, grupo = g1) => s.rpc("grupo_config_cambiar", { p_grupo: grupo, p_clave: clave, p_valor: valor, p_bloqueado: bloqueado });
  const quienes = { "gerente de A": gerenteA.c, "staff de A": staffA.c, "RP de A": rpA.c, "dueño de A (no del grupo)": duenoA.c, "dueño del otro grupo": duenoG2.c, "cuenta sin perfil": sinPerfil.c, "dueño del grupo con contraseña temporal": temporal.c, "anónimo": anon };
  for (const [nombre, s] of Object.entries(quienes)) {
    revisar(rechazado(await cambiar(s, "visibilidad_rp", "estado")), `${nombre}: no cambia la configuración del grupo`);
    revisar(rechazado(await s.rpc("grupo_config_actual", { p_grupo: g1 })), `${nombre}: no ve la configuración del grupo`);
  }
  revisar((await q("select count(*)::int n from public.grupo_config where grupo_id = $1", [g1]))[0].n === 0, "tras los rechazos, el grupo sigue sin valores");
  for (const [nombre, s] of Object.entries({ "dueño del grupo": duenoG1.c, gerente: gerenteA.c, anónimo: anon })) {
    for (const fn of ["_config_aplicar_club", "_config_marcar_propia", "_admin_alta_club_base", "es_dueno_de_grupo", "_config_normalizar"]) {
      const args = { _config_aplicar_club: { p_club: A.id, p_clave: "visibilidad_rp", p_valor: "estado", p_por: null }, _config_marcar_propia: { p_club: A.id, p_clave: "cover" }, _admin_alta_club_base: { p: {} }, es_dueno_de_grupo: { p_grupo: g1 }, _config_normalizar: { p_clave: "cover", p_valor: {} } }[fn];
      revisar(rechazado(await s.rpc(fn, args)), `${nombre}: no ejecuta ${fn} por rpc`);
    }
    revisar(rechazado(await s.from("grupo_config").select("grupo_id")) || ((await s.from("grupo_config").select("grupo_id")).data ?? []).length === 0, `${nombre}: no lee grupo_config directo`);
    revisar(rechazado(await s.from("club_config_propia").insert({ club_id: A.id, clave: "cover" })), `${nombre}: no escribe club_config_propia directo`);
  }
  revisar(rechazado(await admin.c.rpc("_admin_alta_club_base", { p: {} })), "ni el admin llama a la versión interna del alta");
  revisar((await gerenteA.c.rpc("grupo_config_mis_grupos")).data?.length === 0, "el gerente no tiene grupos que configurar");
  const misG1 = (await duenoG1.c.rpc("grupo_config_mis_grupos")).data ?? [];
  revisar(misG1.length === 1 && misG1[0].id === g1 && misG1[0].antros === 2, "el dueño de G1 solo ve G1 (2 antros)");
  const misAdmin = (await admin.c.rpc("grupo_config_mis_grupos")).data ?? [];
  revisar(misAdmin.some((g) => g.id === g1) && misAdmin.some((g) => g.id === g2), "el admin ve todos los grupos");

  // ---------- Regla de comisión: desde el lunes siguiente, sin tocar esta semana ----------
  const n0 = await noche(A, gerenteA.c, rpA.id, 50000);
  revisar(n0.centavos === 10000, "antes del cambio: la regla de A paga $100", JSON.stringify(n0));
  const r1 = await cambiar(duenoG1.c, "regla_comision", { tipo: "fijo", monto_centavos: 25000 });
  revisar(!r1.error && r1.data.siguen === 2 && r1.data.cambiaron === 2 && r1.data.vigente_desde === sigLunes, `el dueño de G1 define la regla ($250): llega a A y B desde el lunes ${sigLunes}`, JSON.stringify(r1.error ?? r1.data));
  const aHoy = await vigente(A.id, hoy), aSig = await vigente(A.id, sigLunes), bHoy = await vigente(B.id, hoy), bSig = await vigente(B.id, sigLunes);
  revisar(aHoy?.monto === 10000 && aHoy.hasta === sumar(sigLunes, -1), "A: esta semana sigue $100 (la regla vieja se cierra el domingo, no se borra)", JSON.stringify(aHoy));
  revisar(aSig?.monto === 25000 && aSig.desde === sigLunes && bSig?.monto === 25000 && !bHoy?.id, "A y B: $250 desde el lunes siguiente; B sigue esta semana con lo anterior", JSON.stringify([aSig, bHoy, bSig]));
  revisar(!(await vigente(C.id, sigLunes))?.id && !(await vigente(D.id, sigLunes))?.id, "C (otro grupo) y D (sin grupo) no cambian");
  const n1 = await noche(A, gerenteA.c, rpA.id, 50000);
  revisar(n1.centavos === 10000 && n1.regla === aHoy.id, "un cuadre de esta semana, después del cambio del grupo: sigue $100 (no retroactivo)", JSON.stringify(n1));
  const com0 = (await q("select count(*)::int n, sum(monto)::text s from public.commissions c join public.reservations r on r.id = c.reservation_id where r.club_id = $1", [A.id]))[0];
  revisar(com0.n === 2 && com0.s === "200.00", "las comisiones ya calculadas no cambian");
  const bitA = await q("select despues, vigente_desde::text d from public.config_rp_cambios where club_id = $1 and que = 'regla_comision'", [A.id]);
  revisar(bitA.length === 1 && bitA[0].despues.grupo === true && bitA[0].d === sigLunes, "la bitácora de A registra la regla del grupo con su fecha");
  const r1b = await cambiar(duenoG1.c, "regla_comision", { tipo: "fijo", monto_centavos: 25000 });
  revisar(!r1b.error && r1b.data.cambiaron === 0 && (await q("select count(*)::int n from public.reglas_comision where club_id = $1", [A.id]))[0].n === 2, "repetir el mismo valor no cambia nada (idempotente)");
  // «Ya llegó el lunes»: se mueve la regla del grupo al lunes actual (solo para probar el cálculo).
  await q("update public.reglas_comision set vigente_hasta = $2::date - 1 where club_id = $1 and vigente_desde < $2::date", [A.id, lunes]);
  await q("update public.reglas_comision set vigente_desde = $2::date where club_id = $1 and vigente_desde = $3::date", [A.id, lunes, sigLunes]);
  const n2 = await noche(A, gerenteA.c, rpA.id, 50000);
  revisar(n2.centavos === 25000 && n2.regla === aSig.id, "llegado el lunes, la caja calcula con la regla del grupo ($250) y guarda su id", JSON.stringify(n2));

  // ---------- Visibilidad: propio y volver a heredar ----------
  const v1 = await cambiar(duenoG1.c, "visibilidad_rp", "estado");
  revisar(!v1.error && (await vis(A.id)) === "estado" && (await vis(B.id)) === "estado" && (await vis(D.id)) === "estado_monto", "visibilidad del grupo «solo estado»: llega a A y B al momento, D no");
  ok(await gerenteA.c.rpc("config_rp_cambiar_visibilidad", { p_club: A.id, p_nivel: "estado_monto_botellas" }), "gerente A cambia visibilidad");
  revisar((await marcas(A.id)).includes("visibilidad_rp"), "el gerente de A cambia lo que ven sus RPs: A queda «propio» en esa clave");
  const v2 = await cambiar(duenoG1.c, "visibilidad_rp", "estado_monto");
  revisar(!v2.error && v2.data.siguen === 1 && v2.data.propios === 1 && (await vis(A.id)) === "estado_monto_botellas" && (await vis(B.id)) === "estado_monto", "un cambio posterior del grupo llega a B y NO pisa a A", JSON.stringify(v2.data));
  revisar(rechazado(await staffA.c.rpc("club_config_heredar", { p_club: A.id, p_clave: "visibilidad_rp" })), "el staff no puede «volver al del grupo»");
  revisar(rechazado(await duenoG2.c.rpc("club_config_heredar", { p_club: A.id, p_clave: "visibilidad_rp" })), "el dueño de otro grupo tampoco");
  revisar(rechazado(await sinPerfil.c.rpc("club_config_heredar", { p_club: A.id, p_clave: "visibilidad_rp" })), "una cuenta sin perfil tampoco");
  const h1 = await gerenteA.c.rpc("club_config_heredar", { p_club: A.id, p_clave: "visibilidad_rp" });
  revisar(!h1.error && (await vis(A.id)) === "estado_monto" && !(await marcas(A.id)).includes("visibilidad_rp"), "el gerente de A vuelve al del grupo: A toma «estado y monto»", err(h1));
  revisar(rechazado(await gerenteA.c.rpc("club_config_heredar", { p_club: A.id, p_clave: "caja_permisos" })), "el gerente no decide el origen de los permisos de caja (solo regla y visibilidad)");

  // ---------- Permisos de caja por rol ----------
  const p1 = await cambiar(duenoG1.c, "caja_permisos", [{ permiso: "cobrar", rol: "staff", permitido: false }, { permiso: "anular", rol: "staff", permitido: true }]);
  const mis = (await staffA.c.rpc("caja_mis_permisos", { p_club_id: A.id })).data ?? {};
  revisar(!p1.error && mis.cobrar === false && mis.anular === true && mis.registrar_consumo === false, "permisos del grupo en A: el staff ya no cobra y sí anula; su casilla por persona sigue ganando", JSON.stringify(p1.error ?? mis));
  const misGer = (await gerenteA.c.rpc("caja_mis_permisos", { p_club_id: A.id })).data ?? {};
  revisar(misGer.cerrar_noche === true, "la casilla vieja de A (gerente sin cerrar la noche) vuelve a la plataforma: el grupo no la define");
  const misC = (await staffC.c.rpc("caja_mis_permisos", { p_club_id: C.id })).data ?? {};
  revisar(misC.cobrar === true && misC.anular === false, "el staff de C (otro grupo) no cambia");
  revisar((await q("select count(*)::int n from public.caja_permisos where club_id = $1 and profile_id is not null", [A.id]))[0].n === 1, "la casilla por persona no se toca");

  // ---------- Modo de pago ----------
  const m1 = await cambiar(duenoG1.c, "modo_pago", { modo: "dia", tarifas_dia: [{ posicion: 2, monto_centavos: 40000 }, { posicion: 1, monto_centavos: 30000 }] });
  const tarB = await q("select posicion, monto::text from public.club_dia_tarifas where club_id = $1 order by posicion", [B.id]);
  revisar(!m1.error && (await clubFila(B.id)).pago_rp_modo === "dia" && tarB.length === 2 && tarB[0].monto === "300.00" && tarB[1].monto === "400.00", "modo por día del grupo: B paga por día con $300 y $400", JSON.stringify(m1.error ?? tarB));
  revisar((await clubFila(D.id)).pago_rp_modo === "reserva", "D no cambia de modo");
  revisar(rechazado(await cambiar(duenoG1.c, "modo_pago", { modo: "dia", tarifas_dia: [] })), "por día sin tarifas: rechazado");
  ok(await duenoA.c.from("clubs").update({ pago_rp_modo: "reserva" }).eq("id", A.id), "dueño A cambia modo");
  revisar((await clubFila(A.id)).pago_rp_modo === "reserva" && (await marcas(A.id)).includes("modo_pago"), "el dueño de A cambia su modo en su panel: A queda «propio» en el modo");

  // ---------- Cover bloqueado ----------
  ok(await duenoA.c.from("clubs").update({ cover_modo: "libre", cover_monto: null }).eq("id", A.id), "dueño A pone cover libre");
  revisar((await marcas(A.id)).includes("cover"), "A cambia su cover: queda «propio»");
  const c1 = await cambiar(duenoG1.c, "cover", { cover_modo: "monto", cover_monto_centavos: 15000 }, true);
  revisar(!c1.error && c1.data.siguen === 2 && (await clubFila(A.id)).cover_monto === "150.00" && (await clubFila(B.id)).cover_modo === "monto", "cover BLOQUEADO del grupo: se aplica a todos, también a A que lo tenía propio", JSON.stringify(c1.error ?? c1.data));
  const c2 = await duenoA.c.from("clubs").update({ cover_modo: "consultar", cover_monto: null }).eq("id", A.id);
  revisar(/lo define el grupo/.test(err(c2)) && (await clubFila(A.id)).cover_modo === "monto", "con el cover bloqueado, el dueño de A no lo cambia", err(c2));
  revisar(rechazado(await duenoA.c.rpc("club_config_sobrescribir", { p_club: A.id, p_clave: "cover" })), "ni lo marca como propio");
  revisar(!(await admin.c.rpc("club_config_sobrescribir", { p_club: A.id, p_clave: "cover" })).error && (await marcas(A.id)).includes("cover"), "el admin sí puede dejar a A con su cover propio");
  revisar(rechazado(await cambiar(duenoG1.c, "cover", { cover_modo: "monto", cover_monto_centavos: 0 })), "cover en $0: rechazado");

  // ---------- Hora límite y quitar ----------
  const t1 = await cambiar(duenoG1.c, "tolerancia", { tolerancia_hora: "01:30" });
  revisar(!t1.error && (await clubFila(B.id)).tol === "01:30" && (await clubFila(D.id)).tol === null, "hora límite del grupo 01:30: llega a B, no a D", err(t1));
  revisar(rechazado(await cambiar(duenoG1.c, "tolerancia", { tolerancia_hora: "25:00" })), "hora inválida: rechazada");
  revisar(rechazado(await gerenteA.c.rpc("grupo_config_quitar", { p_grupo: g1, p_clave: "tolerancia" })), "el gerente no quita valores del grupo");
  ok(await duenoG1.c.rpc("grupo_config_quitar", { p_grupo: g1, p_clave: "tolerancia" }), "quitar tolerancia");
  revisar((await clubFila(B.id)).tol === "01:30" && (await q("select count(*)::int n from public.grupo_config where grupo_id = $1 and clave = 'tolerancia'", [g1]))[0].n === 0, "quitar el valor del grupo: B conserva su 01:30");
  revisar(rechazado(await cambiar(duenoG2.c, "tolerancia", { tolerancia_hora: "02:00" }, false, g1)), "el dueño de G2 no toca G1");
  const t2 = await cambiar(duenoG2.c, "tolerancia", { tolerancia_hora: "02:00" }, false, g2);
  revisar(!t2.error && (await clubFila(C.id)).tol === null && (await marcas(C.id)).includes("tolerancia"), "el dueño de G2 define su hora: C entró por la tabla (propio), no cambia");

  // ---------- Pantallas (funciones de lectura) ----------
  const act = (await duenoG1.c.rpc("grupo_config_actual", { p_grupo: g1 })).data;
  const antA = act?.antros?.find((x) => x.club_id === A.id);
  revisar(act && Object.keys(act.claves).sort().join() === "caja_permisos,cover,modo_pago,regla_comision,visibilidad_rp" && act.claves.cover.bloqueado === true, "grupo_config_actual: los 5 valores del grupo, el cover bloqueado", JSON.stringify(act?.claves && Object.keys(act.claves)));
  revisar(antA?.origen?.regla_comision === "grupo" && antA.origen.modo_pago === "propio" && antA.origen.tolerancia === "sin_valor", "origen por antro: A sigue la regla del grupo, su modo es propio y la hora no la define el grupo", JSON.stringify(antA?.origen));
  const acciones = (act?.historial ?? []).map((h) => h.accion);
  revisar(acciones.includes("grupo_define") && acciones.includes("club_sobrescribe") && acciones.includes("club_hereda") && acciones.includes("grupo_quita") && act.historial.every((h) => h.quien || h.accion === "club_sobrescribe"), "bitácora del grupo: define, sobrescribe, hereda y quita, con quién", JSON.stringify([...new Set(acciones)]));
  revisar(!(await admin.c.rpc("grupo_config_actual", { p_grupo: g1 })).error, "el admin ve la configuración del grupo");
  const efA = (await gerenteA.c.rpc("club_config_efectiva", { p_club: A.id })).data;
  revisar(efA?.grupo?.id === g1 && efA.claves.regla_comision.origen === "grupo" && efA.claves.modo_pago.origen === "propio" && efA.claves.regla_comision.puede_cambiar === true && efA.claves.caja_permisos.puede_cambiar === false && efA.puede_editar_grupo === false, "club_config_efectiva para el gerente de A: del grupo / propio y qué puede cambiar", JSON.stringify(efA?.claves?.regla_comision));
  for (const [nombre, s] of Object.entries({ staff: staffA.c, RP: rpA.c, "dueño de otro grupo": duenoG2.c, "sin perfil": sinPerfil.c, anónimo: anon })) {
    revisar(rechazado(await s.rpc("club_config_efectiva", { p_club: A.id })), `${nombre}: no ve la configuración efectiva de A`);
  }
  const efG = (await duenoG1.c.rpc("club_config_efectiva", { p_club: A.id })).data;
  revisar(efG?.puede_editar_grupo === true && efG.claves.caja_permisos.puede_cambiar === true, "el dueño de G1 ve la de A y puede decidir su origen");
  revisar((await admin.c.rpc("club_config_efectiva", { p_club: D.id })).data?.claves?.regla_comision?.origen === "sin_grupo", "D, sin grupo: origen «sin grupo»");

  // ---------- Alta dentro del grupo ----------
  const alta = (nombre, extra = {}) => {
    const alta_id = randomUUID();
    altaIds.push(alta_id);
    return admin.c.rpc("admin_alta_club", { p: {
      alta_id, club: { nombre: `T alta CG ${nombre} ${TAG}`, direccion: "Calle 2", ciudad: "Guadalajara", horario: "Vie y sáb", cover_modo: "oculto" },
      mesas: [{ numero: "1", capacidad: 4 }], usuarios: [], publicar: false,
      rp: { modo_pago: "reserva", regla: { tipo: "porcentaje", cuota: 0, porcentaje_bp: 1000, monto_centavos: null }, visibilidad: "estado_monto_botellas", tarifas_dia: [] },
      caja_permisos: [{ permiso: "cuadrar_mesa", rol: "staff", permitido: true }],
      grupo: { modo: "existente", grupo_id: g1 }, ...extra } });
  };
  const e1 = await alta("E");
  if (e1.data?.club_id) clubIds.push(e1.data.club_id);
  const E = e1.data?.club_id;
  const eHoy = E ? await vigente(E, hoy) : null;
  revisar(!e1.error && e1.data.grupo_config?.modo === "heredar" && e1.data.grupo_config.del_grupo.length === 5, "alta en G1 (por defecto «usar lo del grupo»): toma los 5 valores que el grupo define", JSON.stringify(e1.error ?? e1.data?.grupo_config));
  revisar(eHoy?.monto === 25000 && eHoy.desde === lunes && (await q("select count(*)::int n from public.reglas_comision where club_id = $1", [E]))[0].n === 1, "el antro nuevo nace con la regla del grupo desde el lunes de esta semana (una sola regla)", JSON.stringify(eHoy));
  const fE = E ? await clubFila(E) : {};
  revisar((await vis(E)) === "estado_monto" && fE.pago_rp_modo === "dia" && fE.cover_modo === "monto", "y con la visibilidad, el modo por día y el cover del grupo");
  revisar((await q("select count(*)::int n from public.caja_permisos where club_id = $1 and permiso = 'cuadrar_mesa'", [E]))[0].n === 0 && (await q("select count(*)::int n from public.caja_permisos where club_id = $1", [E]))[0].n === 2, "los permisos del alta los reemplaza los del grupo");
  revisar(E && (await marcas(E)).length === 0, "sin marcas: el antro nuevo sigue al grupo en todo");
  const resE = (await q("select resumen from public.club_altas where club_id = $1", [E]))[0]?.resumen;
  revisar(resE?.grupo_config?.modo === "heredar", "club_altas guarda qué tomó del grupo");
  const e2 = await alta("F", { grupo_config: "propio" });
  if (e2.data?.club_id) clubIds.push(e2.data.club_id);
  const F = e2.data?.club_id;
  const mF = F ? await marcas(F) : [];
  revisar(!e2.error && (await vis(F)) === "estado_monto_botellas" && (await vigente(F, hoy))?.porcentaje_bp === 1000 && mF.length === 5 && !mF.includes("cover"), "alta con «usar lo de este alta»: se queda con lo suyo y «propio» en todo menos lo bloqueado", err(e2) || JSON.stringify(mF));
  revisar(F && (await clubFila(F)).cover_modo === "monto" && e2.data.grupo_config?.del_grupo?.join() === "cover", "lo que el grupo bloqueó (el cover) se aplica aunque el alta elija lo suyo");
  const nAntes = (await q("select count(*)::int n from public.clubs where nombre like $1", [`%${TAG}%`]))[0].n;
  const e3 = await alta("G", { grupo_config: "otra" });
  revisar(rechazado(e3) && (await q("select count(*)::int n from public.clubs where nombre like $1", [`%${TAG}%`]))[0].n === nAntes, "valor raro en grupo_config: rechazado y sin antro");
  const e4 = await alta("H", { grupo: { modo: "existente", grupo_id: g2 } });
  if (e4.data?.club_id) clubIds.push(e4.data.club_id);
  revisar(!e4.error && e4.data.grupo_config?.del_grupo?.length === 1 && (await clubFila(e4.data.club_id)).tol === "02:00" && (await vis(e4.data.club_id)) === "estado_monto_botellas", "alta en G2: solo toma la hora límite (lo único que define G2)", err(e4));
  const e5 = await alta("I", { grupo: { modo: "ninguno" } });
  if (e5.data?.club_id) clubIds.push(e5.data.club_id);
  revisar(!e5.error && !e5.data.grupo_config && (await marcas(e5.data.club_id)).length === 0, "alta sin grupo: igual que antes", err(e5));
  revisar(rechazado(await duenoG1.c.rpc("admin_alta_club", { p: {} })) && rechazado(await sinPerfil.c.rpc("admin_alta_club", { p: {} })), "el alta sigue siendo solo del admin");
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  try {
    await q("begin");
    await q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
      await q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = any($1::uuid[]))", [clubIds]);
      for (const t of ["config_rp_cambios", "reglas_comision", "club_config_rp", "reservations", "club_tables", "grupo_clubs"])
        await q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
    }
    if (altaIds.length) await q("delete from public.club_altas where alta_id = any($1::uuid[])", [altaIds]);
    if (grupoIds.length) {
      await q("delete from public.grupo_miembros where grupo_id = any($1::uuid[])", [grupoIds]);
      await q("delete from public.grupos where id = any($1::uuid[])", [grupoIds]);
    }
    if (ids.length) await q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubIds.length) await q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await q("commit");
  } catch (e) {
    await q("rollback");
    console.log("Limpieza falló: " + e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const restos = (await q("select (select count(*) from public.clubs where nombre like $1)::int c, (select count(*) from public.grupos where nombre like $1)::int g, (select count(*) from auth.users where email like $2)::int u",
    [`%${TAG}%`, `t\\_alta\\_${TAG}\\_%`]))[0];
  await db.fin();
  console.log(`\nLimpieza: ${clubIds.length} antros, ${grupoIds.length} grupos y ${ids.length} cuentas de prueba borrados; restos: ${JSON.stringify(restos)}.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
