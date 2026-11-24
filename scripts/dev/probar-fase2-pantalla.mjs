// FASE 2 en pantalla (rama fase2), con la bandera encendida: el gerente arma
// el catálogo, el staff vende con categorías y buscador, aparece el aviso de
// existencias bajas y la propina sale en el cobro y en el cuadre.
// Contra un build con la bandera (NEXT_PUBLIC_FASE2=1 node scripts/dev/servidor-prod-dev.mjs):
//
//   PLAYWRIGHT_DESDE=<carpeta con node_modules/playwright> //     node scripts/dev/probar-fase2-pantalla.mjs [http://localhost:3002]
//
// Arma su propio antro de prueba y lo borra al final. Capturas en screenshots-fase2/.

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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
const BASE = process.argv[2] ?? "http://localhost:3002";
const SHOTS = path.join(RAIZ, "screenshots-fase2") + path.sep;
mkdirSync(SHOTS, { recursive: true });
const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);

const TAG = "f2ui" + randomUUID().slice(0, 6);
const PASS = "Prueba-" + randomUUID();
const U = {};
let clubId = null;
const resultados = [];
const ok = (r, d) => { if (r.error) throw new Error(`${d}: ${r.error.message}`); return r.data; };
function nota(texto, paso, detalle = "") {
  resultados.push(paso);
  console.log(`${paso ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}

async function usuario(clave, role) {
  const email = `prueba-${clave}-${TAG}@example.com`;
  const u = ok(await svc.auth.admin.createUser({ email, password: PASS, email_confirm: true }), "crear " + clave);
  ok(await svc.from("profiles").upsert({ id: u.user.id, nombre: `${clave} ${TAG}`, role, club_id: clubId, activo: true }), "perfil " + clave);
  U[clave] = { id: u.user.id, email };
}

async function limpiar() {
  const ids = Object.values(U).map((u) => u.id);
  const db = await conectarDevEscritura();
  try {
    await db.q("begin");
    await db.q("set local antroapp.borrado_pruebas = 'on'");
    if (clubId) {
      await db.q("delete from public.producto_movimientos where club_id = $1", [clubId]);
      for (const t of ["caja_eventos", "caja_cuadres", "caja_pagos", "caja_consumos", "mesa_cuentas", "mesa_sesiones", "caja_noches", "caja_permisos"])
        await db.q(`delete from public.${t} where club_id = $1`, [clubId]);
      await db.q("delete from public.commissions where reservation_id in (select id from public.reservations where club_id = $1)", [clubId]);
      await db.q("delete from public.reservations where club_id = $1", [clubId]);
      await db.q("delete from public.club_tables where club_id = $1", [clubId]);
      await db.q("delete from public.productos where club_id = $1", [clubId]);
    }
    if (ids.length) await db.q("delete from public.profiles where id = any($1::uuid[])", [ids]);
    if (clubId) await db.q("delete from public.clubs where id = $1", [clubId]);
    await db.q("commit");
  } catch (e) {
    await db.q("rollback").catch(() => {});
    console.log("  error en limpieza:", e.message);
  }
  for (const id of ids) await svc.auth.admin.deleteUser(id);
  // Intentos de login de estas cuentas (la app guarda el correo con sha256).
  await svc.from("login_intentos").delete().in("email_hash", Object.values(U).map((u) => createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex")));
  const quedan = await db.q(
    `select (select count(*) from public.clubs where nombre like $1)::int clubs,
            (select count(*) from auth.users where email like $1)::int usuarios`,
    [`%${TAG}%`],
  );
  await db.fin();
  console.log(`\nLimpieza (restos): ${JSON.stringify(quedan[0])}`);
}

// Totales de la sesión, leídos de la base (la verdad).
async function totales(sesionId) {
  const c = ok(await svc.from("caja_consumos").select("monto_centavos").eq("sesion_id", sesionId).eq("anulado", false), "consumos");
  const p = ok(await svc.from("caja_pagos").select("monto_centavos").eq("sesion_id", sesionId).eq("anulado", false), "pagos");
  const suma = (xs) => xs.reduce((s, x) => s + Number(x.monto_centavos), 0);
  return { consumos: c.length, consumo: suma(c), pagos: p.length, cobrado: suma(p) };
}
// Igual que formatearCentavos de la app: pesos cerrados sin centavos.
const pesos = (c) => "$" + (c / 100).toLocaleString("es-MX", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });

// Deja pasar la petición a la base y tira la respuesta: lo que pasa con
// mala señal cuando el servidor sí guardó pero el teléfono no se enteró.
async function perderRespuestaUnaVez(page, funcion) {
  let hecho = false;
  const patron = `**/rest/v1/rpc/${funcion}`;
  await page.route(patron, async (route) => {
    if (hecho) return route.continue();
    hecho = true;
    await route.fetch().catch(() => {});
    await route.abort("failed");
  });
  return () => page.unroute(patron);
}

const navegador = await chromium.launch();
const errores = [];
async function entrar(clave, destino) {
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errores.push(`${clave}: ${e.message.slice(0, 160)}`));
  await p.goto(BASE + "/cliente/login");
  await p.fill("#email", U[clave].email);
  await p.fill("#password", PASS);
  await p.click("button[type=submit]");
  await p.waitForURL(destino, { timeout: 90000 });
  return { ctx, p };
}
try {
  // ======================= Escenario =======================
  clubId = randomUUID();
  ok(await svc.from("clubs").insert({ id: clubId, nombre: `Prueba ${TAG}`, direccion: "Calle Prueba 1", horario: "22:00-03:00", suscripcion_activa: false }), "club");
  ok(await svc.from("clubs").update({ estado_verificacion: "verificado", verificado_en: new Date().toISOString(), suscripcion_activa: true, pago_rp_modo: "reserva" }).eq("id", clubId), "publicar");
  await usuario("staff", "staff");
  await usuario("gerente", "gerente");
  const mesas = ok(await svc.from("club_tables").insert([1, 2].map((n) => ({ club_id: clubId, numero: String(n), capacidad: 8 }))).select("id, numero"), "mesas");
  const M1 = mesas.find((m) => m.numero === "1").id;
  const api = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opciones);
  ok(await api.auth.signInWithPassword({ email: U.staff.email, password: PASS }), "login api");
  const S1 = ok(await api.rpc("caja_abrir_mesa", { p_mesa_id: M1 }), "abrir mesa");
  ok(await api.rpc("caja_sentar_cliente", { p_sesion_id: S1, p_cliente_nombre: "Grupo Fase Dos", p_personas: 4 }), "sentar");

  // ======================= Gerente arma el catálogo =======================
  const G = await entrar("gerente", /staff\/panel/);
  await G.p.getByRole("link", { name: "Catálogo e inventario" }).or(G.p.getByText("Catálogo e inventario")).first().click();
  await G.p.waitForURL(/staff\/catalogo/);
  await G.p.getByRole("heading", { name: "Catálogo e inventario" }).waitFor();
  nota("gerente: el panel lleva al catálogo", true);
  const alta = async (nombre, categoria, precio, iniciales, minimo) => {
    await G.p.getByLabel("Nombre").first().fill(nombre);
    await G.p.getByLabel("Categoría").first().fill(categoria);
    await G.p.getByLabel("Precio ($)").first().fill(precio);
    await G.p.getByLabel("Existencias iniciales").fill(iniciales);
    await G.p.getByLabel("Avisar cuando queden (mínimo)").first().fill(minimo);
    await G.p.getByRole("button", { name: "Agregar al catálogo" }).click();
    await G.p.getByText(nombre, { exact: true }).first().waitFor({ timeout: 20000 });
  };
  await alta("Cerveza clara", "Cervezas", "90", "5", "3");
  await alta("Botella de tequila", "Botellas", "2800", "2", "1");
  const prods = ok(await svc.from("productos").select("nombre, existencias, precio_centavos").eq("club_id", clubId), "productos");
  nota("el catálogo queda en la base (2 productos con precio y existencias)", prods.length === 2 && prods.some((x) => x.nombre === "Cerveza clara" && x.existencias === 5 && x.precio_centavos === 9000));
  await G.p.screenshot({ path: SHOTS + "01-catalogo-gerente.png", fullPage: true });

  // ======================= Staff vende con el catálogo =======================
  const St = await entrar("staff", /staff\/panel/);
  nota("staff: el panel NO muestra el catálogo", (await St.p.getByText("Catálogo e inventario").count()) === 0);
  await St.p.goto(BASE + "/staff/caja");
  await St.p.getByRole("button", { name: /^Mesa 1,/ }).click({ timeout: 60000 });
  await St.p.getByRole("button", { name: /Agregar consumo/ }).first().click();
  const hoja = St.p.getByRole("dialog", { name: "Agregar consumo" });
  await hoja.waitFor();
  const chips = await hoja.getByRole("group", { name: "Categorías" }).getByRole("button").allInnerTexts();
  nota("la hoja muestra las categorías del catálogo", JSON.stringify(chips) === JSON.stringify(["Todo", "Botellas", "Cervezas"]), chips.join(", "));
  await hoja.getByRole("button", { name: "Cervezas", exact: true }).click();
  nota("filtrar por categoría", (await hoja.getByText("Cerveza clara").isVisible()) && !(await hoja.getByText("Botella de tequila").isVisible().catch(() => false)));
  await hoja.getByRole("button", { name: "Todo", exact: true }).click();
  await hoja.getByPlaceholder("Buscar en el catálogo").fill("tequ");
  nota("buscar sin importar acentos ni mayúsculas", (await hoja.getByText("Botella de tequila").isVisible()) && !(await hoja.getByText("Cerveza clara").isVisible().catch(() => false)));
  await hoja.getByPlaceholder("Buscar en el catálogo").fill("");
  for (let i = 0; i < 3; i++) await hoja.getByRole("button", { name: "Agregar uno: Cerveza clara" }).click();
  nota("muestra las existencias junto al precio", await hoja.getByText(/Quedan 5/).first().isVisible());
  await St.p.screenshot({ path: SHOTS + "02-hoja-consumo-catalogo.png", fullPage: true });
  await hoja.getByRole("button", { name: /Agregar a la mesa · \$270/ }).click();
  await hoja.waitFor({ state: "detached", timeout: 30000 });
  const venta = ok(await svc.from("caja_consumos").select("producto_id, cantidad, monto_centavos, concepto").eq("sesion_id", S1), "venta");
  const cerveza = ok(await svc.from("productos").select("id, existencias").eq("club_id", clubId).eq("nombre", "Cerveza clara").single(), "cerveza");
  nota("la venta queda ligada al producto (3 × $90) y descuenta: 5 → 2", venta.length === 1 && venta[0].producto_id === cerveza.id && venta[0].cantidad === 3 && venta[0].monto_centavos === 27000 && cerveza.existencias === 2, JSON.stringify(venta[0]));

  // ======================= Aviso de existencias bajas =======================
  await G.p.reload();
  await G.p.getByText(/1 producto con existencias bajas/).waitFor({ timeout: 20000 }).then(
    () => nota("el gerente ve el aviso de existencias bajas (Cerveza: 2, mínimo 3)", true),
    () => nota("el gerente ve el aviso de existencias bajas (Cerveza: 2, mínimo 3)", false),
  );
  await G.p.screenshot({ path: SHOTS + "03-aviso-existencias-bajas.png", fullPage: true });

  // ======================= Propina =======================
  await St.p.getByRole("button", { name: /^Cobrar \$270/ }).click({ timeout: 20000 });
  const cobro = St.p.getByRole("dialog", { name: "Cobrar" });
  await cobro.getByRole("button", { name: "Tarjeta" }).click();
  await cobro.getByLabel(/Propina/).fill("50");
  await St.p.screenshot({ path: SHOTS + "04-cobro-con-propina.png", fullPage: true });
  await cobro.getByRole("button", { name: /^Cobrar \$270/ }).click();
  await cobro.waitFor({ state: "detached", timeout: 30000 });
  const pago = ok(await svc.from("caja_pagos").select("monto_centavos, propina_centavos").eq("sesion_id", S1), "pago");
  nota("el cobro guarda $270 y la propina de $50 aparte", pago.length === 1 && Number(pago[0].monto_centavos) === 27000 && Number(pago[0].propina_centavos) === 5000);
  await St.p.getByText(/Propinas/).first().waitFor({ timeout: 20000 }).catch(() => {});
  nota("la mesa muestra las propinas y el saldo en $0", (await St.p.getByText(/Propinas \$50/).first().isVisible().catch(() => false)) && (await St.p.getByText("$0").first().isVisible()));
  await St.p.screenshot({ path: SHOTS + "05-mesa-con-propina.png", fullPage: true });

  // ======================= Cuadre de la noche =======================
  await G.p.goto(BASE + "/staff/caja");
  await G.p.getByRole("button", { name: "Cuadre de la noche" }).click({ timeout: 60000 });
  await G.p.getByText("Propinas de la noche").waitFor({ timeout: 20000 }).then(
    () => nota("el cuadre de la noche muestra las propinas aparte", true),
    () => nota("el cuadre de la noche muestra las propinas aparte", false),
  );
  await G.p.screenshot({ path: SHOTS + "06-cuadre-noche-propinas.png", fullPage: true });
  for (const s of [G, St]) await s.ctx.close();
} catch (e) {
  nota("sin excepciones", false, e.message.split("\n")[0]);
} finally {
  await navegador.close();
  await limpiar();
  if (errores.length) console.log("Errores de página:\n  " + errores.join("\n  "));
  const pasan = resultados.filter(Boolean).length;
  console.log(`\nResultado: ${pasan}/${resultados.length}`);
  process.exitCode = pasan === resultados.length && errores.length === 0 ? 0 : 1;
}
void totales;
void perderRespuestaUnaVez;
void pesos;
