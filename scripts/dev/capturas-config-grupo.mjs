// Configuración por grupo (B3) en el navegador, a 390×844 y 360×740:
//   - el dueño del grupo: enlace en /grupo, /grupo/configuracion (valores,
//     antros con «Del grupo» / «Propio», «Volver al del grupo», bitácora),
//     guardar un valor, un error de validación;
//   - el gerente y el dueño de un antro del grupo: la tarjeta «Configuración
//     del grupo» en «Reglas de pago» con «Usar uno propio»;
//   - el admin: el paso «Grupo» del alta (clon dentro del grupo) con la
//     elección «Usar la del grupo / lo de este alta».
// Mide desborde horizontal, controles de menos de 40 px y errores de la
// página. Revisa en la base lo que se guardó. Capturas en screenshots-b-alta/.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/capturas-config-grupo.mjs [http://localhost:3021]
//
// Crea sus propias cuentas (t_alta_…), antros («T alta CG UI …») y grupo, y
// los borra al final aunque algo falle. dev_admin solo inicia sesión.

import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verificarEnvDev, conectarDevEscritura } from "../db/conexion.mjs";

const env = verificarEnvDev();
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(RAIZ, "package.json"));
async function cargarPlaywright() {
  try {
    return req("playwright");
  } catch {
    if (process.env.PLAYWRIGHT_DESDE) return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
    console.log("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
    process.exit(1);
  }
}
const { chromium } = await cargarPlaywright();
const { createClient } = req("@supabase/supabase-js");
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);
const BASE = (process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3021").replace(/\/$/, "");
const { password: PASS_DEV } = JSON.parse(readFileSync(path.join(RAIZ, "backups/dev-credenciales.json"), "utf8"));
const SALIDA = path.join(RAIZ, "screenshots-b-alta");
mkdirSync(SALIDA, { recursive: true });

let pasan = 0, fallan = 0;
function revisar(cond, texto, detalle = "") {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto + (cond || !detalle ? "" : "  — " + detalle));
}
const TAG = "cgui" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const ids = [];
const clubIds = [];
let grupo = null;
const ok = (r, d) => {
  if (r.error) throw new Error(`${d}: ${r.error.message}`);
  return r.data;
};

// alcance: medir los controles solo dentro de ese selector (en los paneles
// grandes, solo lo de este bloque; el desborde siempre de toda la página).
async function medir(p, alcance = "body") {
  return p.evaluate((alcance) => {
    const desborde = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const chicos = [];
    const raiz = document.querySelector(alcance) ?? document.body;
    for (const el of raiz.querySelectorAll("button, input, select, summary, a")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      const objetivo = el.matches("input[type=radio], input[type=checkbox]") ? el.closest("label") : el;
      const h = objetivo ? objetivo.getBoundingClientRect().height : r.height;
      if (h < 40 && !el.closest(".sr-only")) chicos.push((el.getAttribute("aria-label") || el.textContent || el.id || el.tagName).trim().slice(0, 40) + ` (${Math.round(h)} px)`);
    }
    return { desborde, chicos: [...new Set(chicos)] };
  }, alcance);
}

async function cuenta(clave, role, club_id = null) {
  const email = `t_alta_${TAG}_${clave}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "usuario " + clave);
  ids.push(u.user.id);
  ok(await svc.from("profiles").insert({ id: u.user.id, nombre: `${clave} ${TAG}`, role, club_id, activo: true }), "perfil " + clave);
  return { id: u.user.id, email };
}

const db = await conectarDevEscritura();
const q = db.q;
const navegador = await chromium.launch();
try {
  // ---------- Escenario ----------
  const duenoG = await cuenta("duenog", "dueno");
  const duenoA = await cuenta("duenoa", "dueno");
  const nuevo = async (k, extra = {}) => {
    const c = ok(await svc.from("clubs").insert({ nombre: `T alta CG UI ${k} ${TAG}`, direccion: "Calle 1", ciudad: "Guadalajara", horario: "Vie y sáb", pago_rp_modo: "reserva", ...extra }).select("id").single(), "club " + k);
    clubIds.push(c.id);
    return c.id;
  };
  const A = await nuevo("A", { dueno_id: duenoA.id });
  const B = await nuevo("B");
  await svc.from("club_tables").insert([{ club_id: A, numero: "1", capacidad: 4 }]);
  await cuenta("gerentea", "gerente", A);
  grupo = ok(await svc.from("grupos").insert({ nombre: `T alta grupo UI ${TAG}` }).select("id").single(), "grupo").id;
  ok(await svc.from("grupo_miembros").insert({ grupo_id: grupo, profile_id: duenoG.id, rol_grupo: "dueno_grupo" }), "miembro");
  ok(await svc.from("grupo_clubs").insert([{ grupo_id: grupo, club_id: A }, { grupo_id: grupo, club_id: B }]), "grupo_clubs");
  // Como si hubieran entrado por el alta con «usar lo del grupo».
  await q("delete from public.club_config_propia where club_id = any($1::uuid[])", [[A, B]]);

  // Valores del grupo (por la función, con la sesión del dueño del grupo) y un cover propio de A.
  const sG = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  ok(await sG.auth.signInWithPassword({ email: duenoG.email, password: PASS }), "login dueño grupo");
  const def = (clave, valor, bloqueado = false) => sG.rpc("grupo_config_cambiar", { p_grupo: grupo, p_clave: clave, p_valor: valor, p_bloqueado: bloqueado });
  ok(await def("regla_comision", { tipo: "cuota", cuota: 3, monto_centavos: 20000 }), "regla");
  ok(await def("visibilidad_rp", "estado"), "visibilidad");
  ok(await def("cover", { cover_modo: "monto", cover_monto_centavos: 15000 }), "cover");
  ok(await def("caja_permisos", [{ permiso: "cobrar", rol: "staff", permitido: false }], true), "permisos");
  const sA = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
  ok(await sA.auth.signInWithPassword({ email: duenoA.email, password: PASS }), "login dueño A");
  ok(await sA.from("clubs").update({ cover_modo: "libre", cover_monto: null }).eq("id", A), "cover propio A");

  for (const [ancho, alto] of [[390, 844], [360, 740]]) {
    const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, deviceScaleFactor: 2 });
    const errores = [];
    const nueva = async () => {
      const p = await ctx.newPage();
      p.on("pageerror", (e) => errores.push(e.message.slice(0, 140)));
      p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Download the React|status of 400/.test(m.text())) errores.push(m.text().slice(0, 140)); });
      return p;
    };
    const foto = (p, nombre) => p.screenshot({ path: path.join(SALIDA, `${ancho}-grupo-${nombre}.png`), fullPage: true });
    const verificar = async (p, nombre, alcance) => {
      const m = await medir(p, alcance);
      revisar(!m.desborde, `${ancho} px · ${nombre}: sin desborde horizontal`);
      revisar(m.chicos.length === 0, `${ancho} px · ${nombre}: ningún control de menos de 40 px`, m.chicos.join(", "));
    };
    const entrar = async (p, email, pass) => {
      await ctx.clearCookies();
      await p.goto(BASE + "/cliente/login");
      await p.fill("#email", email);
      await p.fill("#password", pass);
      await p.click("button[type=submit]");
    };

    // ---------- Dueño del grupo ----------
    let p = await nueva();
    await entrar(p, duenoG.email, PASS);
    // Dueño de grupo sin antro propio: el login lo lleva a /dueno/panel y de ahí a /grupo.
    await p.waitForURL(/\/grupo(\?|$)/, { timeout: 90000 });
    const enlace = p.getByRole("link", { name: "Configuración del grupo" });
    await enlace.waitFor({ timeout: 60000 });
    revisar(await enlace.isVisible(), `${ancho} px · /grupo: el dueño del grupo ve «Configuración del grupo»`);
    await foto(p, "panel");
    await enlace.click();
    await p.waitForURL(/\/grupo\/configuracion/, { timeout: 60000 });
    await p.getByRole("heading", { name: "Antros del grupo" }).waitFor({ timeout: 60000 });
    const texto = await p.locator("body").innerText();
    revisar(texto.includes(`T alta grupo UI ${TAG}`) && /Las primeras 3 reservas de la semana no pagan/.test(texto) && (ancho === 390 ? /Solo el estado/ : /Estado, monto y botellas/).test(texto), `${ancho} px · se ven el grupo, la regla de cuota y lo que ven los RPs`);
    // En la segunda pasada (360) el grupo ya define todo (la de 390 guardó el modo y la hora límite).
    revisar(/Bloqueado/.test(texto) && (ancho !== 390 || /Sin definir/.test(texto)), `${ancho} px · insignias «Bloqueado»${ancho === 390 ? " y «Sin definir»" : ""}`);
    await foto(p, "config");
    await verificar(p, "/grupo/configuracion");

    // Abrir el editor de la regla con monto vacío: error de validación.
    const tarjetaRegla = p.locator("div[data-slot=card]").filter({ has: p.getByRole("heading", { name: "Regla de comisión" }) });
    await tarjetaRegla.locator("summary").click();
    await tarjetaRegla.getByLabel(/^Pago desde la reserva/).fill("");
    await tarjetaRegla.getByRole("button", { name: /^Programar desde el/ }).click();
    await tarjetaRegla.getByText("Escribe un monto entre $0.01 y $100,000.").waitFor({ timeout: 15000 });
    revisar(true, `${ancho} px · regla sin monto: dice qué falta y no guarda`);
    await foto(p, "config-error");
    await verificar(p, "editor de la regla");

    // Modo de pago: no espera al lunes (excepción explícita): hay que confirmarlo.
    const tModo = p.locator("div[data-slot=card]").filter({ has: p.getByRole("heading", { name: "Cómo se paga a los RPs" }) });
    await tModo.locator("summary").click();
    const guardarModo = tModo.getByRole("button", { name: "Guardar para el grupo" });
    revisar(await guardarModo.isDisabled(), `${ancho} px · modo de pago: «Guardar» desactivado hasta confirmar`);
    revisar((await tModo.getByText(/No espera al lunes: cambia al momento/).isVisible()) && (await tModo.getByText(/Entiendo que cambia al momento en (\d+ antros|1 antro|ningún)/).isVisible()),
      `${ancho} px · modo de pago: dice que cambia al momento y en cuántos antros`);
    if (ancho === 390) {
      await tModo.getByText("Por día trabajado").click();
      await tModo.locator("input[inputmode=decimal]").first().fill("300");
      await tModo.getByText(/^Bloquear/).click();
      await tModo.getByText(/Entiendo que cambia al momento/).click();
      await foto(p, "config-modo");
      await verificar(p, "editor del modo de pago");
      await guardarModo.click();
      await tModo.getByText(/Guardado\. 2 antros lo siguen\./).waitFor({ timeout: 30000 });
      const m = await q("select pago_rp_modo, (select count(*)::int from public.club_dia_tarifas where club_id = $1) t from public.clubs where id = $1", [A]);
      revisar(m[0].pago_rp_modo === "dia" && m[0].t === 1, "modo por día bloqueado del grupo: A paga por día con 1 tarifa", JSON.stringify(m));
    } else {
      await foto(p, "config-modo");
    }

    if (ancho === 390) {
      // Guardar «qué ven los RPs» para el grupo.
      const tVis = p.locator("div[data-slot=card]").filter({ has: p.getByRole("heading", { name: "Qué ven los RPs" }) });
      await tVis.locator("summary").click();
      await tVis.getByLabel("Estado, monto y botellas").check();
      await tVis.getByRole("button", { name: "Guardar para el grupo" }).click();
      await tVis.getByText(/Guardado\. 2 antros lo siguen\./).waitFor({ timeout: 30000 });
      const v = await q("select public.rp_nivel_visibilidad($1) a, public.rp_nivel_visibilidad($2) b", [A, B]);
      revisar(v[0].a === "estado_monto_botellas" && v[0].b === "estado_monto_botellas", "guardar en la pantalla del grupo llega a los 2 antros", JSON.stringify(v));
      // Hora límite (no definida): definirla.
      const tTol = p.locator("div[data-slot=card]").filter({ has: p.getByRole("heading", { name: "Hora límite de llegada" }) });
      await tTol.locator("summary").click();
      await tTol.locator("input[type=time]").fill("01:30");
      await tTol.getByRole("button", { name: "Guardar para el grupo" }).click();
      await tTol.getByText(/Guardado\./).waitFor({ timeout: 30000 });
      const t = await q("select to_char(tolerancia_hora, 'HH24:MI') t from public.clubs where id = $1", [B]);
      revisar(t[0].t === "01:30", "la hora límite del grupo llega a B");
      // A tiene su cover propio: «Volver al del grupo».
      const tarjetaA = p.locator("div[data-slot=card]").filter({ has: p.getByRole("heading", { name: new RegExp(`T alta CG UI A ${TAG}`) }) });
      const filaCover = tarjetaA.locator("li").filter({ hasText: "Cover" });
      revisar(await filaCover.getByText("Propio").isVisible(), "A aparece con su cover «Propio»");
      await foto(p, "config-antros");
      await filaCover.getByRole("button", { name: "Volver al del grupo" }).click();
      await p.getByText(/ya sigue al grupo en «Cover»/).waitFor({ timeout: 30000 });
      const c = await q("select cover_modo, cover_monto::text m, (select count(*)::int from public.club_config_propia where club_id = $1 and clave = 'cover') n from public.clubs where id = $1", [A]);
      revisar(c[0].cover_modo === "monto" && c[0].m === "150.00" && c[0].n === 0, "«Volver al del grupo»: A toma el cover de $150 y deja de ser propio", JSON.stringify(c));
      await p.locator("details summary").filter({ hasText: "Cambios del grupo" }).click();
      revisar(/volvió al del grupo en «Cover»/.test(await p.locator("body").innerText()), "la bitácora lo registra");
      await foto(p, "config-bitacora");
      await verificar(p, "antros y bitácora");
    }
    await p.close();

    // ---------- Gerente de A ----------
    p = await nueva();
    await entrar(p, `t_alta_${TAG}_gerentea@example.com`, PASS);
    await p.waitForURL(/\/staff\/panel/, { timeout: 90000 });
    const tarjeta = p.locator("div[data-slot=card]").filter({ has: p.getByRole("heading", { name: /Configuración del grupo «/ }) });
    await tarjeta.waitFor({ timeout: 90000 });
    await tarjeta.scrollIntoViewIfNeeded();
    const tg = await tarjeta.innerText();
    revisar(/Del grupo/.test(tg) && /Bloqueado por el grupo/.test(tg), `${ancho} px · gerente: tarjeta con «Del grupo» y «Bloqueado por el grupo»`);
    await tarjeta.screenshot({ path: path.join(SALIDA, `${ancho}-grupo-gerente.png`) });
    await verificar(p, "tarjeta del grupo (gerente)", "#origen-config-grupo");
    if (ancho === 390) {
      const filaRegla = tarjeta.locator("li").filter({ hasText: "Regla de comisión" });
      revisar((await tarjeta.locator("li").filter({ hasText: "Permisos de caja" }).getByRole("button").count()) === 0, "el gerente no tiene botones para los permisos de caja");
      await filaRegla.getByRole("button", { name: "Usar uno propio" }).click();
      await tarjeta.getByText(/queda con el valor propio/).waitFor({ timeout: 30000 });
      await filaRegla.getByRole("button", { name: "Volver al del grupo" }).waitFor({ timeout: 30000 });
      const n = await q("select count(*)::int n from public.club_config_propia where club_id = $1 and clave = 'regla_comision'", [A]);
      revisar(n[0].n === 1, "gerente: «Usar uno propio» deja la regla de A como propia");
      await tarjeta.screenshot({ path: path.join(SALIDA, `${ancho}-grupo-gerente-propio.png`) });
    }
    await p.close();

    // ---------- Dueño de A ----------
    p = await nueva();
    await entrar(p, duenoA.email, PASS);
    await p.waitForURL(/\/dueno\/panel/, { timeout: 90000 });
    const tarjetaD = p.locator("div[data-slot=card]").filter({ has: p.getByRole("heading", { name: /Configuración del grupo «/ }) });
    await tarjetaD.waitFor({ timeout: 90000 });
    await tarjetaD.scrollIntoViewIfNeeded();
    await tarjetaD.screenshot({ path: path.join(SALIDA, `${ancho}-grupo-dueno-antro.png`) });
    revisar((await tarjetaD.locator("li").filter({ hasText: "Permisos de caja" }).getByRole("button").count()) === 0, `${ancho} px · dueño de A: los permisos bloqueados no tienen «Usar uno propio»`);
    await verificar(p, "tarjeta del grupo (dueño del antro)", "#origen-config-grupo");
    // Modo de pago bloqueado por el grupo: no se deja editar (la base lo rechazaría).
    const selModo = p.locator("#pago_rp_modo");
    await selModo.scrollIntoViewIfNeeded();
    await p.getByText(/los define el grupo «/).waitFor({ timeout: 30000 });
    const tarjetaModo = p.locator("div[data-slot=card]").filter({ has: selModo });
    revisar((await selModo.isDisabled()) && (await tarjetaModo.getByRole("button", { name: "Guardar modo de pago" }).isDisabled()),
      `${ancho} px · dueño de A: modo de pago bloqueado por el grupo, sin poder guardarlo`);
    const formTarifa = p.locator("#tarifa_posicion");
    revisar((await formTarifa.count()) === 1 && (await formTarifa.isDisabled()) && (await p.locator("div[data-slot=card]").filter({ has: p.getByText("Día 1", { exact: true }) }).getByRole("button", { name: "Eliminar" }).isDisabled()),
      `${ancho} px · dueño de A: tarifas por día del grupo sin poder agregar ni eliminar`);
    await tarjetaModo.screenshot({ path: path.join(SALIDA, `${ancho}-grupo-dueno-modo-bloqueado.png`) });
    await p.close();

    // ---------- Admin: paso «Grupo» de un clon dentro del grupo ----------
    p = await nueva();
    await ctx.clearCookies();
    await p.goto(BASE + "/admin/login");
    await p.fill("#email", "dev_admin@example.com");
    await p.fill("#password", PASS_DEV);
    await p.click("button[type=submit]");
    await p.waitForURL(/\/admin$/, { timeout: 90000 });
    await p.goto(BASE + `/admin/alta-antro?desde=${A}`);
    await p.waitForSelector("#alta-nombre", { timeout: 90000 });
    await p.fill("#alta-nombre", `T alta CG UI clon ${TAG}`);
    await p.fill("#alta-direccion", "Av. Clon 3");
    const siguiente = () => p.getByRole("button", { name: "Siguiente" }).click();
    await siguiente(); // políticas
    await siguiente(); // mesas
    await siguiente(); // reglas
    await p.getByRole("heading", { name: "Reglas de comisión y RPs" }).waitFor();
    // A no tiene regla vigente hoy (la del grupo empieza el lunes): se escribe una.
    if ((await p.locator("#alta-monto").count()) && !(await p.inputValue("#alta-monto"))) await p.fill("#alta-monto", "150");
    await siguiente(); // equipo
    await p.getByLabel("Crear la cuenta del dueño ahora").uncheck();
    await siguiente(); // grupo
    const fs = p.locator("fieldset").filter({ hasText: "Configuración del grupo" });
    await fs.waitFor({ timeout: 60000 });
    const tf = await fs.innerText();
    revisar(/Regla de comisión:/.test(tf) && /\(bloqueado\)/.test(tf) && (await p.getByLabel("Usar la del grupo (recomendado)").isChecked()), `${ancho} px · alta en el grupo: muestra lo que define el grupo y propone usarlo`);
    await p.getByLabel("Usar lo de este alta").check();
    revisar(await p.getByText(/eso se aplica aunque elijas lo de este alta/).isVisible(), `${ancho} px · avisa que lo bloqueado se aplica igual`);
    await foto(p, "alta-paso-grupo");
    await verificar(p, "alta, paso grupo");
    await p.getByLabel("Usar la del grupo (recomendado)").check();
    await siguiente();
    await p.getByRole("heading", { name: "Resumen" }).waitFor();
    revisar(/La del grupo: reemplaza lo de los pasos anteriores/.test(await p.locator("body").innerText()), `${ancho} px · el resumen dice que usa la configuración del grupo`);
    if (ancho === 390) {
      await p.getByRole("button", { name: "Dar de alta en borrador" }).click();
      await p.getByText(/quedó dado de alta/).waitFor({ timeout: 90000 });
      const clon = (await q("select id from public.clubs where nombre = $1", [`T alta CG UI clon ${TAG}`]))[0]?.id;
      if (clon) clubIds.push(clon);
      const r = clon ? await q("select public.rp_nivel_visibilidad($1) v, (select count(*)::int from public.club_config_propia where club_id = $1) n, (select tipo || '/' || cuota from public.reglas_comision where club_id = $1 limit 1) regla", [clon]) : [];
      revisar(r[0]?.v === "estado_monto_botellas" && r[0].n === 0 && r[0].regla === "cuota/3", "clon por la interfaz dentro del grupo: nace con la configuración del grupo y sin marcas «propio»", JSON.stringify(r));
    }
    await p.close();

    revisar(errores.length === 0, `${ancho} px · sin errores en la página`, errores.slice(0, 3).join(" | "));
    await ctx.close();
  }
} catch (e) {
  revisar(false, "error inesperado: " + e.message.split("\n")[0]);
} finally {
  await navegador.close();
  try {
    await q("begin");
    await q("set local antroapp.borrado_pruebas = 'on'");
    if (clubIds.length) {
      for (const t of ["caja_permisos", "config_rp_cambios", "reglas_comision", "club_config_rp", "club_dia_tarifas", "club_tables", "club_altas", "grupo_clubs"])
        await q(`delete from public.${t} where club_id = any($1::uuid[])`, [clubIds]);
    }
    if (grupo) {
      await q("delete from public.grupo_miembros where grupo_id = $1", [grupo]);
      await q("delete from public.grupos where id = $1", [grupo]);
    }
    if (ids.length) await q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubIds.length) await q("delete from public.clubs where id = any($1::uuid[])", [clubIds]);
    await q("commit");
  } catch (e) {
    await q("rollback");
    console.log("Limpieza falló: " + e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  const restos = (await q("select (select count(*) from public.clubs where nombre like $1)::int c, (select count(*) from public.grupos where nombre like $1)::int g, (select count(*) from auth.users where email like $2)::int u", [`%${TAG}%`, `t\\_alta\\_${TAG}\\_%`]))[0];
  await db.fin();
  console.log(`\nLimpieza: ${clubIds.length} antros, 1 grupo y ${ids.length} cuentas; restos: ${JSON.stringify(restos)}.`);
  console.log(`Capturas en ${SALIDA}`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan || restos.c || restos.g || restos.u) process.exitCode = 1;
}
