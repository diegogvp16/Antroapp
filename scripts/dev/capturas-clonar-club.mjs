// «Clonar antro» (B2) en el navegador, a 390×844 y 360×740: el botón en
// /admin, el asistente precargado con la configuración del origen, el
// resumen con lo que se copia y lo que no, el estado de error, y un clon
// completo por la interfaz (a 390 px) revisado en la base. Mide desborde
// horizontal, controles de menos de 40 px y errores de la página.
// Capturas en screenshots-b-alta/ (no van a Git).
//
//   PUERTO=3021 node scripts/dev/servidor-dev.mjs        # en otra terminal
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/capturas-clonar-club.mjs [http://localhost:3021]
//
// Usa dev_admin (no le cambia nada). Crea un antro de origen «T alta UI …»
// (sin cuentas) y sus clones; todo se borra al final aunque algo falle.

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
const sufijo = randomUUID().slice(0, 8);
const PREFIJO = `T alta UI ${sufijo}`;
const ORIGEN = `${PREFIJO} origen`;
const CLON = `${PREFIJO} clon`;

async function medir(p) {
  return p.evaluate(() => {
    const desborde = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const chicos = [];
    for (const el of document.querySelectorAll("main button, main a, main input, main select, main textarea, button, input, summary")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
      const objetivo = el.matches("input[type=radio], input[type=checkbox]") ? el.closest("label") : el;
      const h = objetivo ? objetivo.getBoundingClientRect().height : r.height;
      if (h < 40 && !el.closest(".sr-only")) chicos.push((el.getAttribute("aria-label") || el.textContent || el.id || el.tagName).trim().slice(0, 40) + ` (${Math.round(h)} px)`);
    }
    return { desborde, chicos: [...new Set(chicos)] };
  });
}

const db = await conectarDevEscritura();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
const navegador = await chromium.launch();
let origenId = null;
try {
  // Origen sin cuentas, con regla de porcentaje, permisos, cover y catálogo.
  const { error: eLogin } = await admin.auth.signInWithPassword({ email: "dev_admin@example.com", password: PASS_DEV });
  if (eLogin) throw new Error("login admin: " + eLogin.message);
  const rO = await admin.rpc("admin_alta_club", { p: {
    alta_id: randomUUID(),
    club: { nombre: ORIGEN, direccion: "Av. Origen UI 1", ciudad: "Guadalajara", zona_horaria: "America/Mexico_City", horario: "Vie y Sáb 11pm a 5am",
            cover_modo: "monto", cover_monto: "250", deposito_monto: "300", edad_minima: "21", codigo_vestimenta: "Formal", tipo_musica: "Reguetón", ambiente: "Terraza", tolerancia_hora: "00:30" },
    mesas: [{ numero: "Barra 1", capacidad: 4 }, { numero: "Barra 2", capacidad: 4 }, { numero: "VIP A", capacidad: 15 }],
    rp: { modo_pago: "reserva", regla: { tipo: "porcentaje", cuota: 0, porcentaje_bp: 1250, monto_centavos: null }, visibilidad: "estado", tarifas_dia: [{ posicion: 1, monto_centavos: 30000 }] },
    caja_permisos: [{ permiso: "reabrir_mesa", rol: "staff", permitido: true }],
  } });
  if (rO.error) throw new Error("origen: " + rO.error.message);
  origenId = rO.data.club_id;
  const { data: adminU } = await svc.from("profiles").select("id").eq("role", "admin").eq("nombre", "Admin Dev").maybeSingle();
  const fase2 = (await db.q("select to_regclass('public.productos') is not null as e"))[0].e;
  if (fase2) {
    await db.q(`insert into public.productos (club_id, nombre, categoria, precio_centavos, existencias, existencias_minimas, activo, creado_por)
      values ($1, 'Tequila T alta', 'Licor', 180000, 12, 2, true, $2), ($1, 'Refresco T alta', 'Mezclador', 4000, 80, 10, true, $2)`, [origenId, adminU.id]);
  }

  for (const [ancho, alto] of [[390, 844], [360, 740]]) {
    const ctx = await navegador.newContext({ viewport: { width: ancho, height: alto }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    const errores = [];
    p.on("pageerror", (e) => errores.push(e.message.slice(0, 140)));
    p.on("console", (m) => { if (m.type() === "error" && !/DevTools|favicon|Download the React|Plantilla de clon/.test(m.text())) errores.push(m.text().slice(0, 140)); });
    const foto = async (nombre) => p.screenshot({ path: path.join(SALIDA, `${ancho}-clon-${nombre}.png`), fullPage: true });
    const verificar = async (nombre) => {
      const m = await medir(p);
      revisar(!m.desborde, `${ancho} px · ${nombre}: sin desborde horizontal`);
      revisar(m.chicos.length === 0, `${ancho} px · ${nombre}: ningún control de menos de 40 px`, m.chicos.join(", "));
    };
    const siguiente = () => p.getByRole("button", { name: "Siguiente" }).click();

    await p.goto(BASE + "/admin/login");
    await p.fill("#email", "dev_admin@example.com");
    await p.fill("#password", PASS_DEV);
    await p.click("button[type=submit]");
    await p.waitForURL(/\/admin$/, { timeout: 90000 });

    // Botón «Clonar» en la tarjeta del origen (en «No publicados»: es borrador).
    await p.getByText(/No publicados \(/).click();
    const boton = p.locator(`a[aria-label="Clonar ${ORIGEN}"]`);
    await boton.scrollIntoViewIfNeeded();
    revisar(await boton.isVisible(), `${ancho} px · /admin: el antro tiene su botón «Clonar»`);
    await foto("admin");
    await verificar("/admin con «Clonar»");
    await boton.click();
    await p.waitForURL(/alta-antro\?desde=/, { timeout: 60000 });
    await p.waitForSelector("#alta-nombre", { timeout: 90000 });

    // Paso 1: aviso del clon y datos precargados (nombre y dirección vacíos).
    const cuerpo = await p.locator("body").innerText();
    revisar(/Clon de antro · paso 1 de 7/i.test(cuerpo) && cuerpo.includes(`Precargado con la configuración de ${ORIGEN}`), `${ancho} px · el asistente dice que es un clon y de qué antro`);
    revisar((await p.inputValue("#alta-nombre")) === "" && (await p.inputValue("#alta-direccion")) === "", `${ancho} px · nombre y dirección vacíos`);
    revisar((await p.inputValue("#alta-ciudad")) === "Guadalajara" && (await p.inputValue("#alta-horario")) === "Vie y Sáb 11pm a 5am", `${ancho} px · ciudad y horario del origen`);
    await foto("paso1");
    await verificar("clon, paso 1");

    await siguiente();
    revisar(await p.getByText("Escribe el nombre del antro.").first().isVisible().catch(() => false), `${ancho} px · sin nombre no deja seguir`);
    await p.fill("#alta-nombre", CLON);
    await p.fill("#alta-direccion", "Av. Clon UI 2");
    await siguiente();
    revisar((await p.inputValue("#alta-deposito")) === "300" && (await p.inputValue("#alta-edad")) === "21" && (await p.inputValue("#alta-vestimenta")) === "Formal" && (await p.inputValue("#alta-tolerancia")) === "00:30",
      `${ancho} px · cover y políticas precargados (depósito, edad, vestimenta, tolerancia)`);
    await foto("politicas");
    await siguiente();
    const mesas = await p.locator("body").innerText();
    revisar(/Barra 1/.test(mesas) || (await p.locator("input[value='VIP A']").count()) > 0, `${ancho} px · mesas del origen precargadas`);
    await siguiente();
    await p.getByRole("heading", { name: "Reglas de comisión y RPs" }).waitFor();
    revisar((await p.inputValue("#alta-porcentaje")) === "12.5" && (await p.getByLabel("Solo el estado").isChecked()), `${ancho} px · regla 12.5 % y «solo el estado» precargados`);
    revisar(await p.getByText("1 cambio respecto de la plataforma.").isVisible().catch(() => false), `${ancho} px · el permiso cambiado del origen ya viene marcado`);
    await foto("reglas");
    await verificar("clon, reglas");

    if (ancho === 390) {
      await siguiente();
      await p.getByLabel("Crear la cuenta del dueño ahora").uncheck();
      await siguiente(); // equipo
      await siguiente(); // grupo
      await p.getByRole("heading", { name: "Resumen" }).waitFor();
      const resumen = await p.locator("body").innerText();
      revisar(resumen.includes(`Sale de\n${ORIGEN}`) || resumen.includes(ORIGEN), "resumen: dice de qué antro sale");
      revisar(!fase2 || /Se copian 2 productos \(2 activos\), con existencias en 0/.test(resumen), "resumen: cuántos productos se copian, sin existencias");
      revisar(/Reservas y consumos/.test(resumen) && /Dueño, personal y cuentas/.test(resumen), "resumen: lo que NO se copia");
      revisar(/12\.5 % del consumo/.test(resumen), "resumen: la regla del origen");
      revisar(/También se guarda\s+Tarifas por día: día 1 \$300/.test(resumen), "resumen: también se guardan las tarifas por día del origen (paga por reserva)");
      await foto("resumen");
      await verificar("clon, resumen");
      await p.getByRole("button", { name: "Dar de alta en borrador" }).click();
      await p.getByText(`${CLON} quedó dado de alta`).waitFor({ timeout: 60000 });
      await foto("resultado");
      const { data: club } = await svc.from("clubs").select("id, ciudad, horario, deposito_monto, edad_minima, cover_modo, cover_monto, tolerancia_hora, estado_verificacion").eq("nombre", CLON).maybeSingle();
      const { data: regla } = await svc.from("reglas_comision").select("tipo, porcentaje_bp").eq("club_id", club?.id);
      const { data: perm } = await svc.from("caja_permisos").select("permiso, rol, permitido").eq("club_id", club?.id);
      const { data: alta } = await svc.from("club_altas").select("resumen").eq("club_id", club?.id).maybeSingle();
      revisar(club?.ciudad === "Guadalajara" && Number(club.deposito_monto) === 300 && club.edad_minima === 21 && club.cover_modo === "monto" && Number(club.cover_monto) === 250 && club.tolerancia_hora?.startsWith("00:30") && club.estado_verificacion === "borrador",
        "clon por la interfaz: datos y políticas del origen, en borrador", JSON.stringify(club));
      revisar(regla?.length === 1 && regla[0].tipo === "porcentaje" && regla[0].porcentaje_bp === 1250, "…regla 12.5 %", JSON.stringify(regla));
      revisar(perm?.length === 1 && perm[0].permiso === "reabrir_mesa" && perm[0].permitido === true, "…el permiso del origen", JSON.stringify(perm));
      revisar(alta?.resumen?.clon?.clonado_de === origenId, "…y la bitácora dice de qué antro salió");
      if (fase2) {
        const prods = await db.q("select nombre, existencias from public.productos where club_id = $1 order by nombre", [club?.id]);
        revisar(prods.length === 2 && prods.every((x) => x.existencias === 0), "…con el catálogo copiado y existencias en 0", JSON.stringify(prods));
      }
    }

    revisar(errores.length === 0, `${ancho} px · flujo del clon sin errores en la página`, errores.slice(0, 3).join(" | "));
    errores.length = 0;

    // Estado de error: un origen que no existe (la llamada responde 400 a
    // propósito: ese aviso de red del navegador es esperado).
    await p.goto(BASE + `/admin/alta-antro?desde=${randomUUID()}`);
    await p.getByText("El antro de origen no existe.").waitFor({ timeout: 60000 });
    revisar(await p.getByRole("button", { name: "Hacer un alta en blanco" }).isVisible(), `${ancho} px · origen inexistente: aviso y salida a un alta en blanco`);
    await foto("error");
    await verificar("clon, error");
    await p.getByRole("button", { name: "Hacer un alta en blanco" }).click();
    await p.waitForSelector("#alta-nombre", { timeout: 30000 });
    revisar(/Alta de antro · paso 1 de 7/i.test(await p.locator("body").innerText()) && (await p.inputValue("#alta-ciudad")) === "", `${ancho} px · «Hacer un alta en blanco» abre el asistente vacío`);

    const inesperados = errores.filter((x) => !/status of 400/.test(x));
    revisar(inesperados.length === 0, `${ancho} px · estado de error sin otros errores en la página`, inesperados.slice(0, 3).join(" | "));
    await ctx.close();
  }
} catch (e) {
  revisar(false, "error inesperado: " + e.message.split("\n")[0]);
} finally {
  await navegador.close();
  const ids = ((await svc.from("clubs").select("id").like("nombre", `${PREFIJO}%`)).data ?? []).map((c) => c.id);
  try {
    await db.q("begin");
    if (ids.length) {
      if ((await db.q("select to_regclass('public.productos') is not null as e"))[0].e) {
        await db.q("delete from public.producto_movimientos where club_id = any($1::uuid[])", [ids]);
        await db.q("delete from public.productos where club_id = any($1::uuid[])", [ids]);
      }
      for (const t of ["caja_permisos", "config_rp_cambios", "reglas_comision", "club_config_rp", "club_dia_tarifas", "club_tables", "club_altas", "grupo_clubs"])
        await db.q(`delete from public.${t} where club_id = any($1::uuid[])`, [ids]);
      await db.q("delete from public.clubs where id = any($1::uuid[])", [ids]);
    }
    await db.q("commit");
  } catch (e) {
    await db.q("rollback");
    console.log("Limpieza falló: " + e.message);
  }
  const quedan = ((await svc.from("clubs").select("id").like("nombre", `${PREFIJO}%`)).data ?? []).length;
  await db.fin();
  console.log(quedan ? `\nLimpieza: QUEDARON ${quedan} antros de prueba.` : `\nLimpieza: ${ids.length} antros de prueba borrados.`);
  console.log(`Capturas en ${SALIDA}`);
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  if (fallan || quedan) process.exitCode = 1;
}
