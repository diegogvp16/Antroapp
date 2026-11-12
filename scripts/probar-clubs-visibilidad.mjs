// Prueba de visibilidad de clubs y club_photos por la API, con sesiones reales.
// Acompaña a sql/2026-11-12-clubs-select-solo-publicados.sql.
//
// Uso:  node scripts/probar-clubs-visibilidad.mjs
//
// Crea datos de prueba con la service role key (dos dueños, dos antros, un
// RP, un cliente y un admin), entra con 5 sesiones y compara lo que cada una
// ve contra la regla:
//   se ve si (verificado y con suscripción) o admin o dueño o staff/RP del club.
// Al final borra todo lo que creó y confirma que quedó en 0.
// Antes de aplicar el SQL se espera que fallen las filas marcadas "hoy falla".
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const PANIC_ROOM = "8e433d37-ac56-407e-82a6-4e405d6d9fdc";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
const nuevoAnon = () => createClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);

const TAG = "vis" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const usuarios = {};
const clubsCreados = [];
const resultados = [];

function revisar(nombre, ok, detalle = "") {
  resultados.push(ok);
  console.log(`${ok ? "PASA " : "FALLA"}  ${nombre}${detalle ? "  — " + detalle : ""}`);
}

async function crearUsuario(clave, role, club_id = null) {
  const email = `prueba-${clave}-${TAG}@example.com`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error) throw error;
  usuarios[clave] = { id: data.user.id, email };
  const r = await svc.from("profiles").upsert({ id: data.user.id, nombre: `Prueba ${clave} ${TAG}`, role, club_id });
  if (r.error) throw r.error;
  return data.user.id;
}

async function crearClub(nombre, dueno_id, publicado) {
  const { data, error } = await svc
    .from("clubs")
    .insert({ nombre: `${nombre} ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", deposito_monto: 0, dueno_id, suscripcion_activa: false })
    .select("id")
    .single();
  if (error) throw error;
  clubsCreados.push(data.id);
  if (publicado) {
    const u = await svc
      .from("clubs")
      .update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true })
      .eq("id", data.id);
    if (u.error) throw u.error;
  }
  const f = await svc.from("club_photos").insert({ club_id: data.id, url: `https://example.com/${TAG}.jpg`, storage_path: `${data.id}/${TAG}.jpg`, orden: 0 });
  if (f.error) throw f.error;
  return data.id;
}

async function sesion(clave) {
  const c = nuevoAnon();
  const { error } = await c.auth.signInWithPassword({ email: usuarios[clave].email, password: PASS });
  if (error) throw error;
  return c;
}

async function limpiar() {
  const ids = Object.values(usuarios).map((u) => u.id);
  if (clubsCreados.length) {
    await svc.from("reservations").delete().in("club_id", clubsCreados);
    await svc.from("club_photos").delete().in("club_id", clubsCreados);
  }
  if (ids.length) await svc.from("profiles").delete().in("id", ids);
  for (const id of clubsCreados) {
    const { error } = await svc.from("clubs").delete().eq("id", id);
    if (error) console.log("  error borrando club:", error.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const { data: c } = await svc.from("clubs").select("id").ilike("nombre", `%${TAG}%`);
  const { data: p } = ids.length ? await svc.from("profiles").select("id").in("id", ids) : { data: [] };
  const { data: f } = clubsCreados.length ? await svc.from("club_photos").select("id").in("club_id", clubsCreados) : { data: [] };
  const { data: r } = await svc.from("reservations").select("id").ilike("cliente_nombre", `%${TAG}%`);
  const { data: lista } = await svc.auth.admin.listUsers({ perPage: 1000 });
  const u = (lista?.users ?? []).filter((x) => x.email?.includes(TAG)).length;
  console.log(`\nLimpieza (restos): clubs=${c.length} perfiles=${p.length} usuarios=${u} fotos=${f.length} reservas=${r.length}`);
}

try {
  // ---------------- Preparación ----------------
  const { data: panic } = await svc.from("clubs").select("id, estado_verificacion, suscripcion_activa, dueno_id").eq("id", PANIC_ROOM).maybeSingle();
  if (!panic) throw new Error("No existe Panic Room");
  const panicPublicado = panic.estado_verificacion === "verificado" && panic.suscripcion_activa;
  console.log(`Panic Room: ${panic.estado_verificacion}, suscripción ${panic.suscripcion_activa}, dueño ${panic.dueno_id ?? "ninguno"}${panicPublicado ? "  (¡ESTÁ PUBLICADO, la prueba no aplica!)" : ""}`);

  const duenoA = await crearUsuario("duenoA", "dueno");
  const duenoB = await crearUsuario("duenoB", "dueno");
  const oculto = await crearClub("Prueba Oculto", duenoA, false); // borrador de duenoA
  const publico = await crearClub("Prueba Publico", duenoB, true); // publicado de duenoB
  await crearUsuario("rp", "rp", oculto);
  await crearUsuario("cliente", "cliente");
  await crearUsuario("admin", "admin");
  const { data: estado } = await svc.from("clubs").select("id, estado_verificacion, suscripcion_activa").in("id", [oculto, publico]);
  const ok = estado.find((c) => c.id === publico);
  if (ok.estado_verificacion !== "verificado" || !ok.suscripcion_activa) throw new Error("No se pudo publicar el club de prueba");

  // Antros reales: lo esperado depende de si están publicados hoy.
  const { data: reales } = await svc.from("clubs").select("id, nombre, estado_verificacion, suscripcion_activa").not("id", "in", `(${[...clubsCreados, PANIC_ROOM].join(",")})`);

  const sesiones = {
    "anónimo": nuevoAnon(),
    "cliente": await sesion("cliente"),
    "RP (del antro oculto)": await sesion("rp"),
    "dueño de otro club (duenoA)": await sesion("duenoA"),
    "admin": await sesion("admin"),
  };
  // Qué debe ver cada sesión, además de los antros publicados.
  const extra = {
    "anónimo": [],
    "cliente": [],
    "RP (del antro oculto)": [oculto],
    "dueño de otro club (duenoA)": [oculto],
    "admin": "todo",
  };

  // ---------------- Visibilidad ----------------
  for (const [actor, c] of Object.entries(sesiones)) {
    console.log(`\n== ${actor}`);
    const ve = async (tabla, col, id) => {
      const { data, error } = await c.from(tabla).select("id").eq(col, id);
      return error ? `error: ${error.message}` : data.length > 0;
    };
    const todo = extra[actor] === "todo";
    const debeVer = (id, publicado) => todo || publicado || extra[actor].includes(id);
    const casos = [
      ["Panic Room", PANIC_ROOM, panicPublicado],
      ["antro oculto de prueba (borrador de duenoA)", oculto, false],
      ["antro publicado de prueba", publico, true],
      ...reales.map((r) => [`${r.nombre} (${r.estado_verificacion}, suscripción ${r.suscripcion_activa})`, r.id, r.estado_verificacion === "verificado" && r.suscripcion_activa]),
    ];
    for (const [nombre, id, publicado] of casos) {
      const esperado = debeVer(id, publicado);
      const club = await ve("clubs", "id", id);
      revisar(`${actor}: clubs → ${nombre}: ${esperado ? "lo ve" : "NO lo ve"}`, club === esperado, club === true ? "lo ve" : club === false ? "no lo ve" : club);
      const foto = await ve("club_photos", "club_id", id);
      revisar(`${actor}: club_photos → ${nombre}: ${esperado ? "las ve" : "NO las ve"}`, foto === esperado, foto === true ? "las ve" : foto === false ? "no las ve" : foto);
    }
  }

  // ---------------- Que no se rompa nada ----------------
  console.log("\n== Flujos que deben seguir funcionando");
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date());
  const reserva = (club_id, extraCampos = {}) => ({
    cliente_nombre: `Prueba ${TAG}`, cliente_telefono: "3300000000", club_id, source: "organica",
    fecha: hoy, personas: 2, status: "pendiente", qr_code: `antro-${randomUUID()}`, ...extraCampos,
  });
  {
    const r = await sesiones["anónimo"].from("reservations").insert(reserva(publico));
    revisar("anónimo: reserva sin cuenta en un antro publicado", !r.error, r.error?.message ?? "");
  }
  {
    const r = await sesiones["cliente"].from("reservations").insert(reserva(publico, { cliente_id: usuarios.cliente.id }));
    revisar("cliente: reserva en un antro publicado", !r.error, r.error?.message ?? "");
  }
  {
    const { data } = await sesiones["RP (del antro oculto)"].from("clubs").select("nombre, comision_desbloqueo_reservas, pago_rp_modo").eq("id", oculto).maybeSingle();
    revisar("RP: su panel lee su antro aunque no esté publicado", !!data);
    const r = await sesiones["RP (del antro oculto)"].from("reservations").insert(reserva(oculto, { source: "rp", rp_id: usuarios.rp.id }));
    revisar("RP: crea una reserva en su antro", !r.error, r.error?.message ?? "");
  }
  {
    const c = sesiones["dueño de otro club (duenoA)"];
    const { data } = await c.from("clubs").select("id").eq("dueno_id", usuarios.duenoA.id).maybeSingle();
    revisar("dueño: su panel encuentra su antro (borrador)", data?.id === oculto);
    await c.from("clubs").update({ horario: "21:00-02:00" }).eq("id", oculto);
    const { data: h } = await svc.from("clubs").select("horario").eq("id", oculto).single();
    revisar("dueño: edita los datos de su antro", h.horario === "21:00-02:00", h.horario);
    const { data: fotos } = await c.from("club_photos").select("id").eq("club_id", oculto);
    revisar("dueño: ve las fotos de su antro", fotos?.length === 1);
  }
  {
    const { data } = await sesiones["admin"].from("clubs").select("id");
    revisar("admin: el panel lista todos los antros (incluido Panic Room)", data?.some((c) => c.id === PANIC_ROOM) && data.length >= reales.length + 3, `${data?.length} antros`);
  }
} catch (e) {
  revisar("Ejecución sin excepciones", false, e.message);
} finally {
  await limpiar();
  const fallas = resultados.filter((x) => !x).length;
  console.log(`\nResultado: ${resultados.length - fallas}/${resultados.length} pasan`);
}
