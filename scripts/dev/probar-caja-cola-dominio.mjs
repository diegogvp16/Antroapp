// Pruebas de lib/domain/caja-cola.ts (reglas puras de la cola de caja sin
// señal). No toca ninguna base: Node 24 carga el .ts directo (quita los tipos).
//
//   node scripts/dev/probar-caja-cola-dominio.mjs

import {
  FUNCION_DE,
  clasificar,
  conPendientes,
  conteoPorMesa,
  crearPendiente,
  esperaMs,
  motivoRechazo,
  porEnviar,
  sinLoYaGuardado,
  textoPorEnviar,
  vencido,
  ESPERA_MAX_MS,
  MOTIVO_GENERICO,
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
  revisar(clasificar({ error: { message: "Could not find the function", code: "PGRST202" }, status: 404 }, false).tipo === "rechazado", "PGRST202 (base sin la función): rechazado, no se reintenta sin clave");
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
}

// 9. Solo tres funciones posibles.
revisar(Object.values(FUNCION_DE).sort().join() === "caja_registrar_consumo,caja_registrar_consumo_producto,caja_registrar_pago", "la cola solo llama a las 3 funciones idempotentes");

console.log(`\nResultado: ${pasan}/${pasan + fallan}`);
process.exitCode = fallan ? 1 : 0;
