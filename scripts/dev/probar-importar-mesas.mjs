// Pruebas del importador de mesas por CSV (B1a):
// lib/domain/importar-mesas.ts (sin base) y mesas_importar con el índice
// único (sql/post-junta-2/22-importar-mesas.sql) contra antroapp-dev.
//
//   node scripts/dev/probar-importar-mesas.mjs
//
// Crea sus propios antros («T equipo …») y cuentas (t_equipo_…@example.com)
// y los borra al final, aunque algo falle. No toca datos de nadie más.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";
import { importarTs } from "./cargar-ts.mjs";

const { leerMesasCsv, compararMesas, filasParaBase, MAX_MESAS_CSV } = await importarTs("../../lib/domain/importar-mesas.ts", import.meta.url);

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const sufijo = randomUUID().slice(0, 8);
const PASS = "Prueba-" + randomUUID();
const usuarios = [];
const clubes = [];

async function sesion(email) {
  for (let intento = 0; ; intento++) {
    const c = anon();
    const { error } = await c.auth.signInWithPassword({ email, password: PASS });
    if (!error) return c;
    if (!/rate limit/i.test(error.message) || intento >= 6) throw new Error("login " + email + ": " + error.message);
    console.log("(límite de Supabase Auth; espero 30 s)");
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
async function cuenta(clave, { role = null, club = null, activo = true, meta = null } = {}) {
  const email = `t_equipo_${clave}_${sufijo}@example.com`;
  const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true, ...(meta ? { app_metadata: meta } : {}) });
  if (u.error) throw new Error(`crear ${clave}: ${u.error.message}`);
  usuarios.push(u.data.user.id);
  if (role) {
    const p = await svc.from("profiles").insert({ id: u.data.user.id, nombre: `T equipo ${clave}`, role, club_id: club, activo });
    if (p.error) throw new Error(`perfil ${clave}: ${p.error.message}`);
  }
  return { id: u.data.user.id, c: await sesion(email) };
}
async function antro(nombre, duenoId = null) {
  const { data, error } = await svc
    .from("clubs")
    .insert({ nombre: `T equipo ${nombre} ${sufijo}`, direccion: "Calle de prueba 1", horario: "Vie", dueno_id: duenoId })
    .select("id")
    .single();
  if (error) throw new Error("antro: " + error.message);
  clubes.push(data.id);
  return data.id;
}
const mesasDe = async (club) => (await svc.from("club_tables").select("id, numero, capacidad").eq("club_id", club).order("numero")).data ?? [];

try {
  // =========================================================================
  // 1. Lector (sin base)
  // =========================================================================
  {
    const a = leerMesasCsv("mesa,capacidad\n1,8\n2;8\nVIP 1,15\n");
    revisar(a.errores.length === 1 && /Línea 3/.test(a.errores[0]), "el separador lo fija la primera línea (la 3 con ; no cuadra)", JSON.stringify(a));
    const b = leerMesasCsv("﻿Mesa;Capacidad\r\n1;8\r\n\r\n\"Terraza; 2\";6\r\n");
    revisar(b.errores.length === 0 && b.filas.length === 2 && b.filas[1].numero === "Terraza; 2" && b.filas[1].linea === 4, "BOM, CRLF, encabezado, comillas y línea vacía", JSON.stringify(b));
    const c = leerMesasCsv("1\t8\n2\t10");
    revisar(c.errores.length === 0 && c.filas.map((f) => f.capacidad).join() === "8,10", "tabulador (copiado de una hoja de cálculo)");
    const d = leerMesasCsv("1,0\n2,101\n3,ocho\n,4\n" + "x".repeat(31) + ",4\n5,4,extra\n6,4\n 6 ,5");
    const t = d.errores.join(" | ");
    revisar(
      d.errores.length === 7 && /Línea 1:.*capacidad/.test(t) && /Línea 2:.*capacidad/.test(t) && /Línea 3:/.test(t) && /Línea 4:.*nombre/.test(t) &&
        /Línea 5:.*nombre/.test(t) && /Línea 6:.*dos columnas/.test(t) && /Línea 8:.*ya viene en la línea 7/.test(t),
      "capacidad 0, 101 y texto, nombre vacío o largo, columna de más y repetida (sin importar espacios) se rechazan por línea",
      t,
    );
    const e = leerMesasCsv(Array.from({ length: MAX_MESAS_CSV + 1 }, (_, i) => `M${i},4`).join("\n"));
    revisar(e.errores.some((x) => /Máximo 300/.test(x)), "máximo 300 mesas por archivo");
    const comp = compararMesas(leerMesasCsv("1,8\nvip 1,20\n3,4").filas, [
      { numero: "1", capacidad: 8 },
      { numero: "VIP 1", capacidad: 15 },
    ]);
    revisar(
      comp.nuevas === 1 && comp.actualizadas === 1 && comp.iguales === 1 && comp.totalDespues === 3 && comp.cambios[1].tipo === "capacidad" && comp.cambios[1].antes === 15,
      "vista previa: nueva, cambio de capacidad (sin importar mayúsculas) y sin cambio",
    );
  }

  // =========================================================================
  // 2. Base: quién puede
  // =========================================================================
  const admin = await cuenta("admin", { role: "admin" });
  const dueno = await cuenta("dueno", { role: "dueno" });
  const duenoAjeno = await cuenta("duenoajeno", { role: "dueno" });
  const club = await antro("Mesas", dueno.id);
  await antro("Ajeno", duenoAjeno.id);
  const gerente = await cuenta("gerente", { role: "gerente", club });
  const staff = await cuenta("staff", { role: "staff", club });
  const rp = await cuenta("rp", { role: "rp", club });
  const cliente = await cuenta("cliente", { role: "cliente" });
  const sinPerfil = await cuenta("sinperfil");
  const duenoBaja = await cuenta("duenobaja", { role: "dueno", activo: false });
  const duenoTemporal = await cuenta("duenotemp", { role: "dueno", meta: { debe_cambiar: true } });
  const clubBaja = await antro("Baja", duenoBaja.id);
  const clubTemporal = await antro("Temporal", duenoTemporal.id);

  const filas = filasParaBase(leerMesasCsv("mesa,capacidad\n1,8\n2,8\nVIP 1,15").filas);
  const imp = (c, cl = club, f = filas) => c.rpc("mesas_importar", { p_club_id: cl, p_filas: f });

  for (const [nombre, s] of [
    ["el dueño de otro antro", duenoAjeno],
    ["el gerente", gerente],
    ["el staff", staff],
    ["un RP", rp],
    ["un cliente", cliente],
    ["una cuenta sin perfil", sinPerfil],
  ]) {
    const r = await imp(s.c);
    revisar(!!r.error && (await mesasDe(club)).length === 0, `${nombre} no importa`, r.error?.message ?? "pasó");
  }
  {
    const r = await imp(duenoBaja.c, clubBaja);
    revisar(!!r.error && (await mesasDe(clubBaja)).length === 0, "un dueño dado de baja no importa ni en su antro", r.error?.message ?? "pasó");
    const t = await imp(duenoTemporal.c, clubTemporal);
    revisar(!!t.error && (await mesasDe(clubTemporal)).length === 0, "un dueño con contraseña temporal no importa", t.error?.message ?? "pasó");
    const a = await imp(anon());
    revisar(!!a.error && (await mesasDe(club)).length === 0, "anónimo no importa", a.error?.message ?? "pasó");
  }

  // =========================================================================
  // 3. Base: alta, actualización y todo o nada
  // =========================================================================
  {
    const r = await imp(dueno.c);
    const m = await mesasDe(club);
    revisar(!r.error && r.data?.creadas === 3 && r.data?.actualizadas === 0 && r.data?.total === 3 && m.length === 3, "el dueño importa 3 mesas nuevas", JSON.stringify(r.error ?? r.data));

    const r2 = await imp(dueno.c, club, filasParaBase(leerMesasCsv(" vip 1 ,20\n1,8\n4,6").filas));
    const m2 = await mesasDe(club);
    const vip = m2.find((x) => x.numero.toLowerCase() === "vip 1");
    revisar(
      !r2.error && r2.data?.creadas === 1 && r2.data?.actualizadas === 1 && r2.data?.iguales === 1 && m2.length === 4 && vip?.numero === "VIP 1" && vip?.capacidad === 20,
      "la repetida (otras mayúsculas y espacios) solo cambia capacidad; el nombre se queda; la igual no se toca",
      JSON.stringify(r2.error ?? r2.data),
    );
    revisar(m2.some((x) => x.numero === "2"), "las mesas que no vienen en el CSV no se borran");

    const r3 = await imp(admin.c, club, [{ linea: 1, numero: "5", capacidad: 4 }]);
    revisar(!r3.error && r3.data?.creadas === 1, "el admin importa en cualquier antro", r3.error?.message);

    const antes = (await mesasDe(club)).length;
    const r4 = await imp(dueno.c, club, [
      { linea: 2, numero: "6", capacidad: 4 },
      { linea: 3, numero: "7", capacidad: 0 },
    ]);
    revisar(!!r4.error && /Línea 3/.test(r4.error.message) && (await mesasDe(club)).length === antes, "una fila mala: no entra ninguna y el error dice la línea", r4.error?.message);
    const r5 = await imp(dueno.c, club, [
      { linea: 1, numero: "8", capacidad: 4 },
      { linea: 2, numero: " 8", capacidad: 5 },
    ]);
    revisar(!!r5.error && /repetida/.test(r5.error.message) && (await mesasDe(club)).length === antes, "repetida dentro del mismo envío: nada", r5.error?.message);
    const r6 = await imp(dueno.c, club, [{ linea: 1, numero: "9", capacidad: 4.5 }]);
    const r7 = await imp(dueno.c, club, [{ linea: 1, numero: "x".repeat(31), capacidad: 4 }]);
    const r8 = await imp(dueno.c, club, [{ linea: 1, numero: "10", capacidad: "4" }]);
    revisar(!!r6.error && !!r7.error && !!r8.error && (await mesasDe(club)).length === antes, "la base vuelve a validar: capacidad decimal o en texto y nombre largo");
    const r9 = await imp(dueno.c, club, Array.from({ length: 301 }, (_, i) => ({ linea: i + 1, numero: `N${i}`, capacidad: 4 })));
    revisar(!!r9.error && /300/.test(r9.error.message), "la base limita a 300 filas", r9.error?.message);
    const r10 = await imp(dueno.c, club, []);
    revisar(!!r10.error, "un envío vacío se rechaza");

    // Tope de 300 por antro.
    const relleno = Array.from({ length: 300 - antes - 1 }, (_, i) => ({ club_id: club, numero: `R${i}`, capacidad: 4 }));
    await svc.from("club_tables").insert(relleno);
    const r11 = await imp(dueno.c, club, [
      { linea: 1, numero: "Nueva A", capacidad: 4 },
      { linea: 2, numero: "Nueva B", capacidad: 4 },
    ]);
    revisar(!!r11.error && /300/.test(r11.error.message) && (await mesasDe(club)).length === 299, "el antro no pasa de 300 mesas", r11.error?.message);
    const r12 = await imp(dueno.c, club, [
      { linea: 1, numero: "Nueva A", capacidad: 4 },
      { linea: 2, numero: "R0", capacidad: 9 },
    ]);
    revisar(!r12.error && r12.data?.total === 300, "llegar justo a 300 (una nueva y un cambio) sí pasa", r12.error?.message);
  }

  // =========================================================================
  // 4. Índice único y concurrencia
  // =========================================================================
  {
    const dup = await svc.from("club_tables").insert({ club_id: club, numero: " vip 1", capacidad: 4 });
    revisar(dup.error?.code === "23505", "el índice único impide otra «vip 1» aunque sea con service role", dup.error?.code ?? "pasó");
    const club2 = await antro("Concurrencia", null);
    const lote = Array.from({ length: 40 }, (_, i) => ({ linea: i + 1, numero: `C${i}`, capacidad: 4 }));
    const [x, y, z] = await Promise.all([imp(admin.c, club2, lote), imp(admin.c, club2, lote), imp(admin.c, club2, lote)]);
    const m = await mesasDe(club2);
    const creadas = [x, y, z].reduce((s, r) => s + (r.data?.creadas ?? 0), 0);
    revisar(![x, y, z].some((r) => r.error) && m.length === 40 && creadas === 40, "tres importaciones a la vez: 40 mesas, ninguna doble", JSON.stringify([x.error, y.error, z.error]));
    const db = await conectarDevEscritura();
    try {
      const idx = await db.q("select indexdef from pg_indexes where schemaname = 'public' and indexname = 'club_tables_numero_unico'");
      revisar(idx.length === 1 && /lower\(btrim\(numero\)\)/.test(idx[0].indexdef), "el índice es (club_id, lower(btrim(numero)))");
      const g = await db.q(
        "select p.proconfig, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, p.prosecdef from pg_proc p where p.proname = 'mesas_importar'",
      );
      revisar(g[0]?.prosecdef && !g[0].anon && g[0].auth && String(g[0].proconfig).includes("search_path="), "SECURITY DEFINER con search_path vacío; anon sin execute");
    } finally {
      await db.fin();
    }
  }
} catch (e) {
  fallan++;
  console.log("FALLA  error inesperado: " + (e?.message ?? e));
} finally {
  // Limpieza: primero las cuentas (sus perfiles se van en cascada), luego los
  // antros (sus mesas se van en cascada).
  let sinBorrar = 0;
  for (const id of usuarios) if ((await svc.auth.admin.deleteUser(id)).error) sinBorrar++;
  if (clubes.length) {
    const { error } = await svc.from("clubs").delete().in("id", clubes);
    if (error) sinBorrar++;
  }
  console.log(`\nLimpieza: ${clubes.length} antros y ${usuarios.length} cuentas de prueba${sinBorrar ? ` (${sinBorrar} sin borrar)` : " borrados"}.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  process.exit(fallan ? 1 : 0);
}
