// SOLO DEV. Pruebas del boleto del cliente (B6): confirmación "Lugar
// apartado", estado del QR en /r/<codigo> y cover informativo.
//
//   node scripts/dev/probar-boleto-cliente.mjs                         # dominio + base
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-boleto-cliente.mjs http://localhost:3024  # + pantallas 390/360
//
// Requiere sql/post-junta-2/40-boleto-estado.sql aplicado en dev.
// Crea sus propios datos ("T cli …", t_cli_…@example.com) y los borra al
// final aunque algo falle. Capturas en screenshots-b-cliente/ (ignorada).

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { conectarDevEscritura, verificarEnvDev } from "../db/conexion.mjs";
import {
  estadoBoletoRespaldo,
  horaLegible,
  renglonesPuerta,
  leerBoletos,
  agregarBoleto,
  boletosDelClub,
  esCodigoQr,
  CLAVE_BOLETOS,
  MAX_BOLETOS,
  TEXTO_ESTADO,
  AVISO_COVER,
  avisoCover,
  frasePuertaFormulario,
  lineaCoverMensaje,
  esZonaGuardable,
} from "../../lib/domain/boleto.ts";
import { nocheOperativaMexico, nocheOperativaEn, ZONA_MAS_TARDIA_MEXICO, sumarDiasISO } from "../../lib/fechas.ts";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createClient } = createRequire(path.join(RAIZ, "package.json"))("@supabase/supabase-js");
const BASE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;
const SHOTS = path.join(RAIZ, "screenshots-b-cliente") + path.sep;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const TAG = Date.now().toString(36);

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log(`${cond ? "OK     " : "FALLA  "}${texto}${!cond && detalle ? "  — " + detalle : ""}`);
}

const qr = () => `antro-${randomUUID()}`;
const clubs = [];
const usuarios = [];

try {
  // ======================= 1. Dominio (sin base) =======================
  console.log("\n— Dominio —");
  revisar(estadoBoletoRespaldo({ status: "usada", fecha: "2026-11-20" }, "2026-11-24") === "usado", "respaldo: usada → usado (aunque sea de otra noche)");
  revisar(estadoBoletoRespaldo({ status: "pendiente", fecha: "2026-11-23" }, "2026-11-24") === "vencido", "respaldo: fecha anterior a la noche → vencido");
  revisar(estadoBoletoRespaldo({ status: "confirmada", fecha: "2026-11-24" }, "2026-11-24") === "vigente", "respaldo: la noche en curso → vigente");
  revisar(estadoBoletoRespaldo({ status: "pendiente", fecha: "basura" }, "2026-11-24") === "vigente", "respaldo: fecha ilegible no se marca vencida");
  // Corte 08:00 de la noche operativa (hora de la Ciudad de México, UTC-6).
  revisar(nocheOperativaMexico(new Date("2026-11-25T13:59:00Z")) === "2026-11-24", "07:59 del 25 → sigue la noche del 24");
  revisar(nocheOperativaMexico(new Date("2026-11-25T14:00:00Z")) === "2026-11-25", "08:00 del 25 → ya es la noche del 25");
  revisar(horaLegible("23:30:00") === "11:30 p. m." && horaLegible("01:00") === "1:00 a. m." && horaLegible("00:15") === "12:15 a. m." && horaLegible("12:00") === "12:00 p. m.", "hora límite legible");
  revisar(horaLegible("25:00") === null && horaLegible("") === null && horaLegible(null) === null, "hora inválida → nada");
  const filas = renglonesPuerta({ cover: "Cover $350", tolerancia_hora: "01:30:00", edad_minima: 21, codigo_vestimenta: " Formal " });
  revisar(JSON.stringify(filas) === JSON.stringify([
    { etiqueta: "Cover", valor: "$350" }, { etiqueta: "Llega antes de", valor: "1:30 a. m." },
    { etiqueta: "Edad mínima", valor: "21 años" }, { etiqueta: "Vestimenta", valor: "Formal" },
  ]), "renglones de la puerta completos", JSON.stringify(filas));
  revisar(renglonesPuerta({ cover: "Cover: consultar con el antro" })[0]?.valor === "Consultar con el antro" && renglonesPuerta({ cover: "Entrada libre" })[0]?.valor === "Entrada libre", "cover consultar / libre");
  revisar(renglonesPuerta({ cover: null, edad_minima: 0, codigo_vestimenta: "  " }).length === 0, "sin datos → sin renglones");
  // El aviso de cobro depende del modo: solo «monto» dice que lo cobra el antro.
  const COBRA = /lo cobra el antro/i;
  revisar(avisoCover("monto") === AVISO_COVER && COBRA.test(avisoCover("monto")), "aviso monto: lo cobra el antro");
  revisar(!COBRA.test(avisoCover("libre")) && /No hay cover/.test(avisoCover("libre")) && /tampoco te cobra nada/.test(avisoCover("libre")), "aviso libre: no hay cover, sin «lo cobra el antro»", avisoCover("libre"));
  revisar(!COBRA.test(avisoCover("consultar")) && /Pregunta el cover/.test(avisoCover("consultar")), "aviso consultar: pregunta el cover", avisoCover("consultar"));
  revisar(avisoCover("oculto") === null && avisoCover(null) === null && avisoCover(undefined) === null, "aviso oculto / sin modo → nada");
  revisar(COBRA.test(frasePuertaFormulario("monto", "Cover $350")) && /\$350/.test(frasePuertaFormulario("monto", "Cover $350")), "formulario monto: monto y quién lo cobra");
  revisar(frasePuertaFormulario("libre", "Entrada libre") === "Entrada libre en la puerta." && !COBRA.test(frasePuertaFormulario("consultar", "Cover: consultar con el antro")), "formulario libre / consultar sin «lo cobra el antro»");
  revisar(frasePuertaFormulario("monto", null) === null && frasePuertaFormulario("oculto", "x") === null, "formulario sin texto u oculto → nada");
  revisar(COBRA.test(lineaCoverMensaje("monto", "Cover $350")) && !COBRA.test(lineaCoverMensaje("libre", "Entrada libre")) && !COBRA.test(lineaCoverMensaje("consultar", "Cover: consultar con el antro")) && !/consultar con el antro en la puerta/.test(lineaCoverMensaje("consultar", "Cover: consultar con el antro")), "mensaje: solo monto dice que lo cobra el antro");
  revisar(lineaCoverMensaje("monto", null) === null && lineaCoverMensaje("oculto", "x") === null, "mensaje sin cover → sin renglón");
  // Noche operativa por zona (igual que club_fecha_operacion en la base).
  revisar(nocheOperativaEn("America/Tijuana", new Date("2026-11-25T14:30:00Z")) === "2026-11-24" && nocheOperativaEn("America/Mexico_City", new Date("2026-11-25T14:30:00Z")) === "2026-11-25", "08:30 CDMX (06:30 Tijuana): en Tijuana sigue la noche del 24");
  revisar(nocheOperativaEn("America/Tijuana", new Date("2026-11-25T16:00:00Z")) === "2026-11-25", "08:00 de Tijuana → ya es la noche del 25");
  revisar(nocheOperativaEn("America/Cancun", new Date("2026-11-25T13:30:00Z")) === "2026-11-25" && nocheOperativaEn("America/Tijuana", new Date("2026-07-15T14:59:00Z")) === "2026-07-14", "Cancún adelante; Tijuana con horario de verano");
  revisar(nocheOperativaEn(null, new Date("2026-11-25T13:59:00Z")) === "2026-11-24" && nocheOperativaEn("Zona/Inventada", new Date("2026-11-25T14:00:00Z")) === "2026-11-25", "sin zona o zona desconocida → la de CDMX");
  revisar(ZONA_MAS_TARDIA_MEXICO === "America/Tijuana" && ["America/Mexico_City", "America/Cancun", "America/Hermosillo", "America/Mazatlan", "America/Chihuahua", "America/Ciudad_Juarez", "America/Monterrey", "America/Merida"].every((z) => ["2026-01-10T15:00:00Z", "2026-07-10T14:30:00Z", "2026-11-25T15:30:00Z"].every((t) => nocheOperativaEn(ZONA_MAS_TARDIA_MEXICO, new Date(t)) <= nocheOperativaEn(z, new Date(t)))), "la noche de Tijuana nunca va adelante de otra zona de México (respaldo de /r)");
  revisar(TEXTO_ESTADO.vigente.titulo === "Lugar apartado" && !/confirmad/i.test(JSON.stringify(TEXTO_ESTADO)), "el boleto dice «Lugar apartado», nunca «confirmada»");

  // Boletos guardados en el teléfono.
  const CLUB_X = randomUUID();
  const b = (fecha, extra = {}) => ({ qr: qr(), clubId: CLUB_X, clubNombre: "Club X", fecha, personas: 2, guardadoEn: Date.now(), ...extra });
  revisar(leerBoletos(null, "2026-11-24").length === 0 && leerBoletos("{no es json", "2026-11-24").length === 0 && leerBoletos('{"a":1}', "2026-11-24").length === 0, "basura o vacío → lista vacía");
  const alterado = [b("2026-11-25", { qr: "javascript:alert(1)" }), b("2026-11-25", { clubNombre: "" }), b("2026-11-25", { personas: 99 }), b("2026-11-25", { telefono: "5512345678" })];
  const leidos = leerBoletos(JSON.stringify(alterado), "2026-11-24");
  revisar(leidos.length === 1 && !("telefono" in leidos[0]), "solo pasan los de forma exacta y se tiran campos de más (teléfono)", JSON.stringify(leidos));
  const viejo = b("2026-11-23"), hoy = b("2026-11-24"), futuro = b("2026-11-28");
  let lista = agregarBoleto([], viejo, "2026-11-24");
  revisar(lista.length === 0, "uno de una noche pasada no se guarda");
  lista = agregarBoleto(agregarBoleto(lista, futuro, "2026-11-24"), hoy, "2026-11-24");
  lista = agregarBoleto(lista, { ...hoy, guardadoEn: Date.now() + 5 }, "2026-11-24");
  revisar(lista.length === 2 && lista[0].qr === hoy.qr, "sin repetidos; el más reciente primero");
  revisar(boletosDelClub(lista, CLUB_X).map((x) => x.fecha).join() === "2026-11-24,2026-11-28" && boletosDelClub(lista, randomUUID()).length === 0, "por antro, de la noche más próxima a la más lejana");
  revisar(leerBoletos(JSON.stringify(lista), "2026-11-25").length === 1, "al pasar su noche se purga solo");
  let muchos = [];
  for (let i = 0; i < 15; i++) muchos = agregarBoleto(muchos, b("2026-11-30", { guardadoEn: i }), "2026-11-24");
  revisar(muchos.length === MAX_BOLETOS && muchos[0].guardadoEn === 14, `máximo ${MAX_BOLETOS} boletos`);
  revisar(esCodigoQr(qr()) && !esCodigoQr("antro-1") && !esCodigoQr("x"), "solo códigos antro-<uuid>");
  // Purga con la zona de cada antro: a las 08:30 de CDMX (06:30 en Tijuana)
  // el de Tijuana de la noche del 24 sigue; el de CDMX de esa noche, no.
  const porZona = (zona) => nocheOperativaEn(zona, new Date("2026-11-25T14:30:00Z"));
  const tij = b("2026-11-24", { zona: "America/Tijuana" }), cdmx = b("2026-11-24", { zona: "America/Mexico_City" }), sinZona = b("2026-11-24");
  const purgados = leerBoletos(JSON.stringify([tij, cdmx, sinZona]), porZona);
  revisar(purgados.length === 1 && purgados[0].qr === tij.qr && purgados[0].zona === "America/Tijuana", "purga por la zona del antro (Tijuana sigue, CDMX y sin zona se van)", JSON.stringify(purgados));
  revisar(leerBoletos(JSON.stringify([b("2026-11-30", { zona: "<script>" }), b("2026-11-30", { zona: 5 })]), "2026-11-24").length === 0 && esZonaGuardable("America/Argentina/Buenos_Aires") && !esZonaGuardable("../x"), "zona con forma inválida → se descarta");

  // ======================= 2. Base (dev) =======================
  console.log("\n— Base: obtener_reserva_por_qr —");
  const db = await conectarDevEscritura();
  let noche, codigos;
  try {
    const [fn] = await db.q(`select p.prosecdef, p.proconfig::text as cfg, p.proacl::text as acl,
        pg_get_function_result(p.oid) as res
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'obtener_reserva_por_qr'`);
    revisar(!!fn && fn.prosecdef && /search_path=(\\"\\"|"")"?\}$/.test(fn.cfg), "SECURITY DEFINER con search_path vacío", JSON.stringify(fn));
    revisar(!!fn && /anon=X/.test(fn.acl) && /authenticated=X/.test(fn.acl) && /service_role=X/.test(fn.acl) && !/(^|[{,])=X/.test(fn.acl), "EXECUTE a anon, authenticated y service_role; nada a PUBLIC", fn?.acl);
    revisar(!!fn && /estado_boleto/.test(fn.res) && !/telefono|consumo|rp_id|cliente_id|mesa|entrada_en|source/.test(fn.res), "el tipo de retorno no tiene teléfono, consumo ni ids", fn?.res);

    // Dos antros propios: A publicado (con datos de puerta), B borrador.
    const [a] = await db.q(`insert into public.clubs (nombre, direccion, horario, ciudad, estado_verificacion, suscripcion_activa,
        cover_modo, cover_monto, tolerancia_hora, edad_minima, codigo_vestimenta)
      values ($1, 'Calle T cli 1, Centro', 'Jue a Sáb 10pm a 3am', 'Querétaro', 'verificado', true, 'monto', 350, '01:30', 21, 'Formal')
      returning id`, [`T cli Boleto ${TAG}`]);
    clubs.push(a.id);
    const [bb] = await db.q(`insert into public.clubs (nombre, direccion, horario, ciudad, estado_verificacion, suscripcion_activa,
        cover_modo, cover_monto, edad_minima)
      values ($1, 'Calle secreta 9', 'Vie', 'Querétaro', 'borrador', false, 'monto', 500, 18) returning id`, [`T cli Borrador ${TAG}`]);
    clubs.push(bb.id);
    // Publicados con «Entrada libre» (en Tijuana) y «Consultar con el antro».
    const [cl] = await db.q(`insert into public.clubs (nombre, direccion, horario, ciudad, estado_verificacion, suscripcion_activa, cover_modo, zona_horaria)
      values ($1, 'Calle T cli 2', 'Vie', 'Tijuana', 'verificado', true, 'libre', 'America/Tijuana') returning id`, [`T cli Libre ${TAG}`]);
    clubs.push(cl.id);
    const [cc] = await db.q(`insert into public.clubs (nombre, direccion, horario, ciudad, estado_verificacion, suscripcion_activa, cover_modo)
      values ($1, 'Calle T cli 3', 'Vie', 'Querétaro', 'verificado', true, 'consultar') returning id`, [`T cli Consultar ${TAG}`]);
    clubs.push(cc.id);
    [{ noche }] = await db.q(`select public.club_fecha_operacion($1, now())::text as noche`, [a.id]);

    codigos = { vigente: qr(), futuro: qr(), vencido: qr(), usada: qr(), entro: qr(), usadaVieja: qr(), enPuerta: qr(), borrador: qr() };
    const ayer = sumarDiasISO(noche, -1);
    const ins = (codigo, club, fecha, status) =>
      db.q(`insert into public.reservations (cliente_nombre, cliente_telefono, club_id, source, fecha, personas, status, qr_code)
            values ('T cli Prueba', '5500000000', $1, 'organica', $2, 3, $3, $4)`, [club, fecha, status, codigo]);
    await ins(codigos.vigente, a.id, noche, "pendiente");
    await ins(codigos.futuro, a.id, sumarDiasISO(noche, 3), "confirmada");
    await ins(codigos.vencido, a.id, ayer, "pendiente");
    await ins(codigos.usada, a.id, noche, "usada");
    await db.q(`insert into public.reservations (cliente_nombre, cliente_telefono, club_id, source, fecha, personas, status, qr_code, puerta_estado, entrada_en)
                values ('T cli Prueba', '5500000000', $1, 'organica', $2, 3, 'confirmada', $3, 'entro', now())`, [a.id, noche, codigos.entro]);
    await ins(codigos.usadaVieja, a.id, ayer, "usada");
    await db.q(`insert into public.reservations (cliente_nombre, cliente_telefono, club_id, source, fecha, personas, status, qr_code, puerta_estado, en_puerta_en)
                values ('T cli Prueba', '5500000000', $1, 'organica', $2, 3, 'pendiente', $3, 'en_puerta', now())`, [a.id, noche, codigos.enPuerta]);
    await ins(codigos.borrador, bb.id, noche, "pendiente");
  } finally {
    await db.fin();
  }

  const pedir = async (cli, codigo) => cli.rpc("obtener_reserva_por_qr", { p_qr: codigo }).maybeSingle();
  const esperado = { vigente: "vigente", futuro: "vigente", vencido: "vencido", usada: "usado", entro: "usado", usadaVieja: "usado", enPuerta: "vigente", borrador: "vigente" };
  const LLAVES = ["cliente_nombre", "fecha", "personas", "status", "qr_code", "club_nombre", "estado_boleto", "club_direccion", "cover_modo", "cover_monto", "tolerancia_hora", "edad_minima", "codigo_vestimenta"].sort().join();
  for (const [k, codigo] of Object.entries(codigos)) {
    const { data, error } = await pedir(anon, codigo);
    revisar(!error && data?.estado_boleto === esperado[k], `anónimo, ${k}: ${esperado[k]}`, JSON.stringify(error ?? data));
    if (k === "vigente") {
      revisar(Object.keys(data ?? {}).sort().join() === LLAVES, "la respuesta trae exactamente las 13 columnas públicas", Object.keys(data ?? {}).join());
      const texto = JSON.stringify(data);
      revisar(!texto.includes("5500000000") && !texto.includes(clubs[0]), "sin teléfono ni id del antro en la respuesta");
      revisar(data?.club_direccion === "Calle T cli 1, Centro" && data?.cover_modo === "monto" && Number(data?.cover_monto) === 350 && data?.tolerancia_hora === "01:30:00" && data?.edad_minima === 21 && data?.codigo_vestimenta === "Formal", "antro publicado: dirección y datos de la puerta", texto);
      revisar(data?.fecha === noche, `la noche operativa de la base (${noche}) coincide`);
    }
    if (k === "borrador") {
      revisar(data?.club_nombre?.startsWith("T cli Borrador") && data.club_direccion === null && data.cover_modo === null && data.cover_monto === null && data.edad_minima === null, "antro NO publicado: solo el nombre, sin dirección ni cover", JSON.stringify(data));
    }
  }
  const nada = await pedir(anon, qr());
  revisar(!nada.error && nada.data === null, "código inexistente → nada");
  const vacio = await pedir(anon, "");
  revisar(!vacio.error && vacio.data === null, "código vacío → nada");
  const comodin = await pedir(anon, "%");
  revisar(!comodin.error && comodin.data === null, "comodín «%» no lista nada (igualdad exacta)");
  const directo = await anon.from("reservations").select("id, cliente_telefono").eq("qr_code", codigos.vigente);
  revisar((directo.data ?? []).length === 0, "el anónimo no lee reservations directo");

  // Con sesión (cliente propio de la prueba): misma respuesta.
  const correo = `t_cli_cliente_${TAG}@example.com`;
  const clave = "T-" + randomBytes(12).toString("base64url");
  const { data: cu, error: cuErr } = await svc.auth.admin.createUser({ email: correo, password: clave, email_confirm: true });
  if (cuErr) throw new Error("crear cliente: " + cuErr.message);
  usuarios.push(cu.user.id);
  {
    const db2 = await conectarDevEscritura();
    try {
      await db2.q(`insert into public.profiles (id, nombre, role) values ($1, 'T cli Cliente', 'cliente')`, [cu.user.id]);
    } finally { await db2.fin(); }
  }
  const cliCli = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  const login = await cliCli.auth.signInWithPassword({ email: correo, password: clave });
  revisar(!login.error, "cliente de prueba inicia sesión", login.error?.message);
  const conSesion = await pedir(cliCli, codigos.usada);
  revisar(!conSesion.error && conSesion.data?.estado_boleto === "usado", "con sesión de cliente: misma respuesta");

  // ======================= 3. Pantallas (Playwright) =======================
  if (!BASE) {
    console.log("\n(Sin URL: no se prueban pantallas. Pasa http://localhost:3024 y PLAYWRIGHT_DESDE.)");
  } else if (!process.env.PLAYWRIGHT_DESDE) {
    revisar(false, "falta PLAYWRIGHT_DESDE para las pantallas");
  } else {
    console.log(`\n— Pantallas en ${BASE} —`);
    mkdirSync(SHOTS, { recursive: true });
    const { chromium } = await import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
    const nav = await chromium.launch();
    const clubA = clubs[0];
    try {
      for (const [ancho, alto] of [[390, 844], [360, 740]]) {
        const ctx = await nav.newContext({ viewport: { width: ancho, height: alto }, locale: "es-MX" });
        // Sin hoja de compartir: el botón copia el enlace (y así se puede revisar).
        await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "share", { value: undefined }); } catch {} });
        await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
        const p = await ctx.newPage();
        let errores = [];
        p.on("pageerror", (e) => errores.push(e.message.slice(0, 140)));
        p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Error cargando boleto/.test(m.text())) errores.push(m.text().slice(0, 140)); });
        const toma = async (nombre) => {
          await p.waitForTimeout(400);
          const anchoDoc = await p.evaluate(() => document.documentElement.scrollWidth);
          revisar(anchoDoc <= ancho, `${nombre} @${ancho}: sin scroll horizontal`, `${anchoDoc}px`);
          const chicos = await p.evaluate(() => [...document.querySelectorAll('[data-slot="card"] a, [data-slot="card"] button, [data-prueba="boleto-guardado"] a')]
            .filter((el) => el.offsetParent !== null)
            .map((el) => ({ t: (el.textContent || "").trim().slice(0, 30), h: el.getBoundingClientRect().height }))
            .filter((x) => x.h < 40));
          revisar(chicos.length === 0, `${nombre} @${ancho}: áreas táctiles ≥ 40 px`, JSON.stringify(chicos));
          revisar(errores.length === 0, `${nombre} @${ancho}: sin errores en consola`, errores.join(" | "));
          errores = [];
          await p.screenshot({ path: `${SHOTS}${nombre}-${ancho}.png`, fullPage: true });
        };

        // a) Reserva sin cuenta → confirmación.
        await p.goto(`${BASE}/cliente/reservar?club=${clubA}`);
        await p.waitForSelector("#nombre", { timeout: 90000 });
        await p.fill("#nombre", `T cli Anónimo ${ancho}`);
        await p.fill("#telefono", "5500000000");
        await p.fill("#fecha", noche);
        await p.getByRole("button", { name: "Apartar lugar" }).click();
        const conf = p.locator('[data-prueba="confirmacion"]');
        const llego = await conf.waitFor({ timeout: 30000 }).then(() => true, () => false);
        revisar(llego, `@${ancho}: aparece la confirmación`);
        if (llego) {
          const t = await conf.innerText();
          revisar(/Lugar apartado/.test(t) && !/confirmada/i.test(t), `@${ancho}: dice «Lugar apartado», no «confirmada»`);
          revisar(/Calle T cli 1, Centro/.test(t) && new RegExp(`T cli Boleto ${TAG}`).test(t), `@${ancho}: antro y dirección`);
          revisar(/(lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d{1,2} de [a-z]+/i.test(t) && !t.includes(noche), `@${ancho}: fecha larga en español (no ISO)`);
          revisar(/\$350/.test(t) && /lo cobra el antro/i.test(t) && /AntroApp no te cobra nada/.test(t), `@${ancho}: cover informativo con aviso de que la app no cobra`);
          revisar(/El QR no garantiza el acceso/.test(t) && /derecho de admisión/.test(t) && /Edad mínima/.test(t) && /1:30 a\. m\./.test(t), `@${ancho}: aviso del QR, edad y hora límite`);
          revisar(/guardado en este teléfono/.test(t), `@${ancho}: avisa que quedó guardado en el teléfono`);
          const href = await p.locator("a", { hasText: "Ver mi boleto" }).getAttribute("href");
          revisar(/^\/r\/antro-[0-9a-f-]{36}$/.test(href ?? ""), `@${ancho}: «Ver mi boleto» lleva a /r/<código>`, href);
          await toma("confirmacion");
          await p.getByRole("button", { name: "Guardar o compartir enlace" }).click();
          const copiado = await p.getByText("Enlace copiado").waitFor({ timeout: 5000 }).then(() => true, () => false);
          const portapapeles = await p.evaluate(() => navigator.clipboard.readText()).catch(() => "");
          revisar(copiado && portapapeles === `${BASE}${href}`, `@${ancho}: sin hoja de compartir, copia el enlace del boleto`, portapapeles);
          const guardado = await p.evaluate((k) => localStorage.getItem(k), CLAVE_BOLETOS);
          revisar(!!guardado && guardado.includes(href.slice(3)) && !guardado.includes("5500000000") && !guardado.includes("Anónimo"), `@${ancho}: en el teléfono solo el código (sin teléfono ni nombre)`, guardado);

          // b) Recarga: no pierde el QR.
          await p.reload();
          const aviso = p.locator('[data-prueba="boleto-guardado"] a').first();
          const hay = await aviso.waitFor({ timeout: 30000 }).then(() => true, () => false);
          revisar(hay && (await aviso.getAttribute("href")) === href, `@${ancho}: al recargar aparece «Ya apartaste lugar… Ver boleto»`);
          await toma("reservar-con-boleto-guardado");
          if (hay) {
            await aviso.click();
            await p.waitForURL(/\/r\/antro-/, { timeout: 30000 }).catch(() => {});
            const est = await p.locator('[data-prueba="estado-boleto"]').getAttribute("data-estado", { timeout: 30000 }).catch(() => null);
            revisar(est === "vigente" && (await p.locator('[data-prueba="qr-boleto"]').count()) === 1, `@${ancho}: el boleto recién apartado está vigente y con QR`);
          }
        }

        // a2) Antros con «Entrada libre» y «Consultar»: ningún texto dice que
        // el antro cobra el cover; el mensaje de WhatsApp tampoco.
        for (const [modo, clubM, fechaM] of [["libre", clubs[2], noche], ["consultar", clubs[3], noche]]) {
          await p.goto(`${BASE}/cliente/reservar?club=${clubM}`);
          await p.waitForSelector("#nombre", { timeout: 90000 });
          const desc = await p.locator('[data-slot="card-description"]').first().innerText();
          revisar(!/lo cobra el antro/i.test(desc) && (modo === "libre" ? /Entrada libre en la puerta/.test(desc) : /pregúntalo al antro/.test(desc)), `@${ancho} formulario ${modo}: sin «lo cobra el antro»`, desc);
          await p.fill("#nombre", `T cli Anónimo ${modo} ${ancho}`);
          await p.fill("#telefono", "5500000000");
          await p.fill("#fecha", fechaM);
          await p.getByRole("button", { name: "Apartar lugar" }).click();
          const confM = p.locator('[data-prueba="confirmacion"]');
          const okM = await confM.waitFor({ timeout: 30000 }).then(() => true, () => false);
          revisar(okM, `@${ancho} ${modo}: aparece la confirmación`);
          if (!okM) continue;
          const tM = await confM.innerText();
          const avisoM = await p.locator('[data-prueba="aviso-cover"]').innerText().catch(() => "");
          revisar(!/lo cobra el antro/i.test(tM) && (modo === "libre" ? /Entrada libre/.test(tM) && /No hay cover/.test(avisoM) : /Consultar con el antro/.test(tM) && /Pregunta el cover/.test(avisoM)), `@${ancho} confirmación ${modo}: aviso según el modo`, avisoM);
          const wa = await p.locator('a[href^="https://wa.me"]').first().getAttribute("href");
          const msj = decodeURIComponent(new URL(wa).searchParams.get("text") ?? "");
          revisar(!/lo cobra el antro/i.test(msj) && (modo === "libre" ? /Entrada libre en la puerta \(la app tampoco cobra nada\)/.test(msj) : /El cover pregúntalo al antro/.test(msj)), `@${ancho} WhatsApp ${modo}: renglón del cover según el modo`, msj);
          const hrefM = await p.locator("a", { hasText: "Ver mi boleto" }).getAttribute("href");
          const guardadoM = JSON.parse((await p.evaluate((k) => localStorage.getItem(k), CLAVE_BOLETOS)) ?? "[]").find((x) => `/r/${x.qr}` === hrefM);
          if (modo === "libre") revisar(guardadoM?.zona === "America/Tijuana", `@${ancho}: el boleto guardado lleva la zona del antro (Tijuana)`, JSON.stringify(guardadoM));
          await toma(`confirmacion-${modo}`);
          await p.goto(`${BASE}${hrefM}`);
          await p.locator('[data-prueba="estado-boleto"]').waitFor({ timeout: 60000 }).catch(() => {});
          const tR = await p.locator('[data-slot="card"]').innerText();
          const waR = await p.locator('a[href^="https://wa.me"]').first().getAttribute("href").catch(() => null);
          const msjR = waR ? decodeURIComponent(new URL(waR).searchParams.get("text") ?? "") : "";
          revisar(!/lo cobra el antro/i.test(tR + msjR) && (modo === "libre" ? /No hay cover/.test(tR) : /Pregunta el cover/.test(tR)) && msjR.length > 0, `@${ancho} r-${modo}: boleto y WhatsApp sin «lo cobra el antro»`, tR.slice(0, 200));
          await toma(`r-${modo}`);
        }

        // c) /r en cada estado.
        const casos = [["vigente", codigos.vigente, true], ["usado", codigos.entro, false], ["vencido", codigos.vencido, false], ["vigente", codigos.borrador, true]];
        for (const [estado, codigo, conQr] of casos) {
          await p.goto(`${BASE}/r/${codigo}`);
          const insignia = p.locator('[data-prueba="estado-boleto"]');
          const est = await insignia.getAttribute("data-estado", { timeout: 60000 }).catch(() => null);
          const qrs = await p.locator('[data-prueba="qr-boleto"]').count();
          const nombreToma = codigo === codigos.borrador ? "r-borrador" : `r-${estado}`;
          revisar(est === estado && (qrs === 1) === conQr, `@${ancho} ${nombreToma}: estado ${estado} y QR ${conQr ? "visible" : "oculto"}`, `${est} qr=${qrs}`);
          const t = await p.locator('[data-slot="card"]').innerText();
          if (codigo === codigos.vigente) revisar(/\$350/.test(t) && /lo cobra el antro/i.test(t) && /El QR no garantiza el acceso/.test(t) && /Calle T cli 1/.test(t), `@${ancho} r-vigente: cover, aviso y dirección`);
          if (codigo === codigos.borrador) revisar(!/Calle secreta/.test(t) && !/\$500/.test(t), `@${ancho} r-borrador: sin dirección ni cover del antro no publicado`);
          if (estado === "usado") revisar(/ya se usó/i.test(t), `@${ancho} r-usado: explica que ya se usó`);
          if (estado === "vencido") revisar(/venció/.test(t), `@${ancho} r-vencido: explica que venció`);
          await toma(nombreToma);
        }
        await p.goto(`${BASE}/r/${qr()}`);
        const nf = await p.getByText("Boleto no encontrado").waitFor({ timeout: 60000 }).then(() => true, () => false);
        revisar(nf, `@${ancho}: código inexistente → «Boleto no encontrado»`);
        await toma("r-no-encontrado");
        // Sin red al pedir el boleto: no afirma nada del estado de la reserva.
        await p.route("**/rest/v1/rpc/obtener_reserva_por_qr*", (r) => r.abort("internetdisconnected"));
        await p.goto(`${BASE}/r/${codigos.vencido}`);
        const sinRed = await p.getByText("No pudimos cargar tu boleto").waitFor({ timeout: 60000 }).then(() => true, () => false);
        const tRed = sinRed ? await p.locator('[data-slot="card"]').innerText() : "";
        revisar(sinRed && !/sigue apartado/i.test(tRed) && /Intentar de nuevo/.test(tRed), `@${ancho} r sin red: no asegura que el lugar sigue apartado`, tRed);
        await p.unroute("**/rest/v1/rpc/obtener_reserva_por_qr*");
        errores = [];
        await p.screenshot({ path: `${SHOTS}r-sin-red-${ancho}.png`, fullPage: true });
        await ctx.close();
      }

      // d) Ficha y perfil con sesión de cliente (390 y 360).
      for (const [ancho, alto] of [[390, 844], [360, 740]]) {
        const ctx = await nav.newContext({ viewport: { width: ancho, height: alto }, locale: "es-MX" });
        const p = await ctx.newPage();
        await p.goto(`${BASE}/cliente/login`);
        await p.fill("#email", correo);
        await p.fill("#password", clave);
        await p.click("button[type=submit]");
        await p.waitForURL(/\/cliente\/?$/, { timeout: 90000 }).catch(() => {});
        revisar(/\/cliente\/?$/.test(new URL(p.url()).pathname), `@${ancho}: cliente de prueba entra`, p.url());
        // Reserva con sesión (para el perfil), por la pantalla.
        await p.goto(`${BASE}/cliente/reservar?club=${clubA}`);
        await p.waitForSelector("#fecha", { timeout: 90000 });
        await p.fill("#telefono", "5500000000");
        await p.fill("#fecha", sumarDiasISO(noche, ancho === 390 ? 1 : 2));
        await p.getByRole("button", { name: "Apartar lugar" }).click();
        const ok = await p.locator('[data-prueba="confirmacion"]').waitFor({ timeout: 30000 }).then(() => true, () => false);
        revisar(ok && /Mi perfil/.test(await p.locator('[data-prueba="aviso-guardado"]').innerText()), `@${ancho}: con cuenta, la confirmación remite a Mi perfil`);
        revisar((await p.evaluate((k) => localStorage.getItem(k), CLAVE_BOLETOS)) === null, `@${ancho}: con cuenta no se guarda el boleto en el teléfono`);
        await p.goto(`${BASE}/cliente/${clubA}`);
        const cover = p.locator('[data-prueba="cover-ficha"]');
        const hay = await cover.waitFor({ timeout: 60000 }).then(() => true, () => false);
        revisar(hay && /\$350/.test(await cover.innerText()) && /lo cobra el antro/i.test(await cover.innerText()), `@${ancho} ficha monto: cover con aviso de quién lo cobra`);
        await p.waitForTimeout(600);
        revisar(!(await p.locator('[data-prueba="boleto-guardado"]').isVisible().catch(() => false)), `@${ancho} ficha con cuenta: sin «Ya apartaste lugar» de otro`);
        revisar(/1:30 a\. m\./.test(await p.locator("body").innerText()), `@${ancho} ficha: hora límite de llegada`);
        await p.waitForTimeout(600);
        await p.screenshot({ path: `${SHOTS}ficha-${ancho}.png`, fullPage: true });
        for (const [modo, clubM] of [["libre", clubs[2]], ["consultar", clubs[3]]]) {
          await p.goto(`${BASE}/cliente/${clubM}`);
          const cv = p.locator('[data-prueba="cover-ficha"]');
          const hayM = await cv.waitFor({ timeout: 60000 }).then(() => true, () => false);
          const tv = hayM ? await cv.innerText() : "";
          revisar(hayM && !/lo cobra el antro/i.test(tv) && (modo === "libre" ? /Entrada libre/.test(tv) && /No hay cover/.test(tv) : /consultar con el antro/i.test(tv) && /Pregunta el cover/.test(tv)), `@${ancho} ficha ${modo}: aviso según el modo`, tv);
          await p.waitForTimeout(400);
          await p.screenshot({ path: `${SHOTS}ficha-${modo}-${ancho}.png`, fullPage: true });
        }
        await p.goto(`${BASE}/cliente/perfil`);
        const ver = p.getByRole("link", { name: /Ver boleto/ }).first();
        const hayVer = await ver.waitFor({ timeout: 60000 }).then(() => true, () => false);
        revisar(hayVer && /^\/r\/antro-/.test((await ver.getAttribute("href")) ?? ""), `@${ancho} perfil: enlace «Ver boleto»`);
        const tp = await p.locator("body").innerText();
        revisar(/(lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d{1,2} de/i.test(tp), `@${ancho} perfil: fecha legible`);
        await p.waitForTimeout(400);
        await p.screenshot({ path: `${SHOTS}perfil-${ancho}.png`, fullPage: true });
        // Cerrar sesión borra los boletos guardados en el teléfono.
        await p.evaluate(([k, v]) => localStorage.setItem(k, v), [CLAVE_BOLETOS, JSON.stringify([{ qr: qr(), clubId: clubA, clubNombre: "T cli", fecha: sumarDiasISO(noche, 5), personas: 2, guardadoEn: Date.now() }])]);
        await p.getByRole("button", { name: "Cerrar sesión" }).click();
        await p.waitForURL(/\/cliente\/login/, { timeout: 30000 }).catch(() => {});
        revisar((await p.evaluate((k) => localStorage.getItem(k), CLAVE_BOLETOS)) === null, `@${ancho}: al cerrar sesión se borran los boletos del teléfono`);
        await ctx.close();
      }
    } finally {
      await nav.close();
    }
  }
} catch (e) {
  revisar(false, "error inesperado: " + e.message);
} finally {
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    if (clubs.length) await db.q("delete from public.reservations where club_id = any($1::uuid[])", [clubs]);
    if (usuarios.length) await db.q("delete from public.reservations where cliente_id = any($1::uuid[])", [usuarios]);
    if (usuarios.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [usuarios]);
    // Los intentos que cuenta el antiabuso de reservas sin cuenta (si está
    // aplicado): solo los de los antros de esta prueba.
    const [{ hay: hayIntentos }] = await db.q("select to_regclass('public.reserva_intentos') is not null as hay");
    if (hayIntentos && clubs.length) await db.q("delete from public.reserva_intentos where club_id = any($1::uuid[])", [clubs]);
    if (clubs.length) await db.q("delete from public.clubs where id = any($1::uuid[])", [clubs]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback");
    console.log("Limpieza falló: " + e.message);
  } finally {
    await db.fin();
  }
  for (const id of usuarios) await svc.auth.admin.deleteUser(id);
  console.log(`\nLimpieza: ${clubs.length} antros, sus reservas y ${usuarios.length} cuenta(s) de prueba borrados.`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan) process.exitCode = 1;
}
