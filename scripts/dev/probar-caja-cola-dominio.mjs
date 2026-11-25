// Pruebas de lib/domain/caja-cola.ts (reglas puras de la cola de caja sin
// señal). No toca ninguna base: Node 24 carga el .ts directo (quita los tipos).
//
//   node scripts/dev/probar-caja-cola-dominio.mjs

import {
  FUNCION_DE,
  clasificar,
  conLimite,
  conPendientes,
  conteoPorMesa,
  crearPendiente,
  esperaMs,
  estadoDeSesion,
  motivoRechazo,
  ordenDeCaptura,
  ordenar,
  porEnviar,
  sinLoYaGuardado,
  textoDeOtraCuenta,
  textoPorEnviar,
  vencido,
  ESPERA_MAX_MS,
  MOTIVO_GENERICO,
  MAX_INTENTOS_DUDOSOS,
  MOTIVO_AJENO_VENCIDO,
  MOTIVO_CUENTA_BAJA,
  comoRechazado,
  pendienteAjenoVencido,
} from "../../lib/domain/caja-cola.ts";

let pasan = 0, fallan = 0;
function revisar(cond, texto) {
  if (cond) pasan++; else fallan++;
  console.log((cond ? "OK     " : "FALLA  ") + texto);
}

const ahora = new Date("2026-11-25T05:00:00.000Z");
const nuevo = (o = {}) => ({
  clave: o.clave ?? "c1",
  clubId: "club",
  mesaId: o.mesaId ?? "m1",
  sesionId: o.sesionId ?? "s1",
  tipo: o.tipo ?? "consumo",
  args: o.args ?? { p_cuenta_id: "cu1", p_monto_centavos: 5000, p_concepto: "Cerveza" },
  montoCentavos: o.monto ?? 5000,
  descripcion: "Cerveza",
});

// 1. Crear: la clave viaja en los argumentos y el orden respeta la captura.
{
  const a = crearPendiente(nuevo({ clave: "a" }), "u1", ahora, 0);
  const b = crearPendiente(nuevo({ clave: "b" }), "u1", ahora, 1);
  revisar(a.args.p_clave === "a" && a.estado === "pendiente" && a.intentos === 0, "crear: p_clave = clave, pendiente, 0 intentos");
  revisar(a.usuarioId === "u1" && a.capturadoEn === ahora.toISOString(), "crear: usuario y hora de captura");
  revisar(b.orden > a.orden, "crear: dos renglones del mismo toque conservan su orden");
  revisar(!("cliente_nombre" in a) && !("telefono" in a) && !("token" in a), "crear: no guarda nombre, teléfono ni token");
  const mal = crearPendiente({ ...nuevo({ clave: "x" }), args: { p_clave: "otra", p_monto_centavos: 1 } }, "u1", ahora, 0);
  revisar(mal.args.p_clave === "x", "crear: la clave de la fila manda sobre una p_clave distinta en args");
}

// 2. Qué se manda: solo lo pendiente de quien tiene la sesión, en orden.
{
  const t = (clave, usuario, orden, estado = "pendiente") => ({ ...crearPendiente(nuevo({ clave }), usuario, ahora, 0), orden, estado });
  const lista = porEnviar([t("3", "u1", 30), t("1", "u1", 10), t("2", "u2", 20), t("4", "u1", 5, "rechazado")], "u1");
  revisar(lista.map((x) => x.clave).join(",") === "1,3", "porEnviar: solo u1, sin rechazados, en orden de captura");
  revisar(porEnviar([t("2", "u2", 20)], "u1").length === 0, "porEnviar: lo de otro usuario en el mismo teléfono no se manda");
}

// 3. Clasificar respuestas.
{
  revisar(clasificar({ error: null, status: 200 }, false).tipo === "aplicado", "sin error: aplicado");
  revisar(clasificar({ error: { message: "TypeError: Failed to fetch", code: "" }, status: 0 }, true).tipo === "reintentar", "red caída: reintentar");
  revisar(clasificar({ error: { message: "x", code: "" }, status: 503 }, false).tipo === "reintentar", "503 sin código: reintentar");
  revisar(clasificar({ error: { message: "x", code: "" }, status: 429 }, false).tipo === "reintentar", "429: reintentar");
  revisar(clasificar({ error: { message: "canceling statement due to statement timeout", code: "57014" }, status: 500 }, false).tipo === "reintentar", "timeout de la base: reintentar");
  revisar(clasificar({ error: { message: "JWT expired", code: "PGRST301" }, status: 401 }, false).tipo === "sin_sesion", "sesión vencida: esperar sesión (no rechazar)");
  const p = clasificar({ error: { message: "La mesa está cuadrada y esta acción requiere que esté abierta", code: "P0001" }, status: 400 }, false);
  revisar(p.tipo === "rechazado" && p.motivo === "La mesa ya está cuadrada.", "P0001 mesa cuadrada: rechazado con motivo claro");
  const s = clasificar({ error: { message: "El saldo de la mesa cambió mientras cobrabas (ahora es $0.00). Revisa y vuelve a cobrar.", code: "P0001" }, status: 400 }, false);
  revisar(s.tipo === "rechazado" && s.motivo.startsWith("El saldo de la mesa cambió"), "P0001 saldo cambió: rechazado, sin reintento");
  const perm = clasificar({ error: { message: "No tienes permiso para cobrar", code: "P0001" }, status: 400 }, false);
  revisar(perm.tipo === "rechazado" && /dada de baja/.test(perm.motivo), "P0001 sin permiso: rechazado (permiso retirado o baja)");
  const r42 = clasificar({ error: { message: "permission denied for function caja_registrar_pago", code: "42501" }, status: 403 }, false);
  revisar(r42.tipo === "rechazado" && !/caja_registrar/.test(r42.motivo), "42501: rechazado sin nombres internos");
  const otro = clasificar({ error: { message: "column x does not exist", code: "42703" }, status: 400 }, false);
  revisar(otro.tipo === "rechazado" && otro.motivo === MOTIVO_GENERICO, "otro error de la base: rechazado con mensaje genérico");
  // Pasajeros con código (noche cargada): siempre se reintentan.
  for (const [code, status] of [["PGRST000", 503], ["PGRST001", 503], ["PGRST002", 503], ["PGRST003", 504], ["53300", 503], ["53000", 503], ["55P03", 500], ["08006", 503], ["08001", 503], ["57P01", 503], ["40001", 500], ["40P01", 500]]) {
    const c = clasificar({ error: { message: "x", code }, status }, false, 50);
    revisar(c.tipo === "reintentar" && !c.dudoso, `${code} (${status}): reintentar siempre, aunque lleve 50 dudosos`);
  }
  revisar(clasificar({ error: { message: "x", code: "" }, status: 408 }, false).tipo === "reintentar", "408 sin código: reintentar");
  {
    const red = clasificar({ error: { message: "Failed to fetch", code: "" }, status: 0 }, true, 50);
    const sin = clasificar({ error: { message: "x", code: "" }, status: 502 }, false, 50);
    revisar(red.tipo === "reintentar" && !red.dudoso && sin.tipo === "reintentar" && !sin.dudoso, "red caída y 5xx sin código: se reintentan siempre y no cuentan como dudosos");
  }
  // Dudosos: 5xx/408/429 con código desconocido y PGRST202 (PostgREST recargando
  // el esquema en un pase): se reintentan hasta MAX_INTENTOS_DUDOSOS y luego se rechazan.
  for (const [code, status] of [["XX000", 500], ["PGRST999", 503], ["PGRST202", 404], ["ABCDE", 429]]) {
    const c0 = clasificar({ error: { message: "x", code }, status }, false, 0);
    const c8 = clasificar({ error: { message: "x", code }, status }, false, MAX_INTENTOS_DUDOSOS - 2);
    const c9 = clasificar({ error: { message: "x", code }, status }, false, MAX_INTENTOS_DUDOSOS - 1);
    revisar(c0.tipo === "reintentar" && c0.dudoso === true && c8.tipo === "reintentar" && c9.tipo === "rechazado" && c9.motivo === MOTIVO_GENERICO,
      `${code} (${status}): dudoso, se reintenta ${MAX_INTENTOS_DUDOSOS - 1} veces y al ${MAX_INTENTOS_DUDOSOS}.º se rechaza`);
  }
  // 4xx de verdad: rechazo inmediato.
  for (const [code, status] of [["23505", 409], ["22P02", 400], ["23514", 400], ["PGRST116", 406]]) {
    revisar(clasificar({ error: { message: "x", code }, status }, false).tipo === "rechazado", `${code} (${status}): 4xx de verdad, rechazado al momento`);
  }
  revisar(clasificar({ error: { message: "x", code: "42501" }, status: 503 }, false).tipo === "rechazado", "42501 rechazado aunque venga con 503");
  revisar(clasificar({ error: { message: "La mesa ya está cuadrada", code: "P0001" }, status: 400 }, true).tipo === "rechazado", "P0001 gana aunque el navegador diga que no hay red");
}

// 4. Motivos.
{
  revisar(motivoRechazo("La noche ya está cerrada") === "La noche ya está cerrada.", "motivo: noche cerrada");
  revisar(motivoRechazo("La mesa está cerrada y esta acción requiere que esté abierta").includes("falta cuadrarla"), "motivo: mesa cerrada");
  revisar(motivoRechazo("Cuenta no encontrada") === "El cliente ya no está en esa mesa.", "motivo: cuenta no encontrada");
  revisar(motivoRechazo("") === MOTIVO_GENERICO, "motivo vacío: genérico");
}

// 5. Espera creciente.
{
  revisar(esperaMs(1, 0.5) === 2000 && esperaMs(2, 0.5) === 4000 && esperaMs(3, 0.5) === 8000, "espera: 2 s, 4 s, 8 s");
  revisar(esperaMs(20, 0.5) === ESPERA_MAX_MS, "espera: tope de 60 s");
  revisar(esperaMs(1, 0) === 1600 && esperaMs(1, 0.9999) <= 2400, "espera: ±20 % al azar");
}

// 6. Lo ya guardado en la base no se suma dos veces.
{
  const xs = [crearPendiente(nuevo({ clave: "k1" }), "u1", ahora, 0), crearPendiente(nuevo({ clave: "k2" }), "u1", ahora, 1)];
  const r = sinLoYaGuardado(xs, [{ registrado_por: "u1", clave_cliente: "k1" }, { registrado_por: "u2", clave_cliente: "k2" }, { registrado_por: "u1", clave_cliente: null }]);
  revisar(r.yaGuardados.join() === "k1" && r.quedan.map((x) => x.clave).join() === "k2", "sinLoYaGuardado: misma persona y clave = ya está; clave de otro no cuenta");
}

// 7. Montos de la mesa con lo pendiente.
{
  const base = { consumo: 10000, cobrado: 4000, saldo: 6000, otro: "x" };
  const xs = [
    crearPendiente(nuevo({ clave: "c", monto: 2500 }), "u1", ahora, 0),
    crearPendiente(nuevo({ clave: "p", tipo: "pago", monto: 8500 }), "u1", ahora, 1),
    { ...crearPendiente(nuevo({ clave: "r", monto: 99999 }), "u1", ahora, 2), estado: "rechazado" },
    crearPendiente(nuevo({ clave: "o", sesionId: "s2", monto: 7 }), "u1", ahora, 3),
  ];
  const r = conPendientes(base, "s1", xs);
  revisar(r.consumo === 12500 && r.cobrado === 12500 && r.saldo === 0 && r.porEnviar === 2, "conPendientes: suma consumo y cobro pendientes de la sesión (no rechazados ni de otra sesión)");
  revisar(r.otro === "x", "conPendientes: conserva el resto del resumen");
  revisar(conPendientes(base, null, xs).saldo === 6000, "conPendientes: sin sesión no cambia nada");
  const c = conteoPorMesa([...xs, crearPendiente(nuevo({ clave: "z", mesaId: "m2" }), "u1", ahora, 4)]);
  revisar(c.m1.pendientes === 3 && c.m1.rechazados === 1 && c.m2.pendientes === 1, "conteoPorMesa");
  revisar(textoPorEnviar(1) === "1 movimiento por enviar" && textoPorEnviar(3) === "3 movimientos por enviar", "textoPorEnviar");
}

// 8. Limpieza: lo rechazado se va a las 72 h; lo pendiente nunca solo.
{
  const p = crearPendiente(nuevo(), "u1", new Date("2026-11-20T00:00:00Z"), 0);
  const r = { ...p, estado: "rechazado", rechazadoEn: "2026-11-21T00:00:00Z" };
  revisar(!vencido(p, ahora), "vencido: lo pendiente nunca vence");
  revisar(vencido(r, ahora), "vencido: rechazado de hace más de 72 h");
  revisar(!vencido({ ...r, rechazadoEn: "2026-11-24T12:00:00Z" }, ahora), "vencido: rechazado reciente se queda");
  // Pendientes de otra cuenta que nadie va a mandar (72 h sin volver a entrar).
  const viejoAjeno = crearPendiente(nuevo(), "u2", new Date(ahora.getTime() - 73 * 3600 * 1000), 0);
  const recienteAjeno = crearPendiente(nuevo(), "u2", new Date(ahora.getTime() - 71 * 3600 * 1000), 0);
  const viejoPropio = crearPendiente(nuevo(), "u1", new Date(ahora.getTime() - 100 * 3600 * 1000), 0);
  revisar(pendienteAjenoVencido(viejoAjeno, "u1", ahora), "ajeno: pendiente de otra cuenta de hace más de 72 h = vencido");
  revisar(!pendienteAjenoVencido(recienteAjeno, "u1", ahora), "ajeno: pendiente de otra cuenta de hace menos de 72 h se queda");
  revisar(!pendienteAjenoVencido(viejoPropio, "u1", ahora), "ajeno: lo propio nunca vence por esta regla (se manda y la base decide)");
  revisar(!pendienteAjenoVencido({ ...viejoAjeno, estado: "rechazado" }, "u1", ahora), "ajeno: lo ya rechazado no se toca");
  const comoR = comoRechazado(viejoAjeno, MOTIVO_AJENO_VENCIDO, ahora);
  revisar(comoR.estado === "rechazado" && comoR.motivo === MOTIVO_AJENO_VENCIDO && comoR.rechazadoEn === ahora.toISOString() && !vencido(comoR, ahora) && comoR.clave === viejoAjeno.clave,
    "ajeno vencido pasa a rechazado con motivo y desde ahí corre su propia vigencia de 72 h");
  revisar(/dada de baja/.test(MOTIVO_CUENTA_BAJA), "motivo de cuenta dada de baja");
}

// 9. Solo tres funciones posibles.
revisar(Object.values(FUNCION_DE).sort().join() === "caja_registrar_consumo,caja_registrar_consumo_producto,caja_registrar_pago", "la cola solo llama a las 3 funciones idempotentes");

// 10. Reloj del teléfono desfasado: el orden de envío nunca baja.
{
  const t = Date.parse("2026-11-25T05:00:00Z");
  const a = ordenDeCaptura(t, 0, 0);
  revisar(a === t * 1000, "ordenDeCaptura: con la cola vacía usa el reloj");
  // Reloj atrasado 2 h después del primer movimiento.
  const b = ordenDeCaptura(t - 2 * 3600e3, a, 0);
  revisar(b > a, "ordenDeCaptura: con el reloj atrasado 2 h, lo nuevo va DESPUÉS de lo anterior");
  const b2 = ordenDeCaptura(t - 2 * 3600e3, a, 1);
  revisar(b2 > b, "ordenDeCaptura: varios renglones del mismo toque conservan su orden aunque el reloj vaya atrás");
  // Reloj adelantado (un año) y luego corregido: sigue subiendo.
  const c = ordenDeCaptura(t + 365 * 86400e3, b2, 0);
  const d = ordenDeCaptura(t, c, 0);
  revisar(c > b2 && d > c, "ordenDeCaptura: reloj adelantado y luego corregido, el orden sigue subiendo");
  revisar(Number.isSafeInteger(d), "ordenDeCaptura: el número sigue siendo entero exacto");
  revisar(ordenDeCaptura(t, NaN, 0) === t * 1000, "ordenDeCaptura: último orden inválido se ignora");
  // Consumo con el reloj bien y cobro con el reloj atrasado: el cobro sale después.
  const consumo = crearPendiente(nuevo({ clave: "k1" }), "u1", new Date(t), 0, 0);
  const cobro = crearPendiente(nuevo({ clave: "k2", tipo: "pago" }), "u1", new Date(t - 3600e3), 0, consumo.orden);
  revisar(ordenar([cobro, consumo]).map((x) => x.clave).join() === "k1,k2", "con el reloj atrasado entre consumo y cobro, el consumo se envía primero");
}

// 11. Sesión del teléfono frente a la de la caja.
{
  revisar(estadoDeSesion("u1", "u1", false) === "ok", "estadoDeSesion: misma cuenta = ok");
  revisar(estadoDeSesion("u2", "u1", false) === "otra_cuenta", "estadoDeSesion: otra cuenta");
  revisar(estadoDeSesion("u2", "u1", true) === "otra_cuenta", "estadoDeSesion: otra cuenta aunque la red falle");
  revisar(estadoDeSesion(null, "u1", false) === "vencida", "estadoDeSesion: sin sesión y con respuesta = vencida");
  revisar(estadoDeSesion(null, "u1", true) === "desconocida", "estadoDeSesion: sin sesión por falta de red = desconocida (no se declara vencida)");
  revisar(estadoDeSesion("u1", null, false) === "desconocida", "estadoDeSesion: caja sin usuario todavía = desconocida");
  revisar(/1 movimiento de caja de otra cuenta/.test(textoDeOtraCuenta(1)) && /3 movimientos/.test(textoDeOtraCuenta(3)), "textoDeOtraCuenta: solo el número, sin detalle");
}

// 12. Tiempo límite.
{
  const lenta = new Promise((ok) => setTimeout(() => ok("tarde"), 300));
  const r1 = await conLimite(lenta, 30, "vencio");
  const r2 = await conLimite(Promise.resolve("a tiempo"), 300, "vencio");
  revisar(r1 === "vencio" && r2 === "a tiempo", "conLimite: corta lo que no contesta y deja pasar lo que sí");
}

console.log(`\nResultado: ${pasan}/${pasan + fallan}`);
process.exitCode = fallan ? 1 : 0;
