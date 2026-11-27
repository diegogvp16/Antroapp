// SOLO DEV. Prueba de sql/post-junta-3/20-escaner-respaldo.sql (escáner de
// respaldo: copia de la noche, código corto, entrada diferida y boleto).
// Todo en UNA transacción que al final se deshace: no deja reservas, ni
// eventos de caja, ni banderas cambiadas.
//
//   node scripts/dev/probar-escaner-respaldo-base.mjs
//
// Sesiones simuladas como las de la app (rol authenticated + claims del JWT)
// para staff, gerente, staff de otro antro, RP, cliente, una cuenta sin
// perfil y el anónimo.
import { createHash, randomUUID } from "node:crypto";
import { conectarDevEscritura } from "../db/conexion.mjs";

const DEMO = "0de70000-0000-4000-8000-000000000001";
const TIJUANA = "0de70000-0000-4000-8000-000000000004";
const db = await conectarDevEscritura();
const res = [];
const nota = (t, ok, d = "") => {
  res.push(ok);
  console.log(`${ok ? "OK   " : "FALLA"}  ${t}${d ? "  — " + d : ""}`);
};

const ids = Object.fromEntries(
  (
    await db.q(`
  select split_part(u.email, '@', 1) as clave, u.id from auth.users u join public.profiles p on p.id = u.id
   where u.email in ('dev_admin@example.com','dev_staff@example.com','dev_gerente@example.com',
                     'dev_staff_tijuana@example.com','dev_cliente@example.com','dev_rp@example.com')`)
  ).map((r) => [r.clave, r.id]),
);
ids.sin_perfil = "11111111-2222-4333-8444-555555555556";

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
// Como `como`, pero lo que hace se queda (hasta el rollback final).
async function comoFijo(uid, fn) {
  await db.q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
  await db.q("set local role authenticated");
  await db.q("savepoint f");
  try {
    const r = await fn();
    await db.q("release savepoint f");
    return r;
  } catch (e) {
    await db.q("rollback to savepoint f");
    return { error: e.code ?? "?", mensaje: e.message };
  } finally {
    await db.q("reset role");
  }
}
const uno = async (sql, args) => (await db.q(sql, args))[0];
const err = (r, re) => r && r.error && (re ? re.test(r.mensaje) : true);

// Reservas de prueba: el QR lo armamos para poder probar códigos repetidos.
const qr = (fin) => `antro-${randomUUID().slice(0, 24)}${fin}`;
const NOMBRE = "t_n4_pwa base";

try {
  await db.q("begin");
  const noche = (await uno(`select public.club_fecha_operacion($1, now())::text as n`, [DEMO])).n;
  const nocheTj = (await uno(`select public.club_fecha_operacion($1, now())::text as n`, [TIJUANA])).n;
  const manana = (await uno(`select ($1::date + 1)::text as n`, [noche])).n;
  const sufijoA = randomUUID().slice(-12); // 12 hex
  const R = {
    a: { qr: qr(sufijoA), fecha: noche, club: DEMO, nombre: `${NOMBRE} A` },
    b: { qr: qr(randomUUID().slice(-6) + sufijoA.slice(-6)), fecha: noche, club: DEMO, nombre: `${NOMBRE} B` }, // mismos 6 finales que A
    c: { qr: qr(randomUUID().slice(-12)), fecha: noche, club: DEMO, nombre: `${NOMBRE} C` },
    d: { qr: qr(randomUUID().slice(-12)), fecha: noche, club: DEMO, nombre: `${NOMBRE} D` },
    manana: { qr: qr(randomUUID().slice(-12)), fecha: manana, club: DEMO, nombre: `${NOMBRE} mañana` },
    tj: { qr: qr(randomUUID().slice(-12)), fecha: nocheTj, club: TIJUANA, nombre: `${NOMBRE} TJ` },
    e: { qr: qr(randomUUID().slice(-12)), fecha: noche, club: DEMO, nombre: `${NOMBRE} E` },
  };
  // Seis reservas con los mismos 6 caracteres finales (más de 5 = no se listan).
  const sufijoM = randomUUID().slice(-6);
  for (let i = 1; i <= 6; i++) R[`m${i}`] = { qr: qr(randomUUID().slice(-6) + sufijoM), fecha: noche, club: DEMO, nombre: `${NOMBRE} M${i}` };
  for (const r of Object.values(R)) {
    r.id = (
      await uno(
        `insert into public.reservations (club_id, fecha, personas, cliente_nombre, cliente_telefono, status, source, qr_code)
         values ($1, $2, 2, $3, '0000000999', 'confirmada', 'organica', $4) returning id`,
        [r.club, r.fecha, r.nombre, r.qr],
      )
    ).id;
  }
  // Bandera apagada al empezar (dentro de la transacción).
  await db.q(`delete from public.club_funciones where club_id in ($1, $2) and funcion = 'escaner_respaldo'`, [DEMO, TIJUANA]);

  // ---------- Bandera apagada ----------
  let r = await como(ids.dev_staff, () => db.q(`select public.puerta_copia_noche($1) j`, [DEMO]));
  nota("apagada: copia de la noche no", err(r, /no está activa/), r.mensaje);
  r = await como(ids.dev_staff, () => db.q(`select public.puerta_escanear_codigo($1, $2) j`, [DEMO, R.c.qr.slice(-6)]));
  nota("apagada: código corto no", err(r, /no está activa/));
  r = await como(ids.dev_staff, () => db.q(`select public.puerta_entrada_diferida($1, $2, $3, now()) j`, [DEMO, R.c.id, randomUUID()]));
  nota("apagada: entrada diferida no", err(r, /no está activa/));
  r = await como("anon", () => db.q(`select public.boleto_muestra_codigo($1) j`, [R.c.qr]));
  nota("apagada: el boleto no muestra el código", r[0]?.j === false);
  const enPuertaC = await uno(`select puerta_estado from public.reservations where id = $1`, [R.c.id]);
  nota("apagada: nada marcó la reserva", enPuertaC.puerta_estado === null);

  // Encender (como admin, con su bitácora; se deshace al final).
  await comoFijo(ids.dev_admin, () => db.q(`select public.funcion_cambiar($1, 'escaner_respaldo', true)`, [DEMO]));

  // ---------- Permisos ----------
  r = await como("anon", () => db.q(`select public.puerta_copia_noche($1) j`, [DEMO]));
  nota("anónimo: copia no ejecutable", r.error === "42501", r.error);
  r = await como("anon", () => db.q(`select public.puerta_escanear_codigo($1, 'abcdef') j`, [DEMO]));
  nota("anónimo: código corto no ejecutable", r.error === "42501");
  r = await como("anon", () => db.q(`select public.puerta_entrada_diferida($1, $2, $3, now()) j`, [DEMO, R.c.id, randomUUID()]));
  nota("anónimo: entrada diferida no ejecutable", r.error === "42501");
  for (const [quien, uid] of [
    ["cliente", ids.dev_cliente],
    ["RP", ids.dev_rp],
    ["staff de otro antro", ids.dev_staff_tijuana],
    ["cuenta sin perfil", ids.sin_perfil],
  ]) {
    const c = await como(uid, () => db.q(`select public.puerta_copia_noche($1) j`, [DEMO]));
    const k = await como(uid, () => db.q(`select public.puerta_escanear_codigo($1, $2) j`, [DEMO, R.c.qr.slice(-6)]));
    const d = await como(uid, () => db.q(`select public.puerta_entrada_diferida($1, $2, $3, now()) j`, [DEMO, R.c.id, randomUUID()]));
    nota(`${quien}: no puede (copia, código, diferida)`, err(c, /permiso/) && err(k, /permiso/) && err(d, /permiso/), [c.mensaje, k.mensaje, d.mensaje].join(" | "));
  }
  r = await como(ids.dev_staff, () => db.q(`select public.puerta_copia_noche($1) j`, [TIJUANA]));
  nota("staff: copia de otro antro no", err(r, /permiso/));

  // ---------- Copia de la noche ----------
  r = await como(ids.dev_staff, () => db.q(`select public.puerta_copia_noche($1) j`, [DEMO]));
  const copia = r[0]?.j;
  const filas = copia?.reservas ?? [];
  const fa = filas.find((x) => x.reservation_id === R.a.id);
  nota("staff: copia con la noche del antro", copia?.noche === noche && copia?.club_id === DEMO && typeof copia?.vence_en === "string", `${copia?.noche} vence ${copia?.vence_en}`);
  nota("vence a las 08:00 del día siguiente", (await uno(`select ($1::timestamptz at time zone 'America/Mexico_City')::text t`, [copia?.vence_en])).t.endsWith("08:00:00"));
  nota("trae las reservas de esta noche (las de prueba)", [R.a, R.b, R.c, R.d].every((x) => filas.some((f) => f.reservation_id === x.id)));
  nota("no trae la de mañana ni la de otro antro", !filas.some((f) => f.reservation_id === R.manana.id || f.reservation_id === R.tj.id));
  nota(
    "huella = sha256 del QR y sufijo = 6 finales",
    fa?.qr_sha256 === createHash("sha256").update(R.a.qr, "utf8").digest("hex") && fa?.sufijo === R.a.qr.slice(-6).toUpperCase(),
  );
  const llaves = new Set(filas.flatMap((f) => Object.keys(f)));
  nota(
    "sin QR, teléfono, consumo ni ids de personas",
    !["qr_code", "cliente_telefono", "consumo", "rp_id", "cliente_id", "telefono"].some((k) => llaves.has(k)) &&
      !JSON.stringify(copia).includes(R.a.qr) &&
      !JSON.stringify(copia).includes("0000000999"),
    [...llaves].join(","),
  );
  nota("la copia dice el total y que no está truncada", copia?.truncada === false && copia?.total === filas.length, `${copia?.total} / ${filas.length}`);
  nota("gerente también la baja", !(await como(ids.dev_gerente, () => db.q(`select public.puerta_copia_noche($1) j`, [DEMO]))).error);

  // ---------- Código corto ----------
  const cod = (c) => como(ids.dev_staff, () => db.q(`select public.puerta_escanear_codigo($1, $2) j`, [DEMO, c]));
  nota("menos de 6 caracteres: no", err(await cod("abc12"), /6 caracteres/));
  nota("letras fuera de A–F: no", err(await cod("zzzzzz"), /A a la F/));
  nota("comodines (% y _): no", err(await cod("%%%%%%"), /A a la F/) && err(await cod("______"), /A a la F/));
  nota("más de 12: no", err(await cod("0123456789abc"), /más largo/));
  nota("código que no existe esta noche: no", err(await cod("000000"), /ninguna reserva/));
  nota("código de una reserva de mañana: no", err(await cod(R.manana.qr.slice(-6)), /ninguna reserva/));
  nota("código de otro antro: no", err(await cod(R.tj.qr.slice(-6)), /ninguna reserva/));
  r = await cod(R.a.qr.slice(-6));
  const amb = r[0]?.j;
  nota(
    "dos reservas con el mismo código: devuelve las opciones (sin QR ni teléfono), sin escanear",
    amb?.ambiguo === true && amb.opciones?.length === 2 && !JSON.stringify(amb).includes("antro-") && !JSON.stringify(amb).includes("0000000999") &&
      amb.opciones.every((o) => o.nombre === "t_n4_pwa b." && o.personas === 2),
    JSON.stringify(amb),
  );
  nota("…y ninguna quedó 'en puerta'", (await uno(`select count(*)::int n from public.reservations where id in ($1, $2) and puerta_estado is not null`, [R.a.id, R.b.id])).n === 0);
  const elegir = (c, id) => como(ids.dev_staff, () => db.q(`select public.puerta_escanear_codigo($1, $2, $3) j`, [DEMO, c, id]));
  r = await elegir(R.a.qr.slice(-6), R.b.id);
  nota("elegir una de las opciones: la escanea (misma ficha que la cámara)", r[0]?.j?.reservation_id === R.b.id && r[0]?.j?.puerta_estado === "en_puerta");
  nota("elegir una reserva que no coincide con el código: no", err(await elegir(R.a.qr.slice(-6), R.c.id), /ninguna reserva/));
  nota("elegir una reserva de otro antro: no", err(await elegir(R.a.qr.slice(-6), R.tj.id), /ninguna reserva/));
  nota("más de 5 con el mismo código: pide más caracteres (no lista)", err(await cod(sufijoM), /más de una/));
  r = await cod(R.a.qr.slice(-8).toUpperCase().replace(/(....)$/, " $1"));
  nota("con 8 caracteres (mayúsculas y espacio) encuentra la buena", r[0]?.j?.reservation_id === R.a.id && r[0]?.j?.puerta_estado === "en_puerta", JSON.stringify(r[0]?.j ?? r));
  r = await como(ids.dev_staff, async () => {
    const f = await db.q(`select public.puerta_escanear_codigo($1, $2) j`, [DEMO, R.c.qr.slice(-6)]);
    const est = await uno(`select puerta_estado, en_puerta_por from public.reservations where id = $1`, [R.c.id]);
    return { ficha: f[0].j, est };
  });
  nota(
    "código corto válido: misma ficha que la cámara y marca 'en puerta'",
    r.ficha?.cliente_nombre === R.c.nombre && r.ficha?.personas === 2 && !("cliente_telefono" in (r.ficha ?? {})) && r.est.puerta_estado === "en_puerta" && r.est.en_puerta_por === ids.dev_staff,
  );

  // ---------- Entrada diferida ----------
  const clave = randomUUID();
  const dif = (uid, id, k, t = "now()") => comoFijo(uid, () => db.q(`select public.puerta_entrada_diferida($1, $2, $3, ${t}) j`, [DEMO, id, k]));
  r = await dif(ids.dev_staff, R.d.id, clave, "now() - interval '40 minutes'");
  const est = await uno(`select status, puerta_estado, entrada_por, entrada_en from public.reservations where id = $1`, [R.d.id]);
  nota("diferida: entra con las funciones de puerta", r[0]?.j?.resultado === "entro" && est.status === "usada" && est.puerta_estado === "entro" && est.entrada_por === ids.dev_staff, JSON.stringify(r[0]?.j ?? r));
  nota("diferida: trae la hora local", /^\d{2}:\d{2}$/.test(r[0]?.j?.hora_local ?? ""));
  const ev = await db.q(
    `select tipo, detalle from public.caja_eventos where club_id = $1 and (detalle->>'reservation_id') = $2::text order by id`,
    [DEMO, R.d.id],
  );
  nota(
    "eventos: escanear, confirmar y la diferida con la hora del teléfono",
    ev.map((e) => e.tipo).join(",") === "puerta_escanear,puerta_confirmar_entrada,puerta_entrada_diferida" && ev[2].detalle.clave === clave && !!ev[2].detalle.escaneado_en,
    ev.map((e) => e.tipo).join(","),
  );
  r = await dif(ids.dev_staff, R.d.id, clave);
  nota("mismo envío otra vez (respuesta perdida): ya_enviada, sin otro evento", r[0]?.j?.resultado === "ya_enviada" && (await db.q(`select 1 from public.caja_eventos where (detalle->>'reservation_id') = $1::text`, [R.d.id])).length === 3);
  r = await dif(ids.dev_staff, R.d.id, randomUUID());
  nota("otra clave, misma cuenta: ya_entro por ti", r[0]?.j?.resultado === "ya_entro" && r[0]?.j?.por_ti === true);
  r = await dif(ids.dev_gerente, R.d.id, randomUUID());
  nota("otro teléfono/otra persona: ya_entro, no por ti, con hora", r[0]?.j?.resultado === "ya_entro" && r[0]?.j?.por_ti === false && /ya entró a las/.test(r[0]?.j?.mensaje ?? ""), JSON.stringify(r[0]?.j));
  const una = await uno(`select count(*)::int n from public.caja_eventos where tipo = 'puerta_confirmar_entrada' and (detalle->>'reservation_id') = $1::text`, [R.d.id]);
  nota("la entrada se registró una sola vez", una.n === 1);
  r = await dif(ids.dev_staff, R.manana.id, randomUUID());
  nota("diferida de una reserva de mañana: la base dice que no es de esta noche", err(r, /no para esta noche/), r.mensaje);
  r = await dif(ids.dev_staff, R.tj.id, randomUUID());
  nota("diferida de una reserva de otro antro: no encontrada", err(r, /no encontrada/));
  r = await dif(ids.dev_staff, randomUUID(), randomUUID());
  nota("diferida de una reserva que no existe: no encontrada", err(r, /no encontrada/));

  // Clave atada a su reserva y a su antro (revisión, punto 3).
  r = await dif(ids.dev_staff, R.e.id, clave);
  const estE = await uno(`select puerta_estado from public.reservations where id = $1`, [R.e.id]);
  nota("la misma clave con OTRA reserva: error, y esa reserva no se toca", err(r, /otra reserva/) && estE.puerta_estado === null, r.mensaje);
  r = await dif(ids.dev_staff, R.tj.id, clave);
  nota("la misma clave con una reserva de otro antro: error, sin datos de esa reserva", err(r, /otra reserva/) && !JSON.stringify(r).includes("entrada_en"));
  r = await como(ids.dev_staff, () => db.q(`select public.puerta_entrada_diferida($1, $2, $3, now()) j`, [TIJUANA, R.tj.id, clave]));
  nota("la clave con el antro de otro: sin permiso", err(r, /permiso/));

  // Índice propio para la clave (revisión, punto 4).
  r = await como(ids.dev_staff, async () => {
    await db.q("set local enable_seqscan = off");
    return db.q(
      `explain select 1 from public.caja_eventos e where e.club_id = $1 and e.tipo = 'puerta_entrada_diferida' and e.detalle ->> 'clave' = $2`,
      [DEMO, clave],
    );
  });
  nota("la búsqueda de la clave usa el índice caja_eventos_puerta_clave", JSON.stringify(r).includes("caja_eventos_puerta_clave"), JSON.stringify(r).slice(0, 120));

  // Bandera apagada entre el envío y el reintento (revisión, punto 5).
  await comoFijo(ids.dev_admin, () => db.q(`select public.funcion_cambiar($1, 'escaner_respaldo', false)`, [DEMO]));
  r = await dif(ids.dev_staff, R.d.id, clave);
  nota("bandera apagada después: el reintento de lo que SÍ se guardó dice ya_enviada", r[0]?.j?.resultado === "ya_enviada", JSON.stringify(r[0]?.j ?? r));
  r = await dif(ids.dev_staff, R.e.id, randomUUID());
  nota("…y una entrada nueva ya no pasa", err(r, /no está activa/));
  await comoFijo(ids.dev_admin, () => db.q(`select public.funcion_cambiar($1, 'escaner_respaldo', true)`, [DEMO]));
  // Permiso de puerta retirado al staff (caja_permisos) => no.
  await db.q(`delete from public.caja_permisos where club_id = $1 and rol = 'staff' and permiso = 'puerta'`, [DEMO]);
  await db.q(`insert into public.caja_permisos (club_id, rol, permiso, permitido) values ($1, 'staff', 'puerta', false)`, [DEMO]);
  r = await como(ids.dev_staff, () => db.q(`select public.puerta_entrada_diferida($1, $2, $3, now()) j`, [DEMO, R.b.id, randomUUID()]));
  nota("staff sin permiso de puerta: no", err(r, /permiso/), r.mensaje ?? JSON.stringify(r));

  // ---------- Boleto ----------
  r = await como("anon", () => db.q(`select public.boleto_muestra_codigo($1) j`, [R.a.qr]));
  nota("encendida: el boleto muestra el código (anónimo)", r[0]?.j === true);
  r = await como("anon", () => db.q(`select public.boleto_muestra_codigo($1) j`, [R.tj.qr]));
  nota("…pero no en un antro con la bandera apagada", r[0]?.j === false);
  r = await como("anon", () => db.q(`select public.boleto_muestra_codigo($1) j`, ["antro-no-existe"]));
  nota("…ni para un código que no existe", r[0]?.j === false);
} catch (e) {
  nota("sin excepciones", false, e.message);
} finally {
  await db.q("rollback").catch(() => {});
  const quedan = await db.q(`select count(*)::int n from public.reservations where cliente_nombre like 't_n4_pwa base%'`);
  nota("rollback: no queda ninguna reserva de prueba", quedan[0].n === 0);
  const flag = await db.q(`select public.funcion_activa($1, 'escaner_respaldo') a`, [DEMO]);
  nota("rollback: la bandera sigue apagada en Club Demo Dev", flag[0].a === false);
  await db.fin();
}
const pasan = res.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${res.length}`);
process.exitCode = pasan === res.length ? 0 : 1;
