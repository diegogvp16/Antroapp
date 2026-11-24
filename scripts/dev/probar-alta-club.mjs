// Pruebas del alta de antros (POST /api/admin/alta-club y admin_alta_club)
// contra el servidor local de dev (node scripts/dev/servidor-dev.mjs, puerto
// 3001) y antroapp-dev. Requiere sql/post-junta/01-alta-club.sql en dev.
//
//   node scripts/dev/probar-alta-club.mjs [--base=http://localhost:3001]
//
// Revisa con sesiones reales de cada rol:
//   1. Sin sesión, cliente, RP, staff, gerente y dueño: la ruta responde 401/403
//      y la función de la base los rechaza; nadie fuera del admin lee club_altas.
//   2. Admin: alta en borrador con dueño, equipo, mesas y grupo nuevo; todo
//      queda como se pidió, con la bitácora de quién lo creó; la cuenta nueva
//      entra con su contraseña temporal; el público no ve el borrador.
//   3. Admin: alta publicada en el grupo anterior, con dueño de grupo nuevo;
//      el público sí la ve.
//   4. Transacción: si una cuenta ya existe, no queda NADA (ni antro ni
//      cuentas nuevas); si la base falla a la mitad, no queda el antro.
//   5. Con --masivo: alta con 130 RPs y cuánto tarda.
// Al final borra todo lo que creó (solo dev).

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const BASE = (process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:3001").replace(/\/$/, "");
const { password: PASS_DEV } = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));

let pasan = 0, fallan = 0;
function revisar(cond, texto) {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto);
}

const sufijo = randomUUID().slice(0, 8);
const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

// Sesión por cookie, igual que el navegador.
async function sesion(email, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip() },
    body: JSON.stringify({ email, password }),
  });
  const galletas = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { status: r.status, galletas };
}
async function alta(galletas, cuerpo) {
  const r = await fetch(BASE + "/api/admin/alta-club", {
    method: "POST",
    headers: { "content-type": "application/json", ...(galletas ? { cookie: galletas } : {}) },
    body: JSON.stringify(cuerpo),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}
async function clienteDe(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error("login " + email + ": " + error.message);
  return c;
}

const altaBase = (nombre, extra = {}) => ({
  datos: { nombre, direccion: "Calle Ficticia 9, Centro", ciudad: "Querétaro", zona_horaria: "America/Mexico_City", horario: "Vie y Sáb 10pm a 3am" },
  politicas: { cover_modo: "monto", cover_monto: 250, deposito_monto: 0, edad_minima: 18, codigo_vestimenta: "Casual", tipo_musica: "", ambiente: "", tolerancia_hora: "23:30" },
  mesas: [{ numero: "1", capacidad: 8 }, { numero: "2", capacidad: 8 }, { numero: "VIP 1", capacidad: 15 }],
  dueno: { nombre: "Dueña Alta Prueba", correo: `alta_dueno_${sufijo}@example.com` },
  personal: [
    { nombre: "Gerente Alta Prueba", correo: `alta_gerente_${sufijo}@example.com`, rol: "gerente" },
    { nombre: "Staff Alta Prueba", correo: `alta_staff_${sufijo}@example.com`, rol: "staff" },
    { nombre: "RP Alta Uno", correo: `alta_rp1_${sufijo}@example.com`, rol: "rp" },
    { nombre: "RP Alta Dos", correo: `alta_rp2_${sufijo}@example.com`, rol: "rp" },
  ],
  grupo: { modo: "nuevo", nombre: `Grupo Alta Prueba ${sufijo}`, dueno_grupo: "dueno_antro", cuenta: null },
  publicar: false,
  ...extra,
});

const clubsCreados = [];
const gruposCreados = [];
const NOMBRE_PREFIJO = `Alta Prueba ${sufijo}`;
async function clubPorNombre(nombre) {
  const { data } = await svc.from("clubs").select("*").eq("nombre", nombre);
  return data ?? [];
}
async function usuariosConSufijo() {
  const { data } = await svc.auth.admin.listUsers({ perPage: 1000 });
  return (data?.users ?? []).filter((u) => (u.email ?? "").includes(sufijo));
}

try {
  // ---------- 1. Nadie fuera del admin ----------
  const sinSesion = await alta(null, altaBase(`${NOMBRE_PREFIJO} anon`));
  revisar(sinSesion.status === 401, "sin sesión → 401");
  for (const rol of ["cliente", "rp", "staff", "gerente", "dueno"]) {
    const s = await sesion(`dev_${rol}@example.com`, PASS_DEV);
    if (s.status !== 200) { revisar(false, `login dev_${rol} (${s.status})`); continue; }
    const r = await alta(s.galletas, altaBase(`${NOMBRE_PREFIJO} ${rol}`));
    revisar(r.status === 403, `${rol} → 403 en la ruta`);
    const c = await clienteDe(`dev_${rol}@example.com`, PASS_DEV);
    const rpc = await c.rpc("admin_alta_club", { p: { club: { nombre: `${NOMBRE_PREFIJO} rpc ${rol}`, direccion: "x calle", horario: "abc", ciudad: "QRO" } } });
    revisar(!!rpc.error && /Solo el admin/.test(rpc.error.message), `${rol} → la función de la base lo rechaza`);
    const bit = await c.from("club_altas").select("id");
    revisar(!bit.error && (bit.data ?? []).length === 0, `${rol} no lee la bitácora de altas`);
  }
  const rpcAnon = await anon.rpc("admin_alta_club", { p: {} });
  revisar(!!rpcAnon.error, "anónimo no puede ejecutar admin_alta_club");
  const bitAnon = await anon.from("club_altas").select("id");
  revisar(!!bitAnon.error || (bitAnon.data ?? []).length === 0, "anónimo no lee la bitácora");
  revisar((await svc.from("clubs").select("id").like("nombre", `${NOMBRE_PREFIJO}%`)).data.length === 0, "ningún intento rechazado dejó antro");

  // ---------- 2. Admin: borrador con grupo nuevo ----------
  const sAdmin = await sesion("dev_admin@example.com", PASS_DEV);
  revisar(sAdmin.status === 200, "admin inicia sesión");
  const { data: adminU } = await svc.from("profiles").select("id").eq("role", "admin").eq("nombre", "Admin Dev").maybeSingle();

  const invalido = await alta(sAdmin.galletas, { ...altaBase("x"), mesas: [{ numero: "1", capacidad: 0 }] });
  revisar(invalido.status === 400 && invalido.cuerpo.campos?.["mesas.0.capacidad"], "datos inválidos → 400 con el campo marcado");

  const nombre1 = `${NOMBRE_PREFIJO} borrador`;
  const t0 = performance.now();
  const r1 = await alta(sAdmin.galletas, altaBase(nombre1));
  const t1 = performance.now();
  revisar(r1.status === 200 && r1.cuerpo.ok, `admin da de alta en borrador (${((t1 - t0) / 1000).toFixed(1)} s, 5 cuentas)`);
  const [c1] = await clubPorNombre(nombre1);
  if (c1) clubsCreados.push(c1.id);
  if (r1.cuerpo.resultado?.grupo_id) gruposCreados.push(r1.cuerpo.resultado.grupo_id);
  revisar(c1 && c1.estado_verificacion === "borrador" && c1.suscripcion_activa === false, "queda en borrador y sin suscripción");
  revisar(c1 && c1.ciudad === "Querétaro" && c1.cover_modo === "monto" && Number(c1.cover_monto) === 250 && c1.tolerancia_hora?.startsWith("23:30"), "ciudad, cover y tolerancia guardados");
  const { data: mesas1 } = await svc.from("club_tables").select("numero, capacidad").eq("club_id", c1?.id);
  revisar(mesas1?.length === 3 && mesas1.some((m) => m.numero === "VIP 1" && m.capacidad === 15), "3 mesas con sus nombres y capacidad");
  const usuarios1 = await usuariosConSufijo();
  const { data: perfiles1 } = await svc.from("profiles").select("id, role, club_id, activo").in("id", usuarios1.map((u) => u.id));
  const roles = (perfiles1 ?? []).map((p) => p.role).sort().join(",");
  revisar(roles === "dueno,gerente,rp,rp,staff", `perfiles con su rol (${roles})`);
  revisar((perfiles1 ?? []).filter((p) => p.role !== "dueno").every((p) => p.club_id === c1?.id && p.activo), "personal ligado al antro nuevo y activo");
  const duenoPerfil = (perfiles1 ?? []).find((p) => p.role === "dueno");
  revisar(c1 && duenoPerfil && c1.dueno_id === duenoPerfil.id && duenoPerfil.club_id === null, "dueño ligado por clubs.dueno_id");
  const { data: gm } = await svc.from("grupo_miembros").select("profile_id, rol_grupo").eq("grupo_id", r1.cuerpo.resultado?.grupo_id);
  const { data: gc } = await svc.from("grupo_clubs").select("club_id").eq("grupo_id", r1.cuerpo.resultado?.grupo_id);
  revisar(gm?.length === 1 && gm[0].profile_id === duenoPerfil?.id && gc?.length === 1 && gc[0].club_id === c1?.id, "grupo nuevo con el antro y su dueño como dueño del grupo");
  const { data: bit1 } = await svc.from("club_altas").select("creado_por, publicado, resumen").eq("club_id", c1?.id).maybeSingle();
  revisar(bit1 && bit1.creado_por === adminU?.id && bit1.publicado === false && bit1.resumen.mesas === 3 && bit1.resumen.usuarios.rp === 2, "bitácora: quién lo creó y qué");
  revisar(!JSON.stringify(bit1 ?? {}).includes("@"), "la bitácora no guarda correos");
  const credG = (r1.cuerpo.credenciales ?? []).find((c) => c.rol === "gerente");
  revisar(credG && credG.password.length >= 14 && /[A-Z]/.test(credG.password) && /\d/.test(credG.password), "contraseña temporal larga y con mayúscula y número");
  const sG = credG ? await sesion(credG.correo, credG.password) : { status: 0 };
  revisar(sG.status === 200, "el gerente nuevo entra con su contraseña temporal");
  const credD = (r1.cuerpo.credenciales ?? []).find((c) => c.rol === "dueno");
  if (credD) {
    const cd = await clienteDe(credD.correo, credD.password);
    const { data: suyo } = await cd.from("clubs").select("id").eq("dueno_id", duenoPerfil.id);
    revisar(suyo?.length === 1, "el dueño nuevo ve su antro (aunque esté en borrador)");
    const { data: res } = await cd.rpc("grupo_resumen", { p_desde: "2026-11-01", p_hasta: "2026-11-30" });
    revisar(Array.isArray(res) && res.some((x) => x.club_id === c1?.id), "el dueño del grupo ve el antro en /grupo");
  }
  const { data: publico1 } = await anon.from("clubs").select("id").eq("id", c1?.id);
  revisar((publico1 ?? []).length === 0, "el público no ve el borrador");

  // ---------- 3. Admin: publicado en el grupo existente ----------
  const nombre2 = `${NOMBRE_PREFIJO} publicado`;
  const r2 = await alta(sAdmin.galletas, altaBase(nombre2, {
    dueno: null,
    personal: [{ nombre: "Staff Publicado", correo: `alta_staff2_${sufijo}@example.com`, rol: "staff" }],
    mesas: [],
    grupo: { modo: "existente", grupo_id: r1.cuerpo.resultado?.grupo_id, dueno_grupo: "cuenta_nueva", cuenta: { nombre: "Dueño de Grupo Prueba", correo: `alta_grupo_${sufijo}@example.com` } },
    publicar: true,
  }));
  revisar(r2.status === 200 && r2.cuerpo.ok, "admin da de alta publicado, sin dueño ni mesas, en el grupo existente");
  const [c2] = await clubPorNombre(nombre2);
  if (c2) clubsCreados.push(c2.id);
  revisar(c2 && c2.estado_verificacion === "verificado" && c2.suscripcion_activa && c2.verificado_en && c2.dueno_id === null, "queda verificado, con suscripción y sin dueño");
  const { data: gc2 } = await svc.from("grupo_clubs").select("club_id").eq("grupo_id", r1.cuerpo.resultado?.grupo_id);
  const { data: gm2 } = await svc.from("grupo_miembros").select("profile_id").eq("grupo_id", r1.cuerpo.resultado?.grupo_id);
  revisar(gc2?.length === 2 && gm2?.length === 2, "el grupo ahora tiene 2 antros y 2 dueños de grupo");
  const { data: publico2 } = await anon.from("clubs").select("id").eq("id", c2?.id);
  revisar((publico2 ?? []).length === 1, "el público ve el antro publicado");

  // ---------- 4. Transacción ----------
  const antes = (await usuariosConSufijo()).length;
  const nombre3 = `${NOMBRE_PREFIJO} correo repetido`;
  const r3 = await alta(sAdmin.galletas, altaBase(nombre3, {
    dueno: { nombre: "Dueño Tres", correo: `alta_dueno3_${sufijo}@example.com` },
    personal: [
      { nombre: "RP Tres", correo: `alta_rp3_${sufijo}@example.com`, rol: "rp" },
      { nombre: "Staff Existente", correo: "dev_staff@example.com", rol: "staff" },
    ],
    grupo: { modo: "ninguno" },
  }));
  revisar(r3.status === 400 && /Ya existe una cuenta con el correo dev_staff@example.com/.test(r3.cuerpo.error ?? ""), "correo ya registrado → 400 con mensaje claro");
  revisar((await clubPorNombre(nombre3)).length === 0, "…y no queda el antro");
  revisar((await usuariosConSufijo()).length === antes, "…ni las cuentas que alcanzó a crear");

  const grupoFalso = await alta(sAdmin.galletas, altaBase(`${NOMBRE_PREFIJO} grupo falso`, { grupo: { modo: "existente", grupo_id: randomUUID(), dueno_grupo: "ninguno", cuenta: null } }));
  revisar(grupoFalso.status === 400 && /no existe/.test(grupoFalso.cuerpo.error ?? "") && (await usuariosConSufijo()).length === antes, "grupo inexistente → 400 antes de crear cuentas");

  // Falla a la mitad de la transacción: el antro y las mesas ya se insertaron
  // cuando la segunda cuenta resulta no ser nueva.
  const ca = await clienteDe("dev_admin@example.com", PASS_DEV);
  const nueva = await svc.auth.admin.createUser({ email: `alta_mitad_${sufijo}@example.com`, password: "Prueba-" + randomUUID(), email_confirm: true });
  const { data: staffDev } = await svc.from("profiles").select("id").eq("role", "staff").eq("nombre", "Staff Dev").maybeSingle();
  const nombre4 = `${NOMBRE_PREFIJO} a medias`;
  const r4 = await ca.rpc("admin_alta_club", {
    p: {
      club: { nombre: nombre4, direccion: "Calle 1", ciudad: "Querétaro", horario: "Vie 10pm" },
      mesas: [{ numero: "1", capacidad: 4 }],
      usuarios: [{ id: nueva.data.user.id, nombre: "Nueva", rol: "rp" }, { id: staffDev.id, nombre: "Robada", rol: "gerente" }],
      grupo: { modo: "ninguno" },
    },
  });
  revisar(!!r4.error && /no es nueva/.test(r4.error.message), "una cuenta que ya tiene perfil detiene la transacción");
  revisar((await clubPorNombre(nombre4)).length === 0, "…y no queda antro, mesas ni perfiles a medias");
  const { data: perfilNueva } = await svc.from("profiles").select("id").eq("id", nueva.data.user.id);
  const { data: staffIntacto } = await svc.from("profiles").select("role, club_id").eq("id", staffDev.id).maybeSingle();
  revisar((perfilNueva ?? []).length === 0 && staffIntacto?.role === "staff", "…ni el perfil de la primera cuenta; el staff existente sigue igual");
  await svc.auth.admin.deleteUser(nueva.data.user.id);

  const r5 = await ca.rpc("admin_alta_club", { p: { club: { nombre: `${NOMBRE_PREFIJO} zona`, direccion: "Calle 1", ciudad: "QRO", horario: "Vie 10pm", zona_horaria: "Marte/Olympus" } } });
  revisar(!!r5.error && (await clubPorNombre(`${NOMBRE_PREFIJO} zona`)).length === 0, "zona horaria inválida → la base lo rechaza y no queda nada");

  // ---------- 5. Alta masiva (opcional: --masivo) ----------
  if (process.argv.includes("--masivo")) {
    const nombre6 = `${NOMBRE_PREFIJO} masivo`;
    const rps = Array.from({ length: 130 }, (_, i) => ({ nombre: `RP Masivo ${i + 1}`, correo: `alta_masivo${i}_${sufijo}@example.com`, rol: "rp" }));
    const tm = performance.now();
    const r6 = await alta(sAdmin.galletas, altaBase(nombre6, { dueno: null, personal: rps, grupo: { modo: "ninguno" } }));
    const seg = (performance.now() - tm) / 1000;
    revisar(r6.status === 200 && (r6.cuerpo.credenciales ?? []).length === 130, `alta con 130 RPs en ${seg.toFixed(1)} s (límite de la función: 60 s)`);
    const [c6] = await clubPorNombre(nombre6);
    if (c6) clubsCreados.push(c6.id);
  }
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  // ---------- Limpieza (solo dev) ----------
  const usuarios = await usuariosConSufijo();
  const ids = usuarios.map((u) => u.id);
  if (gruposCreados.length) {
    await svc.from("grupo_miembros").delete().in("grupo_id", gruposCreados);
    await svc.from("grupo_clubs").delete().in("grupo_id", gruposCreados);
    await svc.from("grupos").delete().in("id", gruposCreados);
  }
  const { data: sobrantes } = await svc.from("clubs").select("id").like("nombre", `${NOMBRE_PREFIJO}%`);
  const todos = [...new Set([...clubsCreados, ...(sobrantes ?? []).map((c) => c.id)])];
  if (ids.length) await svc.from("profiles").delete().in("id", ids);
  if (todos.length) await svc.from("clubs").delete().in("id", todos);
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const quedan = (await usuariosConSufijo()).length + ((await svc.from("clubs").select("id").like("nombre", `${NOMBRE_PREFIJO}%`)).data ?? []).length;
  console.log(quedan === 0 ? "\nLimpieza: no quedó nada de la prueba." : `\nLimpieza: QUEDARON ${quedan} registros de la prueba.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan || quedan) process.exitCode = 1;
}
