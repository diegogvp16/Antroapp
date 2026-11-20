// Prueba de carga de la caja: 50 mesas y una noche de ~1,100 movimientos,
// y cómo se siente en un celular de gama media (CPU 4× más lenta).
// Contra el servidor local de dev y antroapp-dev; arma su propio antro y lo
// borra al final.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-carga-caja.mjs [http://localhost:3001]
//
// Mide: latencia de las funciones de caja con 8 staff a la vez, tiempo de
// carga de /staff/caja, consultas y bytes de la carga y de cada revisión
// periódica, tiempo para abrir una mesa, filtros, búsqueda y fluidez del
// scroll (cuadros de más de 50 ms y tareas largas).

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    if (!process.env.PLAYWRIGHT_DESDE) {
      console.log("Falta Playwright: define PLAYWRIGHT_DESDE (carpeta con node_modules/playwright).");
      process.exit(1);
    }
    return import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DESDE, "node_modules", "playwright", "index.mjs")).href);
  }
}
const { chromium } = await cargarPlaywright();
const { createClient } = req("@supabase/supabase-js");
const BASE = process.argv[2] ?? "http://localhost:3001";
const SHOTS = path.join(RAIZ, "screenshots-carga-caja") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);

const MESAS = 50;
const TAG = "carga" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
let clubId = null;
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };
const medidas = {};
let etapa = "inicio";

async function usuario(clave, role) {
  const email = `prueba-${clave}-${TAG}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "crear " + clave);
  ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `${clave} ${TAG}`, role, club_id: clubId, activo: true }), "perfil " + clave);
  U[clave] = { id: u.user.id, email };
  return u.user.id;
}
async function sesion(clave) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
  ok(await c.auth.signInWithPassword({ email: U[clave].email, password: PASS }), "login " + clave);
  return c;
}

async function limpiar() {
  const ids = Object.values(U).map((u) => u.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubId) {
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = $1`, [clubId]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = $1)", [clubId]);
      await db.q("delete from public.reservations where club_id = $1", [clubId]);
      await db.q("delete from public.club_tables where club_id = $1", [clubId]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubId) await db.q("delete from public.clubs where id = $1", [clubId]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  await svc.from("login_intentos").delete().in("email_hash", Object.values(U).map((u) => createHash("sha256").update(u.email.toLowerCase()).digest("hex")));
  const quedan = await db.q(`select (select count(*) from public.clubs where nombre like $1)::int clubs, (select count(*) from auth.users where email like $1)::int usuarios`, [`%${TAG}%`]);
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
}

// Corre tareas con N a la vez.
async function enParalelo(tareas, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tareas.length) await tareas[i++]();
  }));
}
const latencias = [];
async function llamar(cliente, fn, args) {
  const t = performance.now();
  const r = await cliente.rpc(fn, args);
  latencias.push(performance.now() - t);
  return ok(r, fn);
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
const productos = [["Cerveza", 9000], ["Botella de tequila", 280000], ["Agua", 4000], ["Ronda de shots", 45000], ["Refresco", 5000], ["Botella de whisky", 320000], ["Cubeta", 60000], ["Mezcal", 18000]];

const navegador = await chromium.launch();
try {
  // ======================= Datos =======================
  clubId = randomUUID();
  ok(await svc.from("clubs").insert({ id: clubId, nombre: `Prueba ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", suscripcion_activa: false }), "club");
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva", comision_tipo: "fijo", comision_monto: 100, comision_desbloqueo_reservas: 0 }).eq("id", clubId), "publicar");
  const staffs = [];
  for (let i = 1; i <= 6; i++) staffs.push(await usuario(`staff${i}`, "staff"));
  await usuario("gerente", "gerente");
  const rps = [await usuario("rp1", "rp"), await usuario("rp2", "rp"), await usuario("rp3", "rp")];
  const mesas = ok(await svc.from("club_tables").insert(Array.from({ length: MESAS }, (_, i) => ({ club_id: clubId, numero: String(i + 1), capacidad: 8 }))).select("id, numero"), "mesas");
  mesas.sort((a, b) => Number(a.numero) - Number(b.numero));
  // Noche operativa del antro (zona por defecto, corte 08:00).
  const fecha = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(Date.now() - 8 * 3600e3));
  const reservas = Array.from({ length: 60 }, (_, i) => ({
    id: randomUUID(), cliente_nombre: `Cliente ${i + 1}`, cliente_telefono: "0000000777", personas: 2 + (i % 6), status: "usada", puerta_estado: "entro",
    entrada_en: new Date().toISOString(), source: i % 4 === 0 ? "organica" : "rp", rp_id: i % 4 === 0 ? null : rps[i % 3], club_id: clubId, fecha, qr_code: `antro-${randomUUID()}`,
  }));
  ok(await svc.from("reservations").insert(reservas), "reservas");

  const S = await Promise.all(Array.from({ length: 6 }, (_, i) => sesion(`staff${i + 1}`)));
  const G = await sesion("gerente");
  const t0 = performance.now();
  let movimientos = 0;
  // Cada mesa: primer grupo (reserva) que consume, paga, se cierra y se
  // cuadra; segundo grupo (sin reserva) que sigue abierto con saldo.
  await enParalelo(mesas.map((m, i) => async () => {
    const s = S[i % S.length];
    const ses1 = await llamar(s, "caja_abrir_mesa", { p_mesa_id: m.id });
    const c1 = await llamar(s, "caja_sentar_cliente", { p_sesion_id: ses1, p_reservation_id: reservas[i].id });
    let total = 0;
    for (let k = 0; k < 8; k++) {
      const [prod, precio] = productos[(i + k) % productos.length];
      await llamar(s, "caja_registrar_consumo", { p_cuenta_id: c1, p_monto_centavos: precio, p_concepto: `1 × ${prod}`, p_clave: randomUUID() });
      total += precio;
    }
    const mitad = Math.floor(total / 2);
    await llamar(s, "caja_registrar_pago", { p_sesion_id: ses1, p_cuenta_id: null, p_metodo: "tarjeta", p_monto_centavos: mitad, p_clave: randomUUID(), p_saldo_esperado: total });
    await llamar(s, "caja_registrar_pago", { p_sesion_id: ses1, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: total - mitad, p_clave: randomUUID(), p_saldo_esperado: total - mitad });
    await llamar(G, "caja_cerrar_mesa", { p_sesion_id: ses1 });
    await llamar(G, "caja_cuadrar_mesa", { p_sesion_id: ses1, p_notas: null });
    const ses2 = await llamar(s, "caja_abrir_mesa", { p_mesa_id: m.id });
    const c2 = await llamar(s, "caja_sentar_cliente", { p_sesion_id: ses2, p_cliente_nombre: `Grupo ${i + 1}`, p_personas: 4 });
    for (let k = 0; k < 6; k++) {
      const [prod, precio] = productos[(i + k + 3) % productos.length];
      await llamar(s, "caja_registrar_consumo", { p_cuenta_id: c2, p_monto_centavos: precio, p_concepto: `2 × ${prod}`, p_clave: randomUUID() });
    }
    await llamar(s, "caja_registrar_pago", { p_sesion_id: ses2, p_cuenta_id: null, p_metodo: "efectivo", p_monto_centavos: 10000, p_clave: randomUUID() });
    movimientos += 2 + 8 + 2 + 2 + 2 + 6 + 1;
  }), 8);
  const segundos = (performance.now() - t0) / 1000;
  medidas.datos = { mesas: MESAS, movimientos, segundos: Math.round(segundos), llamadas: latencias.length, p50_ms: pct(latencias, 50), p95_ms: pct(latencias, 95), max_ms: pct(latencias, 100) };
  console.log(`Datos: ${movimientos} movimientos en ${MESAS} mesas con 8 staff a la vez, ${Math.round(segundos)} s. Latencia por llamada p50 ${medidas.datos.p50_ms} ms, p95 ${medidas.datos.p95_ms} ms`);

  // La noche de carga también debe cuadrar al centavo (scripts/verificar-cuadre.mjs).
  const verif = spawnSync(process.execPath, [path.join(RAIZ, "scripts/verificar-cuadre.mjs"), `--club=${clubId}`], { encoding: "utf8" });
  medidas.verificar_cuadre = verif.status === 0 ? "sin diferencias" : "CON DIFERENCIAS";
  console.log("verificar-cuadre:", verif.stdout.trim().split(/\r?\n/).slice(-3).join(" | "));
  if (verif.status !== 0) process.exitCode = 1;

  // ======================= Navegador =======================
  for (const perfil of [
    { nombre: "cpu4x", cpu: 4, red: null },
    { nombre: "cpu4x-4g-lento", cpu: 4, red: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 } },
  ]) {
    etapa = perfil.nombre + ": login y carga";
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    await p.goto(BASE + "/cliente/login");
    await p.fill("#email", U.staff1.email);
    await p.fill("#password", PASS);
    await p.click("button[type=submit]");
    await p.waitForURL(/staff\/panel/, { timeout: 90000 });
    // Calentar la ruta (compilación de dev) antes de medir.
    await p.goto(BASE + "/staff/caja");
    await p.getByRole("button", { name: /^Mesa 1,/ }).waitFor({ timeout: 90000 });

    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: perfil.cpu });
    if (perfil.red) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...perfil.red });

    const peticiones = [];
    p.on("requestfinished", async (r) => {
      if (!r.url().includes("/rest/v1/")) return;
      const s = await r.sizes().catch(() => null);
      peticiones.push({ url: r.url(), bytes: s ? s.responseBodySize + s.responseHeadersSize : 0, t: Date.now() });
    });
    const inicio = Date.now();
    await p.goto(BASE + "/staff/caja");
    await p.getByRole("button", { name: /^Mesa 50,/ }).waitFor({ timeout: 120000 });
    const carga = Date.now() - inicio;
    await p.waitForTimeout(500);
    const cargaPeticiones = peticiones.length;
    const cargaBytes = peticiones.reduce((s, x) => s + x.bytes, 0);

    // Observadores de tareas largas y cuadros lentos.
    await p.evaluate(() => {
      window.__largas = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__largas.push(e.duration))).observe({ type: "longtask", buffered: false });
    });

    etapa = perfil.nombre + ": ciclo y scroll";
    // Revisión periódica: lo que cuesta un ciclo (espera 12 s).
    const antesCiclo = peticiones.length;
    const tCiclo = Date.now();
    await p.waitForTimeout(12000);
    const ciclo = peticiones.filter((x) => x.t >= tCiclo);
    const largasCiclo = await p.evaluate(() => window.__largas.splice(0));

    // Scroll del mapa: 40 pasos con rAF, midiendo cada cuadro.
    const scroll = await p.evaluate(async () => {
      const cuadros = [];
      let previo = performance.now();
      for (let i = 0; i < 60; i++) {
        window.scrollBy(0, i < 30 ? 120 : -120);
        await new Promise((r) => requestAnimationFrame(() => r()));
        const ahora = performance.now();
        cuadros.push(ahora - previo);
        previo = ahora;
      }
      return { promedio: cuadros.reduce((a, b) => a + b, 0) / cuadros.length, lentos: cuadros.filter((c) => c > 50).length, max: Math.max(...cuadros) };
    });
    await p.screenshot({ path: SHOTS + `${perfil.nombre}-mapa.png`, fullPage: false });

    etapa = perfil.nombre + ": abrir mesa";
    // Abrir una mesa y volver.
    let t = Date.now();
    await p.getByRole("button", { name: /^Mesa 37,/ }).click();
    await p.getByText("Grupo 37").first().waitFor();
    const abrirMesa = Date.now() - t;
    await p.screenshot({ path: SHOTS + `${perfil.nombre}-mesa.png`, fullPage: false });
    t = Date.now();
    await p.getByRole("button", { name: "Volver a las mesas" }).click();
    await p.getByRole("button", { name: /^Mesa 50,/ }).waitFor();
    const volver = Date.now() - t;

    etapa = perfil.nombre + ": filtro y búsqueda";
    // Filtro y búsqueda.
    const pestanas = await p.getByRole("tablist", { name: "Filtrar mesas" }).getByRole("tab").allInnerTexts();
    t = Date.now();
    await p.getByRole("tablist", { name: "Filtrar mesas" }).getByRole("tab").nth(1).click();
    await p.waitForTimeout(50);
    const filtro = Date.now() - t;
    await p.getByRole("tablist", { name: "Filtrar mesas" }).getByRole("tab").first().click();
    t = Date.now();
    await p.getByPlaceholder("Buscar mesa, cliente o RP").pressSequentially("Grupo 4", { delay: 60 });
    await p.getByRole("button", { name: /^Mesa 44,/ }).waitFor();
    const busqueda = Date.now() - t - 7 * 60;
    const largasInteraccion = await p.evaluate(() => window.__largas.splice(0));

    medidas[perfil.nombre] = {
      carga_ms: carga,
      carga_consultas: cargaPeticiones,
      carga_kb: Math.round(cargaBytes / 1024),
      ciclo_consultas_12s: ciclo.length,
      ciclo_kb_12s: Math.round(ciclo.reduce((s, x) => s + x.bytes, 0) / 1024),
      ciclo_tareas_largas: largasCiclo.length,
      ciclo_tarea_larga_max_ms: Math.round(Math.max(0, ...largasCiclo)),
      scroll_cuadro_promedio_ms: Math.round(scroll.promedio),
      scroll_cuadros_lentos_de_60: scroll.lentos,
      scroll_cuadro_max_ms: Math.round(scroll.max),
      abrir_mesa_ms: abrirMesa,
      volver_al_mapa_ms: volver,
      cambiar_filtro_ms: filtro,
      busqueda_ms_sin_tecleo: Math.max(0, busqueda),
      interaccion_tareas_largas: largasInteraccion.length,
      interaccion_tarea_larga_max_ms: Math.round(Math.max(0, ...largasInteraccion)),
      pestanas,
    };
    console.log(`\n${perfil.nombre}:`, JSON.stringify(medidas[perfil.nombre], null, 1));
    void antesCiclo;
    await ctx.close();
  }
  writeFileSync(SHOTS + "medidas.json", JSON.stringify(medidas, null, 2));
} catch (e) {
  console.log(`FALLA en "${etapa}":`, e.message.split("\n")[0]);
  process.exitCode = 1;
} finally {
  await navegador.close();
  await limpiar();
}
