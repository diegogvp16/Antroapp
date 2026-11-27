// Escenario de prueba de las ventas del POS en antroapp-dev (SOLO DEV).
// Lo usan scripts/dev/probar-pos.mjs y scripts/dev/probar-pos-pantalla.mjs.
// No ejecuta nada al importarse.
//
// Crea dos antros («T n4 pos A/B <sufijo>») con sus mesas, cuentas
// t_n4_pos_<rol>_<sufijo>@example.com (dueño, gerente, staff, RP y gerente
// dado de baja de A; gerente de B; un cliente; una cuenta de Auth sin
// perfil) y una noche de caja YA CERRADA el 2026-10-07 en A (y una en B)
// con sesiones, cuentas y consumos. La caja se escribe como postgres con
// antroapp.borrado_pruebas = on (el mismo interruptor que usan las demás
// pruebas para crear y borrar caja de prueba). limpiar() borra todo.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

export const NOCHE = "2026-10-07";
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Hora local de la Ciudad de México (UTC-6, sin horario de verano) → ISO.
export const local = (fechaHora) => new Date(`${fechaHora}-06:00`).toISOString();

export async function crearEscenario({ prefijo = "t_n4_pos" } = {}) {
  const env = verificarEnvDev();
  const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
  const anon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const db = await conectarDevEscritura();
  await db.q("select set_config('antroapp.borrado_pruebas', 'on', false)");

  const sufijo = randomUUID().slice(0, 8);
  const PASS = "Prueba-" + randomUUID();
  const e = { sufijo, PASS, svc, anon, db, usuarios: {}, clubs: {}, mesas: {}, cuentas: {}, sesiones: {}, noches: {}, ids: [] };

  async function usuario(clave, { role = null, club = null, activo = true } = {}) {
    const email = `${prefijo}_${clave}_${sufijo}@example.com`;
    const u = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
    if (u.error) throw new Error(`crear ${clave}: ${u.error.message}`);
    e.ids.push(u.data.user.id);
    if (role) {
      const p = await svc.from("profiles").insert({ id: u.data.user.id, nombre: `${prefijo} ${clave}`, role, club_id: club, activo });
      if (p.error) throw new Error(`perfil ${clave}: ${p.error.message}`);
    }
    e.usuarios[clave] = { id: u.data.user.id, email };
    return u.data.user.id;
  }
  async function antro(clave, duenoId) {
    const { data, error } = await svc
      .from("clubs")
      .insert({ nombre: `T n4 pos ${clave} ${sufijo}`, direccion: "Calle de prueba 1", horario: "Vie", dueno_id: duenoId })
      .select("id")
      .single();
    if (error) throw new Error("antro: " + error.message);
    e.clubs[clave] = data.id;
    return data.id;
  }

  try {
  const duenoA = await usuario("dueno", { role: "dueno" });
  const A = await antro("A", duenoA);
  const B = await antro("B", null);
  await usuario("gerente", { role: "gerente", club: A });
  await usuario("staff", { role: "staff", club: A });
  await usuario("rp", { role: "rp", club: A });
  await usuario("gerente_baja", { role: "gerente", club: A, activo: false });
  await usuario("gerente_b", { role: "gerente", club: B });
  await usuario("cliente", { role: "cliente" });
  await usuario("sin_perfil");

  for (const [club, numeros] of [[A, ["1", "2", "3", "VIP 1"]], [B, ["1"]]]) {
    for (const numero of numeros) {
      const [m] = await db.q("insert into public.club_tables (club_id, numero, capacidad) values ($1, $2, 8) returning id", [club, numero]);
      e.mesas[`${club === A ? "A" : "B"}:${numero}`] = m.id;
    }
  }
  const quien = e.usuarios.gerente.id;
  const noche = async (clave, club) => {
    const [n] = await db.q(
      `insert into public.caja_noches (club_id, fecha_operacion, estado, abierta_por, abierta_en, cerrada_por, cerrada_en)
       values ($1, $2, 'cerrada', $3, $4, $3, $5) returning id`,
      [club, NOCHE, quien, local(`${NOCHE}T21:00:00`), local("2026-10-08T06:00:00")],
    );
    e.noches[clave] = n.id;
    return n.id;
  };
  const sesion = async (clave, club, nocheId, mesa, abre, cierra, estado = "cuadrada") => {
    const [s] = await db.q(
      `insert into public.mesa_sesiones (club_id, noche_id, mesa_id, estado, abierta_por, abierta_en, cerrada_por, cerrada_en, cuadrada_por, cuadrada_en)
       values ($1, $2, $3, $4, $5, $6, $5, $7, case when $4 = 'cuadrada' then $5::uuid end, case when $4 = 'cuadrada' then $7::timestamptz end) returning id`,
      [club, nocheId, mesa, estado, quien, local(abre), local(cierra)],
    );
    e.sesiones[clave] = s.id;
    return s.id;
  };
  const cuenta = async (clave, club, sesionId, nombre, creada, consumo) => {
    const [c] = await db.q(
      `insert into public.mesa_cuentas (club_id, sesion_id, origen, cliente_nombre, personas, creada_por, creada_en)
       values ($1, $2, 'walk_in', $3, 2, $4, $5) returning id`,
      [club, sesionId, `${nombre} ${prefijo}`, quien, local(creada)],
    );
    e.cuentas[clave] = c.id;
    if (consumo) {
      const [s] = await db.q("select noche_id, mesa_id from public.mesa_sesiones where id = $1", [sesionId]);
      await db.q(
        `insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, monto_centavos, concepto, registrado_por, registrado_en)
         values ($1, $2, $3, $4, $5, $6, 'Consumo de prueba', $7, $8)`,
        [club, s.noche_id, sesionId, s.mesa_id, c.id, consumo, quien, local(creada)],
      );
    }
    return c.id;
  };

  const nA = await noche("A", A);
  const s1 = await sesion("S1", A, nA, e.mesas["A:1"], `${NOCHE}T22:00:00`, "2026-10-08T00:30:00");
  await cuenta("C1", A, s1, "Ana", `${NOCHE}T22:00:00`, 150000);
  const s2 = await sesion("S2", A, nA, e.mesas["A:1"], "2026-10-08T01:00:00", "2026-10-08T03:00:00", "cerrada");
  await cuenta("C2", A, s2, "Beto", "2026-10-08T01:00:00", 80000);
  await cuenta("C3", A, s2, "Caro", "2026-10-08T01:00:00", 50000);
  const s3 = await sesion("S3", A, nA, e.mesas["A:2"], `${NOCHE}T23:00:00`, "2026-10-08T02:00:00");
  const c4 = await cuenta("C4", A, s3, "Dani", `${NOCHE}T23:00:00`, 100000);
  // Un consumo anulado en C4: no cuenta en la conciliación.
  await db.q(
    `insert into public.caja_consumos (club_id, noche_id, sesion_id, mesa_id, cuenta_id, monto_centavos, concepto, registrado_por,
                                       anulado, anulado_por, anulado_en, motivo_anulacion)
     values ($1, $2, $3, $4, $5, 99999, 'Anulado de prueba', $6, true, $6, now(), 'prueba')`,
    [A, nA, s3, e.mesas["A:2"], c4, quien],
  );
  const s4 = await sesion("S4", A, nA, e.mesas["A:3"], `${NOCHE}T23:30:00`, "2026-10-08T01:30:00");
  await cuenta("C5", A, s4, "Eli", `${NOCHE}T23:30:00`, 70000);
  const nB = await noche("B", B);
  const sb = await sesion("SB", B, nB, e.mesas["B:1"], `${NOCHE}T22:00:00`, "2026-10-08T02:00:00");
  await cuenta("CB", B, sb, "Fer", `${NOCHE}T22:00:00`, 10000);
  } catch (x) {
    await limpiarTodo().catch(() => {});
    throw x;
  }

  // Sesiones con la clave de Supabase Auth (con reintento si hay límite).
  e.sesion = async (email, password = PASS) => {
    for (let intento = 0; ; intento++) {
      const c = anon();
      const { error } = await c.auth.signInWithPassword({ email, password });
      if (!error) return c;
      if (!/rate limit|too many/i.test(error.message) || intento >= 6) throw new Error("login " + email + ": " + error.message);
      console.log("(límite de Supabase Auth; espero 30 s)");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  };

  // Si algo falla al armar el escenario, se borra lo que alcanzó a crear.
  e.limpiar = limpiarTodo;
  async function limpiarTodo() {
    const clubs = Object.values(e.clubs);
    const errores = [];
    const paso = async (sql, args) => {
      try {
        await db.q(sql, args);
      } catch (err) {
        errores.push(err.message);
      }
    };
    await paso("delete from public.pos_ventas where club_id = any($1)", [clubs]);
    await paso("delete from public.pos_importaciones where club_id = any($1)", [clubs]);
    await paso("delete from public.pos_mapeos where club_id = any($1)", [clubs]);
    await paso("delete from public.caja_consumos where club_id = any($1)", [clubs]);
    await paso("delete from public.caja_pagos where club_id = any($1)", [clubs]);
    await paso("delete from public.caja_eventos where club_id = any($1)", [clubs]);
    await paso("delete from public.mesa_cuentas where club_id = any($1)", [clubs]);
    await paso("delete from public.mesa_sesiones where club_id = any($1)", [clubs]);
    await paso("delete from public.caja_noches where club_id = any($1)", [clubs]);
    await paso("delete from public.club_funciones where club_id = any($1)", [clubs]);
    await paso("delete from public.funciones_cambios where club_id = any($1)", [clubs]);
    await paso("delete from public.club_tables where club_id = any($1)", [clubs]);
    await paso("update public.profiles set club_id = null where club_id = any($1)", [clubs]);
    await paso("delete from public.clubs where id = any($1)", [clubs]);
    for (const id of e.ids) {
      await paso("delete from public.profiles where id = $1", [id]);
      const r = await svc.auth.admin.deleteUser(id);
      if (r.error) errores.push(`auth ${id}: ${r.error.message}`);
    }
    const [resto] = await db.q(
      `select (select count(*) from auth.users where email like $1)::int as usuarios,
              (select count(*) from public.clubs where nombre like 'T n4 pos %' || $2)::int as clubs,
              (select count(*) from public.mesa_cuentas where cliente_nombre like '%' || $3)::int as cuentas,
              (select count(*) from public.pos_ventas where club_id = any($4))::int as ventas`,
      [`${prefijo}\\_%\\_${sufijo}@example.com`, sufijo, prefijo, clubs],
    );
    await db.fin();
    return { errores, resto };
  }
  return e;
}
