// Pruebas de RPs y staff en lote por CSV = invitaciones en lote (B1b):
// lib/domain/importar-personal.ts (sin base), invitaciones_importar y
// compañía (sql/post-junta-2/23-importar-personal.sql) y la ruta
// POST /api/equipo/importar, contra antroapp-dev.
//
//   node scripts/dev/probar-importar-personal.mjs                       (lector y base)
//   node scripts/dev/probar-importar-personal.mjs --base=http://localhost:3022
//       + la ruta (401/403/400, 130 RPs en menos de 60 s, reintento,
//         aceptar con teléfono e iniciar sesión)
//   ... --pantalla   (con PLAYWRIGHT_DESDE) + la pantalla Equipo a 390×844 y
//       360×740 (capturas en screenshots-b-equipo/)
//
// Crea sus propios antros («T equipo …») y cuentas (t_equipo_…@example.com)
// y los borra al final, aunque algo falle.

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";
import { importarTs } from "./cargar-ts.mjs";

const { leerPersonalCsv, revisarFilasPersonal, telefonoMx10, textoEnlaces, mensajeInvitacion, esquemaImportarPersonal, MAX_PERSONAL_CSV } = await importarTs(
  "../../lib/domain/importar-personal.ts",
  import.meta.url,
);

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const BASE = arg("base")?.replace(/\/$/, "") ?? null;
const PANTALLA = process.argv.includes("--pantalla");

let pasan = 0, fallan = 0;
const revisar = (c, t, d = "") => { if (c) pasan++; else fallan++; console.log((c ? "OK     " : "FALLA  ") + t + (c || !d ? "" : "  — " + d)); };
const sufijo = randomUUID().slice(0, 8);
const PASS = "Prueba-" + randomUUID();
const correoDe = (n) => `t_equipo_${n}_${sufijo}@example.com`;
const IPS = [];
const nuevaIp = () => { const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; IPS.push(ip); return ip; };
const hashIp = (ip) => createHash("sha256").update(ip).digest("hex");
const ids = {};
const clubes = {};

async function sesion(email, password = PASS) {
  for (let intento = 0; ; intento++) {
    const c = anon();
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (!error) return c;
    if (!/rate limit/i.test(error.message) || intento >= 6) throw new Error("login " + email + ": " + error.message);
    console.log("(límite de Supabase Auth; espero 30 s)");
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
async function cuenta(clave, { role = null, club = null, activo = true, meta = null } = {}) {
  const email = correoDe(clave);
  const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, ...(meta ? { app_metadata: meta } : {}) });
  if (u.error) throw new Error(`crear ${clave}: ${u.error.message}`);
  if (role) {
    const p = await svc.from("profiles").insert({ id: u.data.user.id, nombre: `T equipo ${clave}`, role, club_id: club, activo });
    if (p.error) throw new Error(`perfil ${clave}: ${p.error.message}`);
  }
  ids[clave] = { id: u.data.user.id, email, c: await sesion(email) };
  return ids[clave];
}
// Verificado por defecto (sql 24: sin verificar, solo 20 invitaciones al día).
async function antro(clave, duenoId, verificado = true) {
  const { data, error } = await svc
    .from("clubs")
    .insert({ nombre: `T equipo ${clave} ${sufijo}`, direccion: "Calle 1", horario: "Vie", dueno_id: duenoId, estado_verificacion: verificado ? "verificado" : "borrador" })
    .select("id")
    .single();
  if (error) throw new Error("antro: " + error.message);
  clubes[clave] = data.id;
  return data.id;
}
const filasDe = (prefijo, n, conTel = false) =>
  Array.from({ length: n }, (_, i) => ({ linea: i + 1, nombre: `Persona ${prefijo} ${i + 1}`, correo: correoDe(`${prefijo}${i + 1}`), telefono: conTel ? `55${String(10000000 + i)}` : null }));
const importar = (c, club, rol, filas, lote = randomUUID()) => c.rpc("invitaciones_importar", { p_club_id: club, p_rol: rol, p_lote_id: lote, p_filas: filas });
const invitacionesDe = async (club) => (await svc.from("invitaciones").select("id, correo, rol, telefono, lote_id, token_emitido_en").eq("club_id", club)).data ?? [];

// ---------- HTTP ----------
async function login(email, password = PASS) {
  for (let intento = 0; ; intento++) {
    const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nuevaIp() }, body: JSON.stringify({ email, password }) });
    const galletas = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (r.status !== 401 || intento >= 6) return { status: r.status, galletas };
    console.log("(login 401; espero 30 s por el límite de Supabase Auth)");
    await new Promise((res) => setTimeout(res, 30_000));
  }
}
async function post(ruta, cuerpo, galletas = "") {
  const r = await fetch(BASE + ruta, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nuevaIp(), ...(galletas ? { cookie: galletas } : {}) },
    body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
  });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})), cache: r.headers.get("cache-control") };
}

try {
  // =========================================================================
  // 1. Lector y reglas (sin base)
  // =========================================================================
  {
    const a = leerPersonalCsv("Ana López, ana@example.com, 55 1234 5678\n\"Pérez, Luis\",LUIS@Example.com\n");
    revisar(
      a.errores.length === 0 && a.filas.length === 2 && a.filas[0].telefono === "5512345678" && a.filas[1].nombre === "Pérez, Luis" && a.filas[1].correo === "luis@example.com" && a.filas[1].telefono === null,
      "nombre, correo y teléfono opcional; comillas; correo en minúsculas",
      JSON.stringify(a),
    );
    const b = leerPersonalCsv("﻿Correo;Teléfono;Nombre completo\r\nana@example.com;+52 1 55 1234 5678;Ana\r\n");
    revisar(b.errores.length === 0 && b.filas[0].nombre === "Ana" && b.filas[0].telefono === "5512345678", "encabezado con columnas en otro orden, BOM, CRLF y +52 1", JSON.stringify(b));
    const c = leerPersonalCsv("Ana\tana@example.com\nLuis\tluis@example.com\t(33) 1234-5678");
    revisar(c.errores.length === 0 && c.filas[1].telefono === "3312345678", "tabulador (hoja de cálculo)");
    const d = leerPersonalCsv("A,a@example.com\nBeto,beto@\nCarla,carla@example.com,123\nana@example.com,Ana\nDani,DANI@example.com\nDani 2,dani@example.com\nEva,eva@example.com,5512345678,extra\n");
    const t = d.errores.join(" | ");
    revisar(
      d.errores.length === 6 && /Línea 1:.*nombre/.test(t) && /Línea 2:.*correo/.test(t) && /Línea 3:.*teléfono/.test(t) && /Línea 4:.*segunda columna/.test(t) &&
        /Línea 6:.*ya viene en la línea 5/.test(t) && /Línea 7:.*tres columnas/.test(t),
      "nombre corto, correo malo, teléfono corto, columnas al revés, correo repetido (sin importar mayúsculas) y columna de más: error por línea",
      t,
    );
    const e = leerPersonalCsv(Array.from({ length: MAX_PERSONAL_CSV + 1 }, (_, i) => `P ${i},p${i}@example.com`).join("\n"));
    revisar(e.errores.some((x) => /Máximo 400/.test(x)), "máximo 400 por archivo");
    const r = revisarFilasPersonal([{ linea: 3, nombre: "  Ana   López ", correo: " ANA@example.com", telefono: "55-1234-5678" }]);
    revisar("filas" in r && r.filas[0].nombre === "Ana López" && r.filas[0].correo === "ana@example.com" && r.filas[0].telefono === "5512345678", "el servidor vuelve a limpiar nombre, correo y teléfono");
    const r2 = revisarFilasPersonal([{ linea: 9, nombre: "Ana", correo: "no-es-correo", telefono: null }]);
    revisar("error" in r2 && /Línea 9/.test(r2.error), "el servidor rechaza un correo malo con su línea");
    revisar(!esquemaImportarPersonal.safeParse({ club_id: randomUUID(), rol: "dueno", lote_id: randomUUID(), filas: [{ linea: 1, nombre: "Ana", correo: "a@b.co", telefono: null }] }).success, "rol dueño no se acepta en el cuerpo");
    revisar(/WhatsApp|enlace/.test(mensajeInvitacion({ nombre: "Ana", club: "X", rol: "rp", enlace: "https://x/invitacion/abc" })) && textoEnlaces([{ nombre: "A", correo: "a@x.co", telefono: null, enlace: "E" }]) === "A\ta@x.co\t\tE", "mensaje y «Copiar todo»");
    const formula = textoEnlaces([
      { nombre: '=HYPERLINK("http://x","clic")', correo: "+a@x.co", telefono: null, enlace: "E" },
      { nombre: "@SUMA(1)\tcon\ntab", correo: "-b@x.co", telefono: "5512345678", enlace: "F" },
    ]).split("\n");
    revisar(
      formula.length === 2 && formula[0].startsWith("'=HYPERLINK") && formula[0].split("\t")[1] === "'+a@x.co" && formula[1].split("\t").length === 4 && formula[1].startsWith("'@SUMA(1) con tab") && formula[1].split("\t")[1] === "'-b@x.co",
      "«Copiar todo» neutraliza fórmulas (= + - @) y quita tabuladores y saltos dentro de un campo",
      JSON.stringify(formula),
    );

    // El espejo del teléfono coincide con la base.
    const db = await conectarDevEscritura();
    try {
      const casos = ["5512345678", "55 1234-5678", "+52 55 1234 5678", "521 55 1234 5678", "(55) 1234.5678", "123", "abc", "", "52 1234567890 1", "+1 555 123 4567", "55123456789"];
      const base = await db.q("select x, public.telefono_mx_10(x) r from unnest($1::text[]) x", [casos]);
      const iguales = base.every(({ x, r }) => (telefonoMx10(x) ?? null) === r);
      revisar(iguales, "telefonoMx10 (pantalla) = telefono_mx_10 (base) en 11 casos", JSON.stringify(base.map(({ x, r }) => [x, r, telefonoMx10(x)])));
    } finally {
      await db.fin();
    }
  }

  // =========================================================================
  // 2. Base: matriz (la de create-staff) con invitaciones_importar
  // =========================================================================
  const admin = await cuenta("admin", { role: "admin" });
  const dueno = await cuenta("dueno", { role: "dueno" });
  const duenoB = await cuenta("duenob", { role: "dueno" });
  const A = await antro("A", dueno.id);
  const B = await antro("B", duenoB.id);
  const gerente = await cuenta("gerente", { role: "gerente", club: A });
  const staff = await cuenta("staff", { role: "staff", club: A });
  const rp = await cuenta("rp", { role: "rp", club: A });
  const cliente = await cuenta("cliente", { role: "cliente" });
  const sinPerfil = await cuenta("sinperfil");
  const gerenteBaja = await cuenta("gerentebaja", { role: "gerente", club: A, activo: false });
  const gerenteTemp = await cuenta("gerentetemp", { role: "gerente", club: A, meta: { debe_cambiar: true } });
  const gerenteB = await cuenta("gerenteb", { role: "gerente", club: B });

  const n0 = (await invitacionesDe(A)).length;
  const casos = [
    ["el dueño de otro antro (RP)", duenoB, "rp"],
    ["el gerente (staff)", gerente, "staff"],
    ["el gerente (gerente)", gerente, "gerente"],
    ["el staff (staff)", staff, "staff"],
    ["un gerente de otro antro (RP)", gerenteB, "rp"],
    ["un RP (RP)", rp, "rp"],
    ["un cliente (RP)", cliente, "rp"],
    ["una cuenta sin perfil (RP)", sinPerfil, "rp"],
    ["un gerente dado de baja (RP)", gerenteBaja, "rp"],
    ["un gerente con contraseña temporal (RP)", gerenteTemp, "rp"],
  ];
  for (const [quien, s, rol] of casos) {
    const r = await importar(s.c, A, rol, filasDe("m" + rol, 2));
    revisar(!!r.error && (await invitacionesDe(A)).length === n0, `${quien}: no`, r.error?.message ?? "pasó");
  }
  {
    const r = await importar(anon(), A, "rp", filasDe("anon", 1));
    revisar(!!r.error && (await invitacionesDe(A)).length === n0, "anónimo: no");
    const ok = [
      ["el dueño invita gerentes", dueno, "gerente", "dg"],
      ["el dueño invita staff", dueno, "staff", "ds"],
      ["el dueño invita RPs", dueno, "rp", "dr"],
      ["el gerente invita RPs", gerente, "rp", "gr"],
      ["el staff invita RPs", staff, "rp", "sr"],
      ["el admin invita staff en cualquier antro", admin, "staff", "as"],
    ];
    for (const [t, s, rol, p] of ok) {
      const x = await importar(s.c, A, rol, filasDe(p, 2, true));
      revisar(!x.error && x.data?.creadas === 2 && x.data?.repetido === false, t, x.error?.message);
    }
    const inv = await invitacionesDe(A);
    revisar(inv.length === n0 + 12 && inv.every((i) => /^55\d{8}$/.test(i.telefono) && i.lote_id && !i.token_emitido_en), "12 invitaciones con teléfono, marca de lote y sin token todavía");
  }

  // =========================================================================
  // 3. Todo o nada, choques e idempotencia
  // =========================================================================
  {
    const antes = (await invitacionesDe(A)).length;
    const mala = [...filasDe("tn", 3), { linea: 4, nombre: "Mala", correo: "mala@", telefono: null }];
    const r = await importar(dueno.c, A, "rp", mala);
    revisar(!!r.error && /Línea 4/.test(r.error.message) && (await invitacionesDe(A)).length === antes, "una fila mala (correo): no se guarda ninguna y dice la línea", r.error?.message);
    const r2 = await importar(dueno.c, A, "rp", [...filasDe("tt", 2), { linea: 3, nombre: "Tel", correo: correoDe("tel"), telefono: "12345" }]);
    revisar(!!r2.error && /Línea 3:.*teléfono/.test(r2.error.message), "la base rechaza un teléfono malo con su línea", r2.error?.message);
    const r3 = await importar(dueno.c, A, "rp", [
      { linea: 1, nombre: "Uno", correo: correoDe("dup"), telefono: null },
      { linea: 2, nombre: "Dos", correo: correoDe("dup").toUpperCase(), telefono: null },
    ]);
    revisar(!!r3.error && /Línea 2:.*repetido/.test(r3.error.message), "la base rechaza un correo repetido (otras mayúsculas)", r3.error?.message);
    // Choca con una pendiente (la dr1 del dueño).
    const r4 = await importar(gerente.c, A, "rp", [...filasDe("ch", 2), { linea: 7, nombre: "Ya invitada", correo: correoDe("dr1"), telefono: null }]);
    revisar(!!r4.error && /Línea 7:.*pendiente/.test(r4.error.message) && (await invitacionesDe(A)).length === antes, "un correo con invitación pendiente: nada, y dice la línea", r4.error?.message);
    // Ya es del equipo de ESTE antro (el staff) → no; de OTRO antro (gerenteB) → sí (no se revela).
    const r5 = await importar(gerente.c, A, "rp", [{ linea: 2, nombre: "Staff", correo: ids.staff.email, telefono: null }]);
    revisar(!!r5.error && /Línea 2:.*equipo de este antro/.test(r5.error.message), "un correo que ya es del equipo de este antro: no", r5.error?.message);
    const r5b = await importar(dueno.c, A, "rp", [{ linea: 1, nombre: "Dueño", correo: ids.dueno.email, telefono: null }]);
    revisar(!!r5b.error && /equipo de este antro/.test(r5b.error.message), "el correo del dueño del antro tampoco");
    const r6 = await importar(gerente.c, A, "rp", [{ linea: 1, nombre: "De otro antro", correo: ids.gerenteb.email, telefono: null }]);
    revisar(!r6.error, "un correo con cuenta en OTRO antro no se distingue de uno nuevo (no sirve para averiguar cuentas)", r6.error?.message);

    const lote = randomUUID();
    const f = filasDe("idem", 3);
    const x1 = await importar(gerente.c, A, "rp", f, lote);
    const x2 = await importar(gerente.c, A, "rp", f, lote);
    const enLote = (await invitacionesDe(A)).filter((i) => i.lote_id === lote).length;
    revisar(!x1.error && x2.data?.repetido === true && x2.data?.creadas === 3 && enLote === 3, "el mismo lote dos veces: la segunda responde «repetido» y no duplica", JSON.stringify([x1.error, x2.error ?? x2.data]));
    const x3 = await importar(dueno.c, A, "rp", f, lote);
    revisar(!!x3.error && /ya se usó/.test(x3.error.message), "la clave de otro usuario no sirve", x3.error?.message);
    const x4 = await importar(gerente.c, A, "rp", [{ linea: 1, nombre: "Nadie", correo: "nadie@example.com", telefono: null }], null);
    revisar(!!x4.error, "sin clave de importación: no");
    const x5 = await importar(dueno.c, A, "rp", filasDe("x5", 401));
    revisar(!!x5.error && /400/.test(x5.error.message), "la base limita a 400 filas", x5.error?.message);

    // 5 lotes por persona por hora (el staff ya hizo 1).
    const lotes = [];
    for (let i = 0; i < 5; i++) lotes.push(await importar(staff.c, A, "rp", filasDe(`lim${i}`, 1)));
    revisar(lotes.slice(0, 4).every((y) => !y.error) && /5 importaciones por hora/.test(lotes[4].error?.message ?? ""), "límite de 5 importaciones por persona por hora", JSON.stringify(lotes.map((y) => y.error?.message ?? "ok")));

    // 400 pendientes por antro (en B, que está vacío).
    const g400 = await importar(duenoB.c, B, "rp", filasDe("p", 400));
    const g401 = await importar(gerenteB.c, B, "rp", filasDe("q", 1));
    revisar(!g400.error && g400.data?.creadas === 400 && /pasaría de 400/.test(g401.error?.message ?? ""), "400 pendientes por antro, contando las del lote", JSON.stringify([g400.error, g401.error?.message]));

    // Tokens del lote: solo el servidor; una sola vez.
    const loteT = randomUUID();
    await importar(dueno.c, A, "rp", filasDe("tok", 3), loteT);
    const t1 = await dueno.c.rpc("invitaciones_emitir_tokens_lote", { p_lote_id: loteT });
    const t2 = await svc.rpc("invitaciones_emitir_tokens_lote", { p_lote_id: loteT });
    const t3 = await svc.rpc("invitaciones_emitir_tokens_lote", { p_lote_id: loteT });
    revisar(!!t1.error, "un usuario no puede emitir tokens");
    revisar(Array.isArray(t2.data) && t2.data.length === 3 && t2.data.every((t) => /^[0-9a-f]{64}$/.test(t.token)) && Array.isArray(t3.data) && t3.data.length === 0, "el servidor emite los 3 tokens una sola vez");
    const consulta = await svc.rpc("invitacion_consultar", { p_token: t2.data[0].token });
    revisar(consulta.data?.estado === "pendiente" && consulta.data?.club_id === A && consulta.data?.rol === "rp", "el token del lote abre su invitación");

    // RLS de la bitácora de lotes y columnas nuevas.
    const vistaDueno = await dueno.c.from("invitacion_lotes").select("id").eq("club_id", A);
    const vistaCliente = await cliente.c.from("invitacion_lotes").select("id");
    const vistaGerenteB = await gerenteB.c.from("invitacion_lotes").select("id").eq("club_id", A);
    revisar((vistaDueno.data?.length ?? 0) >= 8 && (vistaCliente.data?.length ?? 0) === 0 && (vistaGerenteB.data?.length ?? 0) === 0, "la bitácora de lotes la ve el dueño; ni un cliente ni otro antro", JSON.stringify([vistaDueno.data?.length, vistaCliente.data?.length, vistaGerenteB.data?.length]));
    const escribir = await dueno.c.from("invitacion_lotes").insert({ id: randomUUID(), club_id: A, rol: "rp", total: 1 });
    revisar(!!escribir.error, "nadie escribe la bitácora directo");
    const tel = await gerente.c.from("invitaciones").select("telefono, lote_id").eq("club_id", A).not("telefono", "is", null).limit(1);
    const hash = await gerente.c.from("invitaciones").select("token_hash").limit(1);
    revisar(!tel.error && tel.data?.length === 1 && !!hash.error, "el gerente lee teléfono y lote; token_hash sigue oculto");

    const db = await conectarDevEscritura();
    try {
      const f2 = await db.q(
        `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg,
                has_function_privilege('anon', p.oid, 'execute') anon,
                has_function_privilege('authenticated', p.oid, 'execute') auth
         from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('invitaciones_importar', 'invitaciones_emitir_tokens_lote', 'invitacion_aceptar')`,
      );
      const por = Object.fromEntries(f2.map((x) => [x.proname, x]));
      revisar(
        f2.length === 3 && f2.every((x) => x.prosecdef && x.cfg.includes("search_path=") && !x.anon) && por.invitaciones_importar.auth && !por.invitaciones_emitir_tokens_lote.auth && !por.invitacion_aceptar.auth,
        "funciones SECURITY DEFINER con search_path vacío; anon sin execute; emitir y aceptar solo el servidor",
      );
      const g = await db.q("select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'invitacion_lotes' and grantee in ('anon', 'authenticated')");
      revisar(g.length === 1 && g[0].grantee === "authenticated" && g[0].privilege_type === "SELECT", "invitacion_lotes: authenticated solo SELECT, anon nada", JSON.stringify(g));
    } finally {
      await db.fin();
    }
  }

  // =========================================================================
  // 3b. Cupos (sql 24): el lote cuenta, antro sin verificar, revocar con
  //     límite, volver a sacar los enlaces y la carrera de reenviar
  // =========================================================================
  {
    const crearSuelta = (s, club, p, rol = "rp") => s.c.rpc("invitacion_crear", { p_club_id: club, p_rol: rol, p_correo: correoDe(p), p_nombre: "Suelta " + p });
    const msg = (r) => r.error?.message ?? "pasó";
    const db = await conectarDevEscritura();
    try {
      // --- El lote cuenta para el total por persona (duenoB ya mandó 400 en lote esta hora).
      const e1 = await crearSuelta(duenoB, B, "traslote");
      const e2 = await importar(duenoB.c, B, "rp", filasDe("traslote2", 1));
      revisar(/400 invitaciones por hora/.test(msg(e1)) && /400 invitaciones por hora/.test(msg(e2)), "un lote de 400 cuenta: esa hora ya no pasa ni una suelta ni otro lote", msg(e1) + " / " + msg(e2));
      const [{ n: filasLote }] = await db.q("select count(*)::int n from public.invitacion_envios e join public.invitaciones i on i.id = e.invitacion_id where i.club_id = $1 and e.tipo = 'lote'", [B]);
      revisar(filasLote === 400, "cada invitación del lote deja su fila en la bitácora de envíos", String(filasLote));

      // --- Las 30 sueltas por hora siguen igual; el lote no se come ese cupo.
      const g1 = await crearSuelta(gerente, A, "gsuelta1");
      revisar(!g1.error, "el gerente (con lotes esta hora) todavía manda una suelta", msg(g1));
      await svc.from("invitacion_envios").insert(Array.from({ length: 29 }, () => ({ invitacion_id: g1.data, hecho_por: gerente.id, tipo: "reenviar" })));
      const g2 = await crearSuelta(gerente, A, "gsuelta2");
      revisar(/30 invitaciones por hora/.test(msg(g2)), "con 30 sueltas en la hora, la 31 no pasa", msg(g2));

      // --- 1,000 por persona por día y 800 por antro por día (antro D aparte).
      const duenoD = await cuenta("duenod", { role: "dueno" });
      const D = await antro("D", duenoD.id);
      const gerenteD = await cuenta("gerented", { role: "gerente", club: D });
      const { data: invD } = await svc.from("invitaciones").insert({ club_id: D, rol: "rp", correo: correoDe("dbase"), nombre: "Base D", invitado_por: duenoD.id }).select("id").single();
      await db.q("insert into public.invitacion_envios (invitacion_id, hecho_por, tipo, hecho_en) select $1, $2, 'lote', now() - interval '2 hours' from generate_series(1, 1000)", [invD.id, duenoD.id]);
      const d1 = await crearSuelta(duenoD, D, "d1");
      revisar(/1,000 invitaciones por día/.test(msg(d1)), "1,000 por persona por día (sumando las de horas anteriores)", msg(d1));
      const d2 = await crearSuelta(gerenteD, D, "d2");
      const d3 = await importar(gerenteD.c, D, "rp", filasDe("d3", 1));
      revisar(/800 invitaciones por día/.test(msg(d2)) && /800 invitaciones por día/.test(msg(d3)), "800 por antro por día, de quien sea (otra persona del mismo antro tampoco)", msg(d2) + " / " + msg(d3));

      // --- Antro sin verificar: 20 al día (por antro y por persona, sumando sus antros sin verificar).
      const duenoU = await cuenta("duenou", { role: "dueno" });
      const U1 = await antro("U1", duenoU.id, false);
      const U2 = await antro("U2", duenoU.id, false);
      const u21 = await importar(duenoU.c, U1, "rp", filasDe("u21", 21));
      revisar(/no esté verificado/.test(msg(u21)), "antro sin verificar: un lote de 21 no pasa", msg(u21));
      const u20 = await importar(duenoU.c, U1, "rp", filasDe("u20", 20));
      revisar(!u20.error && u20.data?.creadas === 20, "antro sin verificar: 20 sí", msg(u20));
      const u1 = await crearSuelta(duenoU, U1, "u1");
      revisar(/no esté verificado/.test(msg(u1)), "antro sin verificar: la 21 (suelta) no pasa", msg(u1));
      const invU = (await invitacionesDe(U1)).slice(0, 5);
      const revs = [];
      for (const i of invU) revs.push(await duenoU.c.rpc("invitacion_revocar", { p_id: i.id }));
      const u1b = await crearSuelta(duenoU, U1, "u1b");
      revisar(revs.every((x) => !x.error) && /no esté verificado/.test(msg(u1b)), "revocar no devuelve cupo (cuenta lo enviado, no lo pendiente)", msg(u1b));
      const u2 = await importar(duenoU.c, U2, "rp", filasDe("u2", 1));
      revisar(/no esté verificado/.test(msg(u2)), "un segundo antro sin verificar del mismo dueño no da cupo nuevo", msg(u2));
      const u2a = await importar(admin.c, U2, "rp", filasDe("u2a", 3));
      revisar(!u2a.error, "el admin sí invita en un antro sin verificar", msg(u2a));

      // --- Revocar: 150 por persona por hora (ya revocó 5).
      const [{ n: filasRev }] = await db.q("select count(*)::int n from public.invitacion_envios where hecho_por = $1 and tipo = 'revocar'", [duenoU.id]);
      await db.q("insert into public.invitacion_envios (invitacion_id, hecho_por, tipo) select $1, $2, 'revocar' from generate_series(1, 145)", [invU[0].id, duenoU.id]);
      const otra = (await invitacionesDe(U1)).find((i) => !invU.some((x) => x.id === i.id));
      const r151 = await duenoU.c.rpc("invitacion_revocar", { p_id: otra.id });
      revisar(filasRev === 5 && /150 invitaciones revocadas por hora/.test(msg(r151)), "revocar deja su fila y tiene límite de 150 por hora", `${filasRev} / ${msg(r151)}`);

      // --- Volver a sacar los enlaces de un lote (el loteT del dueño, ya emitido).
      const loteT = (await invitacionesDe(A)).find((i) => i.correo === correoDe("tok1"))?.lote_id;
      const { data: tokAntes } = await svc.from("invitaciones").select("id, token_emitido_en").eq("lote_id", loteT);
      const ajeno = await gerente.c.rpc("invitaciones_reemitir_lote", { p_lote_id: loteT });
      const sinSesion = await anon().rpc("invitaciones_reemitir_lote", { p_lote_id: loteT });
      revisar(/No encontramos/.test(msg(ajeno)) && !!sinSesion.error, "solo quien importó vuelve a sacar los enlaces (ni otro del antro ni anónimo)", msg(ajeno) + " / " + msg(sinSesion));
      const re1 = await dueno.c.rpc("invitaciones_reemitir_lote", { p_lote_id: loteT });
      revisar(!re1.error && re1.data?.pendientes === 3 && tokAntes?.length === 3 && tokAntes.every((t) => t.token_emitido_en), "volver a sacar: 3 pendientes", msg(re1));
      const { data: viejos } = await svc.from("invitaciones").select("token_hash").eq("lote_id", loteT);
      const nuevos = await svc.rpc("invitaciones_emitir_tokens_lote", { p_lote_id: loteT });
      const consNuevo = await svc.rpc("invitacion_consultar", { p_token: nuevos.data?.[0]?.token ?? "" });
      revisar(viejos.every((v) => v.token_hash === null) && nuevos.data?.length === 3 && consNuevo.data?.estado === "pendiente", "los enlaces anteriores dejan de servir y el servidor emite 3 nuevos que sí abren", JSON.stringify([nuevos.error, consNuevo.data?.estado]));
      const [{ n: filasRelote }] = await db.q("select count(*)::int n from public.invitacion_envios e join public.invitaciones i on i.id = e.invitacion_id where i.lote_id = $1 and e.tipo = 'relote'", [loteT]);
      revisar(filasRelote === 3, "cuenta como 3 envíos de lote en la bitácora", String(filasRelote));
      const re2 = await dueno.c.rpc("invitaciones_reemitir_lote", { p_lote_id: loteT });
      const re3 = await dueno.c.rpc("invitaciones_reemitir_lote", { p_lote_id: loteT });
      const re4 = await dueno.c.rpc("invitaciones_reemitir_lote", { p_lote_id: loteT });
      revisar(!re2.error && !re3.error && /3 veces/.test(msg(re4)), "hasta 3 veces por lote", [re2, re3, re4].map(msg).join(" / "));
      const loteIdem = (await invitacionesDe(A)).find((i) => i.correo === correoDe("idem1"))?.lote_id;
      await db.q("update public.invitacion_lotes set hecho_en = now() - interval '25 hours' where id = $1", [loteIdem]);
      const viejo = await gerente.c.rpc("invitaciones_reemitir_lote", { p_lote_id: loteIdem });
      revisar(/24 horas/.test(msg(viejo)), "un lote de hace más de 24 horas ya no", msg(viejo));
      const invDr = (await invitacionesDe(A)).filter((i) => /_dr\d+_/.test(i.correo));
      for (const i of invDr) await dueno.c.rpc("invitacion_revocar", { p_id: i.id });
      const vacio = await dueno.c.rpc("invitaciones_reemitir_lote", { p_lote_id: invDr[0].lote_id });
      revisar(invDr.length === 2 && /No queda ninguna/.test(msg(vacio)), "un lote sin pendientes: avisa", msg(vacio));

      // --- Carrera: reenviar una vencida y crear una nueva al mismo correo, a la vez.
      const correoCarrera = correoDe("carrera");
      const { data: vencida } = await svc
        .from("invitaciones")
        .insert({ club_id: A, rol: "rp", correo: correoCarrera, nombre: "Carrera", invitado_por: dueno.id, creada_en: new Date(Date.now() - 4 * 86400_000).toISOString(), expira_en: new Date(Date.now() - 86400_000).toISOString() })
        .select("id")
        .single();
      const c1 = await conectarDevEscritura();
      const c2 = await conectarDevEscritura();
      const comoUsuario = async (c, id) => {
        await c.q("begin");
        await c.q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated" })]);
        await c.q("set local role authenticated");
      };
      try {
        await comoUsuario(c1, dueno.id);
        await c1.q("select public.invitacion_reenviar($1)", [vencida.id]);
        await comoUsuario(c2, staff.id);
        let resuelta = false;
        const segunda = c2
          .q("select public.invitacion_crear($1, 'rp', $2, 'Carrera 2')", [A, correoCarrera])
          .then(() => "pasó", (e) => e.message)
          .finally(() => (resuelta = true));
        await new Promise((r) => setTimeout(r, 1500));
        const esperaba = !resuelta;
        await c1.q("commit");
        const m2 = await segunda;
        await c2.q("rollback").catch(() => {});
        const [{ n: pendientes }] = await db.q("select count(*)::int n from public.invitaciones where club_id = $1 and correo = $2 and aceptada_en is null and revocada_en is null and expira_en > now()", [A, correoCarrera]);
        revisar(esperaba && /pendiente/.test(m2) && pendientes === 1, "reenviar y crear al mismo correo a la vez: la segunda espera el candado y no deja dos pendientes", JSON.stringify({ esperaba, m2, pendientes }));
      } finally {
        await c1.q("rollback").catch(() => {});
        await c2.q("rollback").catch(() => {});
        await c1.fin();
        await c2.fin();
      }

      // --- Permisos de las funciones nuevas.
      const f = await db.q(
        `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg,
                has_function_privilege('anon', p.oid, 'execute') anon,
                has_function_privilege('authenticated', p.oid, 'execute') auth,
                has_function_privilege('service_role', p.oid, 'execute') svc
         from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('invitacion_revisar_cupo', 'invitaciones_reemitir_lote')`,
      );
      const por = Object.fromEntries(f.map((x) => [x.proname, x]));
      revisar(
        f.length === 2 && f.every((x) => x.prosecdef && x.cfg.includes("search_path=") && !x.anon) && !por.invitacion_revisar_cupo.auth && !por.invitacion_revisar_cupo.svc && por.invitaciones_reemitir_lote.auth,
        "revisar_cupo es interna (nadie la llama desde la API); reemitir: SECURITY DEFINER, search_path vacío, sin anon",
        JSON.stringify(f),
      );
    } finally {
      await db.fin();
    }
  }

  // =========================================================================
  // 4. La ruta (servidor local)
  // =========================================================================
  if (BASE) {
    const duenoC = await cuenta("duenoc", { role: "dueno" });
    const C = await antro("C", duenoC.id);
    const gerenteC = await cuenta("gerentec", { role: "gerente", club: C });
    const rpC = await cuenta("rpc", { role: "rp", club: C });
    const tempC = await cuenta("tempc", { role: "gerente", club: C, meta: { debe_cambiar: true } });
    const cuerpo = (filas, extra = {}) => ({ club_id: C, rol: "rp", lote_id: randomUUID(), filas, ...extra });

    const sinSesion = await post("/api/equipo/importar", cuerpo(filasDe("h0", 1)));
    revisar(sinSesion.status === 401, "sin sesión: 401", String(sinSesion.status));
    const lg = await login(gerenteC.email);
    const lr = await login(rpC.email);
    const lt = await login(tempC.email);
    revisar(lg.status === 200 && !!lg.galletas, "el gerente inicia sesión", String(lg.status));
    const deRp = await post("/api/equipo/importar", cuerpo(filasDe("h1", 1)), lr.galletas);
    revisar(deRp.status === 403, "un RP: 403", String(deRp.status));
    const deTemp = await post("/api/equipo/importar", cuerpo(filasDe("h2", 1)), lt.galletas);
    revisar(deTemp.status === 403 || deTemp.status === 401, "con contraseña temporal: rechazado", String(deTemp.status));
    const staffDeGerente = await post("/api/equipo/importar", cuerpo(filasDe("h3", 1), { rol: "staff" }), lg.galletas);
    revisar(staffDeGerente.status === 403, "el gerente pidiendo staff: 403", String(staffDeGerente.status));
    const clubAjeno = await post("/api/equipo/importar", cuerpo(filasDe("h4", 1), { club_id: A }), lg.galletas);
    revisar(clubAjeno.status === 403 && (await invitacionesDe(A)).every((i) => !i.correo.startsWith("t_equipo_h4")), "club_id de otro antro en el cuerpo: 403 y nada guardado", String(clubAjeno.status));
    const malo = await post("/api/equipo/importar", "{no es json", lg.galletas);
    const malaFila = await post("/api/equipo/importar", cuerpo([{ linea: 5, nombre: "A", correo: "a@example.com", telefono: null }]), lg.galletas);
    revisar(malo.status === 400 && malaFila.status === 400 && /Línea 5/.test(malaFila.cuerpo.error ?? ""), "cuerpo inválido y fila mala: 400 con la línea", JSON.stringify([malo.status, malaFila.cuerpo]));

    // 130 RPs, con teléfono, en menos de 60 s.
    const lote = randomUUID();
    const f130 = filasDe("rp", 130, true);
    const t0 = Date.now();
    const r130 = await post("/api/equipo/importar", { club_id: C, rol: "rp", lote_id: lote, filas: f130 }, lg.galletas);
    const ms = Date.now() - t0;
    const invC = (await invitacionesDe(C)).filter((i) => i.lote_id === lote);
    const { count: enBandeja } = await svc.from("correos_salida").select("id", { count: "exact", head: true }).eq("plantilla", "invitacion:lote").eq("club_id", C);
    revisar(
      r130.status === 200 && r130.cuerpo.creadas === 130 && invC.length === 130 && invC.every((i) => i.token_emitido_en) && ms < 60_000,
      `130 RPs invitados en ${(ms / 1000).toFixed(1)} s (menos de 60 s), todos con token`,
      JSON.stringify({ status: r130.status, err: r130.cuerpo.error, n: invC.length }),
    );
    revisar(r130.cache?.includes("no-store"), "la respuesta no se guarda en caché");
    const c = r130.cuerpo.correos ?? {};
    revisar(enBandeja === 130 && c.archivados + c.enviados + c.fallidos + c.sinIntentar === 130, `un correo por persona en la bandeja (${enBandeja}); modo archivo: ${c.archivados} archivados`, JSON.stringify(c));
    const enl = r130.cuerpo.enlaces ?? [];
    revisar(enl.length === 130 - (c.enviados ?? 0) && enl.every((e) => /\/invitacion\/[0-9a-f]{64}$/.test(e.enlace)) && enl[0].correo === f130[0].correo, "los enlaces de los correos que no salieron vuelven, en el orden del archivo", String(enl.length));
    const otra = await post("/api/equipo/importar", { club_id: C, rol: "rp", lote_id: lote, filas: f130 }, lg.galletas);
    revisar(
      otra.status === 200 && otra.cuerpo.repetido === true && otra.cuerpo.lote_id === lote && (otra.cuerpo.enlaces ?? []).length === 0 && (await invitacionesDe(C)).filter((i) => i.lote_id === lote).length === 130,
      "reintento del mismo lote: «repetido», sin duplicar ni dar enlaces (pero con la clave del lote para sacarlos otra vez)",
    );

    // «Volver a sacar los enlaces» (respuesta perdida): sin sesión, otro rol
    // y cuerpo malo no; quien importó sí, con 130 enlaces nuevos en menos de 60 s.
    const reSin = await post("/api/equipo/importar/reemitir", { lote_id: lote });
    const reRp = await post("/api/equipo/importar/reemitir", { lote_id: lote }, lr.galletas);
    const reMalo = await post("/api/equipo/importar/reemitir", { lote_id: "no-es-uuid" }, lg.galletas);
    revisar(reSin.status === 401 && reRp.status === 403 && reMalo.status === 400, "volver a sacar: sin sesión 401, un RP 403, clave mala 400", JSON.stringify([reSin.status, reRp.status, reMalo.status]));
    const t1 = Date.now();
    const re = await post("/api/equipo/importar/reemitir", { lote_id: lote }, lg.galletas);
    const msRe = Date.now() - t1;
    const enlRe = re.cuerpo.enlaces ?? [];
    const viejoYa = await svc.rpc("invitacion_consultar", { p_token: enl[0].enlace.split("/").pop() });
    revisar(
      re.status === 200 && re.cuerpo.reemitido === true && enlRe.length === 130 - (re.cuerpo.correos?.enviados ?? 0) && enlRe.every((e) => /\/invitacion\/[0-9a-f]{64}$/.test(e.enlace)) && viejoYa.data === null && msRe < 60_000 && re.cache?.includes("no-store"),
      `volver a sacar los enlaces del lote de 130: ${enlRe.length} enlaces nuevos en ${(msRe / 1000).toFixed(1)} s y los anteriores ya no abren`,
      JSON.stringify({ status: re.status, err: re.cuerpo.error, n: enlRe.length }),
    );
    const { count: enBandeja2 } = await svc.from("correos_salida").select("id", { count: "exact", head: true }).eq("plantilla", "invitacion:lote").eq("club_id", C);
    revisar(enBandeja2 === 260, "y se vuelve a mandar un correo por persona (130 + 130 en la bandeja)", String(enBandeja2));

    // Aceptar una (con su enlace nuevo): el teléfono llega al perfil y entra como RP de C.
    const elegido = enlRe.find((e) => e.correo === enl[4].correo) ?? enlRe[4];
    const token = elegido.enlace.split("/").pop();
    const acepta = await post("/api/invitacion", { accion: "aceptar", token, password: PASS });
    const { data: u } = await svc.from("invitaciones").select("aceptada_por, telefono").eq("correo", elegido.correo).eq("club_id", C).single();
    const { data: perfil } = await svc.from("profiles").select("role, club_id, telefono").eq("id", u?.aceptada_por ?? randomUUID()).maybeSingle();
    revisar(acepta.status === 200 && perfil?.role === "rp" && perfil?.club_id === C && perfil?.telefono === u?.telefono && /^55\d{8}$/.test(perfil?.telefono ?? ""), "aceptar: perfil RP de ese antro con el teléfono del CSV", JSON.stringify([acepta.status, perfil]));
    const entra = await login(elegido.correo);
    revisar(entra.status === 200, "y puede iniciar sesión con la contraseña que eligió", String(entra.status));

    if (PANTALLA) await pantallas({ C, duenoC, gerenteC });
  } else {
    console.log("(sin --base: no se prueba la ruta)");
  }
} catch (e) {
  fallan++;
  console.log("FALLA  error inesperado: " + (e?.stack ?? e));
} finally {
  await limpiar();
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  process.exit(fallan ? 1 : 0);
}

// ---------- Pantalla ----------
async function pantallas({ C, duenoC, gerenteC }) {
  if (!process.env.PLAYWRIGHT_DESDE) {
    console.log("Falta PLAYWRIGHT_DESDE: no se revisan pantallas.");
    return;
  }
  const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
  const carpeta = path.join(RAIZ, "screenshots-b-equipo");
  mkdirSync(carpeta, { recursive: true });
  const navegador = await chromium.launch();
  try {
    for (const [ancho, alto] of [
      [390, 844],
      [360, 740],
    ]) {
      for (const [quien, s, ruta] of [
        ["dueno", duenoC, "/dueno/equipo"],
        ["gerente", gerenteC, "/staff/equipo"],
      ]) {
        const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, extraHTTPHeaders: { "x-forwarded-for": nuevaIp() } });
        await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
        const page = await ctx.newPage();
        const errores = [];
        page.on("pageerror", (e) => errores.push(e.message));
        await page.goto(BASE + (quien === "dueno" ? "/dueno/login" : "/cliente/login"));
        await page.fill("#email", s.email);
        await page.fill("#password", PASS);
        await page.click("button[type=submit]");
        await page.waitForURL(/\/(dueno|staff)\/panel/, { timeout: 60000 });
        await page.goto(BASE + ruta);
        await page.getByText("Invitar en lote (CSV)").waitFor({ timeout: 30000 });
        // Lista con un error: se ve por línea y no deja invitar.
        const pref = `pt${quien}${ancho}`;
        const conError = `nombre,correo,teléfono\nAna ${pref},${correoDe(pref + "a")},55 1234 5678\nBeto,beto@\n`;
        await page.fill("#lote-texto", conError);
        await page.getByRole("button", { name: "Revisar", exact: true }).nth(0).click();
        await page.getByText("Línea 3: revisa el correo").waitFor({ timeout: 10000 });
        const deshabilitado = await page.getByRole("button", { name: /^Invitar a 1 como/ }).isDisabled();
        revisar(deshabilitado, `${ancho}px ${quien}: con una línea mala no deja invitar`);
        await page.screenshot({ path: path.join(carpeta, `b1-lote-error-${quien}-${ancho}.png`), fullPage: true });
        // Lista buena: 3 personas (una sin teléfono).
        const buena = `Ana ${pref},${correoDe(pref + "a")},55 1234 5678\nLuis ${pref},${correoDe(pref + "b")}\nEva ${pref},${correoDe(pref + "c")},+52 33 1234 5678\n`;
        await page.fill("#lote-texto", buena);
        await page.getByRole("button", { name: "Revisar", exact: true }).nth(0).click();
        await page.getByText("3 personas listas").waitFor({ timeout: 10000 });
        await page.screenshot({ path: path.join(carpeta, `b1-lote-vista-previa-${quien}-${ancho}.png`), fullPage: true });
        await page.getByRole("button", { name: /^Invitar a 3 como RP/ }).click();
        await page.getByText("Listo: 3 invitaciones creadas").waitFor({ timeout: 30000 });
        const wa = await page.locator("a", { hasText: "WhatsApp" }).evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
        revisar(wa.length === 2 && wa.every((h) => /^https:\/\/wa\.me\/52\d{10}\?text=.*invitacion/.test(h)), `${ancho}px ${quien}: 3 creadas; WhatsApp (con el enlace) solo para los 2 con teléfono`, JSON.stringify(wa.map((h) => h.slice(0, 40))));
        await page.getByRole("button", { name: /^Copiar los 3 enlaces/ }).click();
        await page.getByRole("button", { name: "Copiado" }).first().waitFor({ timeout: 5000 }).catch(() => {});
        const copiado = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => "ERROR " + e.message);
        // El portapapeles de Windows devuelve CRLF.
        const lineas = copiado.split(/\r?\n/);
        revisar(lineas.length === 3 && lineas.every((l) => /\t\/?.*\/invitacion\/[0-9a-f]{64}$/.test(l)), `${ancho}px ${quien}: «Copiar los 3 enlaces» copia una línea por persona`, JSON.stringify(copiado.slice(0, 160)));
        // La lista de invitaciones de arriba se recarga sola.
        await page.getByText(`Ana ${pref}`).first().waitFor({ timeout: 10000 });
        // «Volver a sacar los enlaces» desde «Tus importaciones de las últimas 24 horas» (la más nueva primero).
        const seccion = page.getByRole("region", { name: "Tus importaciones de las últimas 24 horas" });
        await seccion.waitFor({ timeout: 10000 });
        // El de esta lista (3 personas, el más nuevo): la sección se recarga
        // después de importar; a 360 px ya está también el de 390.
        const de3 = seccion.getByRole("listitem").filter({ hasText: "3 personas como RP" });
        const esperados = ancho === 390 ? 1 : 2;
        for (let i = 0; i < 50 && (await de3.count()) < esperados; i++) await page.waitForTimeout(200);
        await de3.first().getByRole("button", { name: "Volver a sacar los enlaces" }).click();
        await page.getByRole("button", { name: "Sí, sacar enlaces nuevos" }).waitFor({ timeout: 5000 });
        await page.screenshot({ path: path.join(carpeta, `b1-lote-reemitir-confirmar-${quien}-${ancho}.png`), fullPage: true });
        await page.getByRole("button", { name: "Sí, sacar enlaces nuevos" }).click();
        const okRe = await page.getByText("Enlaces nuevos para 3 invitaciones pendientes").waitFor({ timeout: 30000 }).then(() => true, () => false);
        const waRe = await page.locator("a", { hasText: "WhatsApp" }).count();
        revisar(okRe && waRe === 2, `${ancho}px ${quien}: «Volver a sacar los enlaces» (con confirmación) muestra 3 enlaces nuevos`, String(waRe));
        if (quien === "gerente" && ancho === 390) {
          // La lista de invitaciones por páginas: las 130 del lote se ven todas.
          const { count: totalC } = await svc.from("invitaciones").select("id", { count: "exact", head: true }).eq("club_id", C);
          await page.getByRole("button", { name: `Ver todas (${totalC})` }).click();
          await page.getByRole("button", { name: /^Ver más \(faltan \d+\)$/ }).click();
          await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((b) => /^(Ver más|Cargando…)/.test(b.textContent ?? "")), null, { timeout: 15000 });
          const del130 = await page.getByText(/^t_equipo_rp\d+_/).count();
          revisar(totalC > 100 && del130 === 130, `lista de invitaciones por páginas: «Ver todas (${totalC})» y «Ver más» muestran las 130 del lote`, String(del130));
          await page.screenshot({ path: path.join(carpeta, `b1-lista-paginas-${ancho}.png`) });
        }
        await revisarPagina(page, `${ancho}px ${quien} /equipo (lote)`, errores);
        await page.screenshot({ path: path.join(carpeta, `b1-lote-resultado-${quien}-${ancho}.png`), fullPage: true });
        await ctx.close();
      }

      // Mesas desde el panel del dueño.
      const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, extraHTTPHeaders: { "x-forwarded-for": nuevaIp() } });
      const page = await ctx.newPage();
      const errores = [];
      page.on("pageerror", (e) => errores.push(e.message));
      await page.goto(BASE + "/dueno/login");
      await page.fill("#email", duenoC.email);
      await page.fill("#password", PASS);
      await page.click("button[type=submit]");
      await page.waitForURL(/\/dueno\/panel/, { timeout: 60000 });
      const abrir = page.getByRole("button", { name: "Importar mesas desde CSV" });
      await abrir.waitFor({ timeout: 30000 });
      await abrir.scrollIntoViewIfNeeded();
      await abrir.click();
      const sufMesa = ancho === 390 ? "" : " B";
      // Primero por archivo (el botón «Elegir archivo»), con una línea mala.
      await page.setInputFiles("#mesas-archivo", { name: "mesas.csv", mimeType: "text/csv", buffer: Buffer.from(`mesa,capacidad\n1${sufMesa},8\n2${sufMesa},0\nVIP${sufMesa},15`) });
      await page.waitForFunction(() => document.querySelector("#mesas-texto")?.value.includes("VIP"), null, { timeout: 5000 });
      await page.getByRole("button", { name: "Revisar", exact: true }).click();
      await page.getByText("Línea 3: la capacidad").waitFor({ timeout: 10000 });
      await page.locator("#mesas-texto").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(carpeta, `b1-mesas-error-${ancho}.png`), fullPage: true });
      await page.fill("#mesas-texto", `mesa,capacidad\n1${sufMesa},8\n2${sufMesa},10\nVIP${sufMesa},15`);
      await page.getByRole("button", { name: "Revisar", exact: true }).click();
      await page.getByText(/3 nuevas · 0 cambian de capacidad/).waitFor({ timeout: 10000 });
      // La tarjeta del importador (el panel completo es muy largo para leerlo en una captura).
      await page.locator("#mesas-texto").evaluate((el) => el.closest("[data-slot=card]")?.setAttribute("data-prueba", "importar-mesas"));
      const tarjeta = page.locator("[data-prueba=importar-mesas]");
      await tarjeta.screenshot({ path: path.join(carpeta, `b1-mesas-vista-previa-${ancho}.png`) });
      await page.getByRole("button", { name: "Importar 3 cambios" }).click();
      await page.getByText(/Listo: 3 mesas nuevas/).waitFor({ timeout: 20000 });
      // Segunda pasada: cambia la capacidad de una.
      await page.fill("#mesas-texto", `1${sufMesa},12`);
      await page.getByRole("button", { name: "Revisar", exact: true }).click();
      await page.getByText("8 → 12 pers.").waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Importar 1 cambios" }).click();
      await page.getByText(/Listo: 0 mesas nuevas y 1 con capacidad cambiada/).waitFor({ timeout: 20000 });
      const { data: m } = await svc.from("club_tables").select("numero, capacidad").eq("club_id", C);
      const una = m?.find((x) => x.numero === `1${sufMesa}`);
      revisar(una?.capacidad === 12, `${ancho}px dueño: importa 3 mesas y luego cambia la capacidad de una`, JSON.stringify(m));
      // Los controles del resto del panel (verificación, fotos) son de antes y
      // no son de esta prueba: se revisa solo la tarjeta del importador.
      await revisarPagina(page, `${ancho}px dueño /dueno/panel (importar mesas)`, errores, "[data-prueba=importar-mesas]");
      await tarjeta.screenshot({ path: path.join(carpeta, `b1-mesas-tarjeta-${ancho}.png`) });
      await page.getByText(/Listo: 0 mesas nuevas/).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(carpeta, `b1-mesas-resultado-${ancho}.png`), fullPage: true });
      await ctx.close();
    }
  } finally {
    await navegador.close();
  }
}

async function revisarPagina(page, etiqueta, errores, alcance = null) {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  revisar(scroll <= 0, `${etiqueta}: sin scroll horizontal`, String(scroll));
  const chicos = await page.evaluate(
    (sel) =>
      [...(sel ? (document.querySelector(sel) ?? document) : document).querySelectorAll("button, a, input, select, textarea")]
        // Fuera el indicador de Next en modo desarrollo (no existe en producción).
        // (el input de archivo va oculto dentro de su botón de 40 px)
        .filter((e) => e.offsetParent !== null && !e.closest("nextjs-portal") && !e.classList.contains("sr-only"))
        .map((e) => ({ t: (e.textContent || e.id || e.tagName).trim().slice(0, 30), h: e.getBoundingClientRect().height }))
        .filter((x) => x.h < 40),
    alcance,
  );
  revisar(chicos.length === 0, `${etiqueta}: controles de 40 px o más`, JSON.stringify(chicos.slice(0, 6)));
  revisar(errores.length === 0, `${etiqueta}: sin errores de página`, errores.join(" | "));
}

async function limpiar() {
  const patron = `t_equipo_%_${sufijo}@example.com`;
  const db = await conectarDevEscritura();
  let cuentas = [];
  try {
    cuentas = (await db.q("select id from auth.users where email like $1", [patron])).map((r) => r.id);
    const clubIds = Object.values(clubes);
    await db.q("begin");
    await db.q("delete from public.invitaciones where correo like $1 or club_id = any($2::uuid[])", [patron, clubIds]);
    await db.q("delete from public.invitacion_lotes where club_id = any($1::uuid[])", [clubIds]);
    if (IPS.length) await db.q("delete from public.invitacion_intentos where ip_hash = any($1::text[])", [IPS.map(hashIp)]);
    await db.q("delete from public.correos_salida where destinatario like $1", [patron]);
    await db.q("delete from public.club_tables where club_id = any($1::uuid[])", [clubIds]);
    await db.q("delete from public.profiles where id = any($1::uuid[])", [cuentas]);
    await db.q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    fallan++;
    console.log("FALLA  limpieza: " + e.message);
  } finally {
    await db.fin();
  }
  for (const id of cuentas) {
    const r = await svc.auth.admin.deleteUser(id);
    if (r.error) console.log("No se pudo borrar una cuenta de prueba: " + r.error.message);
  }
  const db2 = await conectarDevEscritura();
  try {
    const [{ n }] = await db2.q("select count(*)::int as n from auth.users where email like $1", [patron]);
    const [{ m }] = await db2.q("select count(*)::int as m from public.invitaciones where correo like $1", [patron]);
    const [{ k }] = await db2.q("select count(*)::int as k from public.correos_salida where destinatario like $1", [patron]);
    console.log(`\nLimpieza: ${cuentas.length} cuentas y ${Object.keys(clubes).length} antros borrados; quedan ${n} cuentas, ${m} invitaciones y ${k} correos de esta corrida.`);
    if (n || m || k) fallan++;
  } finally {
    await db2.fin();
  }
}
