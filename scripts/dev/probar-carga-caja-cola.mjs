// Carga de la caja CON la cola sin señal (B9, segunda pasada): 50 mesas,
// ~1,150 movimientos y CPU 4× más lenta (celular de gama media). Mide lo
// mismo que probar-carga-caja.mjs (carga, revisión periódica, scroll, abrir
// mesa, filtro y búsqueda) con la cola vacía y con 40 movimientos por enviar
// en 20 mesas, más lo que tarda capturar sin red y vaciar la cola al volver.
// Arma su propio antro ("T caja carga…", cuentas t_caja_…@example.com) y lo
// borra al final.
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> \
//     node scripts/dev/probar-carga-caja-cola.mjs [http://localhost:3001]

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
const SHOTS = path.join(RAIZ, "screenshots-b-caja") + path.sep;
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
  const email = `t_caja_${clave}_${TAG}@example.com`;
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
  ok(await svc.from("clubs").insert({ id: clubId, nombre: `T caja ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", suscripcion_activa: false }), "club");
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
  // 40 movimientos por enviar en 20 mesas abiertas (2 por mesa), como los
  // dejaría un staff que capturó sin señal. Se meten directo en la cola del
  // teléfono (IndexedDB) con la misma forma que usa la app.
  const abiertas = ok(await svc.from("mesa_sesiones").select("id, mesa_id").eq("club_id", clubId).eq("estado", "abierta"), "sesiones abiertas");
  const cuentasAb = ok(await svc.from("mesa_cuentas").select("id, sesion_id").in("sesion_id", abiertas.map((x) => x.id)), "cuentas abiertas");
  const cuentaDe = Object.fromEntries(cuentasAb.map((c) => [c.sesion_id, c.id]));
  const base0 = Date.now();
  const enCola = abiertas.slice(0, 20).flatMap((s, i) =>
    [0, 1].map((k) => {
      const clave = randomUUID();
      return {
        clave, usuarioId: U.staff1.id, clubId, mesaId: s.mesa_id, sesionId: s.id, tipo: "consumo",
        args: { p_cuenta_id: cuentaDe[s.id], p_monto_centavos: 5000, p_concepto: "1 × Cerveza (cola)", p_clave: clave },
        montoCentavos: 5000, descripcion: "1 × Cerveza (cola)", capturadoEn: new Date(base0).toISOString(),
        orden: (base0 + i * 10 + k) * 1000, intentos: 0, estado: "pendiente", motivo: null, rechazadoEn: null,
      };
    }),
  );

  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  etapa = "login";
  await p.goto(BASE + "/cliente/login");
  await p.fill("#email", U.staff1.email);
  await p.fill("#password", PASS);
  await p.click("button[type=submit]");
  await p.waitForURL(/staff\/panel/, { timeout: 90000 });
  await p.goto(BASE + "/staff/caja");
  await p.getByRole("button", { name: /^Mesa 1,/ }).waitFor({ timeout: 90000 });
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  const peticiones = [];
  p.on("requestfinished", (r) => {
    if (r.url().includes("/rest/v1/")) peticiones.push({ url: r.url(), t: Date.now() });
  });
  const largas = () => p.evaluate(() => (window.__largas ?? []).splice(0));
  const observar = () =>
    p.evaluate(() => {
      window.__largas = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__largas.push(e.duration))).observe({ type: "longtask", buffered: false });
    });

  async function medir(nombre) {
    etapa = nombre + ": carga";
    const inicio = Date.now();
    await p.goto(BASE + "/staff/caja");
    await p.getByRole("button", { name: /^Mesa 50,/ }).waitFor({ timeout: 120000 });
    const carga = Date.now() - inicio;
    await p.waitForTimeout(500);
    await observar();
    etapa = nombre + ": ciclo";
    const tCiclo = Date.now();
    await p.waitForTimeout(12000);
    const ciclo = peticiones.filter((x) => x.t >= tCiclo).length;
    const largasCiclo = await largas();
    etapa = nombre + ": scroll";
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
    etapa = nombre + ": abrir mesa";
    let t = Date.now();
    await p.getByRole("button", { name: /^Mesa 37,/ }).click();
    await p.getByText("Grupo 37").first().waitFor();
    const abrirMesa = Date.now() - t;
    t = Date.now();
    await p.getByRole("button", { name: "Volver a las mesas" }).click();
    await p.getByRole("button", { name: /^Mesa 50,/ }).waitFor();
    const volver = Date.now() - t;
    etapa = nombre + ": filtro y búsqueda";
    t = Date.now();
    await p.getByRole("tablist", { name: "Filtrar mesas" }).getByRole("tab").nth(1).click();
    await p.waitForTimeout(50);
    const filtro = Date.now() - t;
    await p.getByRole("tablist", { name: "Filtrar mesas" }).getByRole("tab").first().click();
    const buscador = p.getByPlaceholder("Buscar mesa, cliente o RP");
    t = Date.now();
    await buscador.pressSequentially("Grupo 4", { delay: 60 });
    await p.getByRole("button", { name: /^Mesa 44,/ }).waitFor();
    const busqueda = Math.max(0, Date.now() - t - 7 * 60);
    await buscador.fill("");
    const largasInter = await largas();
    medidas[nombre] = {
      carga_ms: carga,
      ciclo_consultas_12s: ciclo,
      ciclo_tareas_largas: largasCiclo.length,
      ciclo_tarea_larga_max_ms: Math.round(Math.max(0, ...largasCiclo)),
      scroll_cuadro_promedio_ms: Math.round(scroll.promedio),
      scroll_cuadros_lentos_de_60: scroll.lentos,
      abrir_mesa_ms: abrirMesa,
      volver_al_mapa_ms: volver,
      cambiar_filtro_ms: filtro,
      busqueda_ms_sin_tecleo: busqueda,
      interaccion_tareas_largas: largasInter.length,
      interaccion_tarea_larga_max_ms: Math.round(Math.max(0, ...largasInter)),
    };
    console.log(`\n${nombre}:`, JSON.stringify(medidas[nombre]));
  }

  // 1. Cola vacía.
  await medir("cpu4x-cola-vacia");

  // 2. 40 movimientos por enviar y la señal fallando (cada envío falla).
  etapa = "meter la cola";
  await ctx.route(/\/rest\/v1\/rpc\/caja_registrar_/, (r) => r.abort("failed"));
  await p.evaluate(
    (xs) =>
      new Promise((ok, mal) => {
        const r = indexedDB.open("antroapp-caja", 1);
        r.onupgradeneeded = () => {
          const s = r.result.createObjectStore("pendientes", { keyPath: "clave" });
          s.createIndex("usuarioId", "usuarioId");
        };
        r.onerror = () => mal(r.error);
        r.onsuccess = () => {
          const tx = r.result.transaction("pendientes", "readwrite");
          xs.forEach((x) => tx.objectStore("pendientes").put(x));
          tx.oncomplete = () => {
            r.result.close();
            new BroadcastChannel("antroapp-caja-cola").postMessage("cambio");
            ok();
          };
        };
      }),
    enCola,
  );
  await p.getByText("40 movimientos por enviar").first().waitFor({ timeout: 30000 });
  await medir("cpu4x-cola-40");
  await p.screenshot({ path: SHOTS + "20-carga-50-mesas-40-por-enviar-390.png", fullPage: false });
  await p.setViewportSize({ width: 360, height: 740 });
  await p.screenshot({ path: SHOTS + "20b-carga-50-mesas-40-por-enviar-360.png", fullPage: false });
  await p.setViewportSize({ width: 390, height: 844 });

  // 3. Capturar sin red con la cola llena: de tocar "Guardar" a la hoja cerrada.
  etapa = "capturar sin red";
  await p.getByRole("button", { name: /^Mesa 37,/ }).click();
  await p.getByText("Grupo 37").first().waitFor();
  await ctx.setOffline(true);
  await p.getByText("Sin conexión · reconectando…").waitFor({ timeout: 15000 });
  await p.getByRole("button", { name: /Agregar consumo/ }).first().click();
  const hoja = p.getByRole("dialog", { name: "Agregar consumo" });
  await hoja.getByLabel("Concepto").fill("Ronda (cola)");
  await hoja.getByLabel("Precio unitario ($)").fill("120");
  await observar();
  let t = Date.now();
  await hoja.getByRole("button", { name: /Guardar en el teléfono/ }).click();
  await hoja.waitFor({ state: "detached", timeout: 30000 });
  const capturar = Date.now() - t;
  const largasCaptura = await largas();
  await p.getByRole("button", { name: "Volver a las mesas" }).click();
  await p.getByText("41 movimientos por enviar").first().waitFor({ timeout: 15000 });

  // 4. Vuelve la señal: vaciar los 41.
  etapa = "vaciar";
  await ctx.unroute(/\/rest\/v1\/rpc\/caja_registrar_/);
  await observar();
  t = Date.now();
  await ctx.setOffline(false);
  const leerCola = () =>
    p.evaluate(
      () =>
        new Promise((ok) => {
          const r = indexedDB.open("antroapp-caja");
          r.onsuccess = () => {
            const g = r.result.transaction("pendientes").objectStore("pendientes").getAll();
            g.onsuccess = () => {
              r.result.close();
              ok(g.result.length);
            };
            g.onerror = () => ok(-1);
          };
          r.onerror = () => ok(-1);
        }),
    );
  let quedan = await leerCola();
  while (quedan > 0 && Date.now() - t < 180000) {
    await p.waitForTimeout(250);
    quedan = await leerCola();
  }
  const vaciar = Date.now() - t;
  const largasVaciado = await largas();
  await p.getByText(/movimientos? por enviar/).first().waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  const avisoFuera = Date.now() - t;
  const enBase = ok(await svc.from("caja_consumos").select("id, concepto").eq("club_id", clubId).like("concepto", "%(cola)%"), "consumos de la cola");
  medidas.capturar_y_vaciar = {
    capturar_sin_red_ms: capturar,
    capturar_tareas_largas: largasCaptura.length,
    vaciar_41_ms: vaciar,
    vaciar_ms_por_movimiento: Math.round(vaciar / 41),
    aviso_desaparece_ms: avisoFuera,
    vaciar_tareas_largas: largasVaciado.length,
    vaciar_tarea_larga_max_ms: Math.round(Math.max(0, ...largasVaciado)),
    quedan_en_cola: quedan,
    en_base_una_vez: enBase.length,
  };
  console.log("\ncapturar y vaciar:", JSON.stringify(medidas.capturar_y_vaciar));
  if (quedan !== 0 || enBase.length !== 41) {
    console.log(`FALLA: quedan ${quedan} en la cola y hay ${enBase.length} en la base (se esperaban 0 y 41)`);
    process.exitCode = 1;
  } else console.log("OK: los 41 entraron una sola vez");
  await ctx.close();
  writeFileSync(SHOTS + "medidas-carga-cola.json", JSON.stringify(medidas, null, 2));
} catch (e) {
  console.log(`FALLA en "${etapa}":`, e.message.split("\n")[0]);
  process.exitCode = 1;
} finally {
  await navegador.close();
  await limpiar();
}
