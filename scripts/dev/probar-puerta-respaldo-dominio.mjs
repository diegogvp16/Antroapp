// Pruebas de lib/domain/puerta-respaldo.ts (reglas puras del escáner de
// respaldo). No toca ninguna base: Node 24 carga el .ts directo.
//
//   node scripts/dev/probar-puerta-respaldo-dominio.mjs

import { createHash } from "node:crypto";
import {
  buscarPorCodigo,
  buscarPorHuella,
  clasificarEnvio,
  copiaVencida,
  copiaVieja,
  crearEntrada,
  formatearCodigo,
  leerCodigoEscrito,
  leerCopia,
  porEnviar,
  resueltaVencida,
  sufijoDe,
  textoPendientes,
  MOTIVO_RECHAZO_GENERICO,
  MOTIVO_ENTRADA_VENCIDA,
  pendienteVencida,
  planBarrido,
} from "../../lib/domain/puerta-respaldo.ts";

const resultados = [];
function nota(texto, ok, detalle = "") {
  resultados.push(ok);
  console.log(`${ok ? "OK   " : "FALLA"}  ${texto}${detalle ? "  — " + detalle : ""}`);
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const QR = "antro-4fe556af-dbb5-4040-8da8-1c3ddd94b283";

// ---------- Código escrito ----------
nota("sufijo: 6 últimos en mayúsculas", sufijoDe(QR) === "94B283");
nota("formato: dos grupos de 3", formatearCodigo("94b283") === "94B 283");
nota("código completo", igual(leerCodigoEscrito(QR), { tipo: "completo", qr: QR }));
nota("código completo en mayúsculas y con espacios", igual(leerCodigoEscrito(`  ${QR.toUpperCase()} `), { tipo: "completo", qr: QR }));
nota("enlace del boleto pegado", igual(leerCodigoEscrito(`https://antroapp.vercel.app/r/${QR}`), { tipo: "completo", qr: QR }));
nota("enlace con %2D no rompe", leerCodigoEscrito(`https://x/r/${QR}?a=1`).tipo === "completo");
nota("uuid solo", igual(leerCodigoEscrito(QR.slice(6)), { tipo: "completo", qr: QR }));
nota("código corto con espacio", igual(leerCodigoEscrito("94B 283"), { tipo: "corto", codigo: "94b283" }));
nota("código corto con guion", igual(leerCodigoEscrito("94b-283"), { tipo: "corto", codigo: "94b283" }));
nota("código corto de 12", igual(leerCodigoEscrito("1c3ddd94b283"), { tipo: "corto", codigo: "1c3ddd94b283" }));
nota("menos de 6: inválido", leerCodigoEscrito("94b28").tipo === "invalido");
nota("más de 12: inválido", leerCodigoEscrito("81c3ddd94b283").tipo === "invalido");
nota("letras fuera de A–F: inválido", leerCodigoEscrito("94G283").tipo === "invalido");
nota("vacío: inválido", leerCodigoEscrito("   ").tipo === "invalido");
nota("comodines de SQL no pasan", leerCodigoEscrito("%%%%%%").tipo === "invalido" && leerCodigoEscrito("______").tipo === "invalido");

// ---------- Copia ----------
const huella = createHash("sha256").update(QR, "utf8").digest("hex");
const crudo = {
  club_id: "c1",
  noche: "2026-11-27",
  generada_en: "2026-11-28T04:00:00Z",
  vence_en: "2026-11-28T14:00:00Z",
  reservas: [
    { reservation_id: "r1", qr_sha256: huella, sufijo: "94b283", entro: false, entrada_en: null, cliente_nombre: "Ana", personas: 2, source: "rp", rp_nombre: "Luis" },
    { reservation_id: "r2", qr_sha256: "aa", sufijo: "ABC123", entro: true, entrada_en: "2026-11-28T05:00:00Z", cliente_nombre: null, personas: 3, source: "organica", rp_nombre: null },
    { reservation_id: "r3", qr_sha256: "bb", sufijo: "ABC123", entro: false, entrada_en: null, cliente_nombre: "Beto", personas: 1, source: "organica", rp_nombre: null },
  ],
};
const copia = leerCopia(crudo, "u1");
nota("lee la copia de la base", copia?.clave === "u1:c1" && copia.reservas.length === 3 && copia.reservas[0].sufijo === "94B283");
nota("copia: total y truncada", copia.truncada === false && copia.total === 3 && leerCopia({ ...crudo, truncada: true, total: 3500 }, "u1").truncada === true);
nota("copia con forma rara: null", leerCopia({ ...crudo, reservas: [{ x: 1 }] }, "u1") === null && leerCopia(null, "u1") === null);
nota("busca por huella", buscarPorHuella(copia, huella).reserva?.reservation_id === "r1");
nota("huella que no está", buscarPorHuella(copia, "ff").tipo === "no_encontrada");
nota("busca por código corto", buscarPorCodigo(copia, "94b283").reserva?.reservation_id === "r1");
nota("código con más de 6: usa los últimos 6", buscarPorCodigo(copia, "1c3ddd94b283").reserva?.reservation_id === "r1");
nota("dos con el mismo código: varias", buscarPorCodigo(copia, "abc123").tipo === "varias");
nota("vence a las 08:00 (hora del antro, según la base)", !copiaVencida(copia, new Date("2026-11-28T13:59:00Z")) && copiaVencida(copia, new Date("2026-11-28T14:00:00Z")));
nota("vencimiento ilegible: vencida", copiaVencida({ venceEn: "x" }, new Date()));
nota("vieja después de 30 min", !copiaVieja(copia, new Date("2026-11-28T04:29:00Z")) && copiaVieja(copia, new Date("2026-11-28T04:31:00Z")));

// ---------- Entradas ----------
const e1 = crearEntrada({ usuarioId: "u1", clubId: "c1", reservationId: "r1", clienteNombre: "Ana", personas: 2, origen: "camara" }, "k1", new Date("2026-11-28T05:00:00Z"), "2026-11-28T14:00:00Z");
const e2 = { ...e1, clave: "k2", escaneadoEn: "2026-11-28T04:00:00Z" };
const e3 = { ...e1, clave: "k3", usuarioId: "u2" };
const e4 = { ...e1, clave: "k4", estado: "enviada" };
nota("nace pendiente, con la hora del teléfono", e1.estado === "pendiente" && e1.escaneadoEn === "2026-11-28T05:00:00.000Z" && e1.intentos === 0);
nota("por enviar: solo las pendientes de esa cuenta, en orden", igual(porEnviar([e1, e2, e3, e4], "u1").map((x) => x.clave), ["k2", "k1"]));
nota("resuelta se borra a las 24 h; pendiente nunca", resueltaVencida({ ...e4, resueltoEn: "2026-11-27T04:00:00Z" }, new Date("2026-11-28T05:00:00Z")) && !resueltaVencida({ ...e1, escaneadoEn: "2020-01-01T00:00:00Z" }, new Date()));

// ---------- Clasificar la respuesta ----------
nota("red: reintentar", clasificarEnvio({ error: { message: "Failed to fetch" } }, true).tipo === "reintentar");
nota("error sin código (5xx, sesión): reintentar", clasificarEnvio({ error: { message: "JWT expired", code: "PGRST301" } }, false).tipo === "reintentar");
const rech = clasificarEnvio({ error: { message: "La reserva es para el 2026-11-26, no para esta noche", code: "P0001" } }, false);
nota("aviso de la base (P0001): rechazada con su texto", rech.tipo === "rechazada" && rech.motivo.startsWith("La reserva es para"));
nota("entro: enviada", clasificarEnvio({ data: { resultado: "entro", entrada_en: "t", hora_local: "23:10" } }, false).tipo === "enviada");
nota("ya_enviada (respuesta perdida): enviada", clasificarEnvio({ data: { resultado: "ya_enviada", entrada_en: "t" } }, false).tipo === "enviada");
const dupOtro = clasificarEnvio({ data: { resultado: "ya_entro", por_ti: false, entrada_en: "t", hora_local: "23:10" } }, false);
nota("ya_entro por otro: duplicada, con la hora", dupOtro.tipo === "duplicada" && /otro teléfono u otra persona/.test(dupOtro.motivo) && /23:10/.test(dupOtro.motivo), dupOtro.motivo);
const dupTuya = clasificarEnvio({ data: { resultado: "ya_entro", por_ti: true, hora_local: "23:10" } }, false);
nota("ya_entro por ti: duplicada, dice que con tu cuenta", dupTuya.tipo === "duplicada" && /con tu cuenta/.test(dupTuya.motivo));
nota("respuesta rara: rechazada genérica", igual(clasificarEnvio({ data: { resultado: "otra" } }, false), { tipo: "rechazada", motivo: MOTIVO_RECHAZO_GENERICO }));
nota("textos del contador", textoPendientes(1) === "1 entrada pendiente de enviar" && textoPendientes(3) === "3 entradas pendientes de enviar");

// ---------- Vencimiento de pendientes (punto 6 de la revisión) ----------
nota("pendiente vence a las 08:00 de la copia + 2 h", e1.venceEn === "2026-11-28T16:00:00.000Z");
nota("…antes no está vencida; después sí", !pendienteVencida(e1, new Date("2026-11-28T15:59:00Z")) && pendienteVencida(e1, new Date("2026-11-28T16:00:00Z")));
const sinCopia = crearEntrada({ usuarioId: "u1", clubId: "c1", reservationId: "r9", clienteNombre: "X", personas: 1, origen: "codigo" }, "k9", new Date("2026-11-28T05:00:00Z"), null);
nota("sin copia: vence a las 12 h", sinCopia.venceEn === "2026-11-28T17:00:00.000Z");
nota("versión vieja sin venceEn: vence a las 12 h de capturada", pendienteVencida({ ...e1, venceEn: undefined }, new Date("2026-11-28T17:00:01Z")));
nota("por enviar no incluye las vencidas", porEnviar([e1], "u1", new Date("2026-11-28T17:00:00Z")).length === 0);

// ---------- Barrido ----------
const ahoraB = new Date("2026-11-28T17:00:00Z");
const cVig = { clave: "u1:c1", usuarioId: "u1", venceEn: "2026-11-29T14:00:00Z" };
const cVen = { clave: "u1:c2", usuarioId: "u1", venceEn: "2026-11-28T14:00:00Z" };
const cOtra = { clave: "u2:c1", usuarioId: "u2", venceEn: "2026-11-29T14:00:00Z" };
const pVig = { ...e1, clave: "p1", venceEn: "2026-11-29T16:00:00Z" };
const pVen = { ...e1, clave: "p2" }; // vence 2026-11-28T16:00
const pOtraVig = { ...pVig, clave: "p3", usuarioId: "u2" };
const pOtraVen = { ...pVen, clave: "p4", usuarioId: "u2" };
const rOtra = { ...pVig, clave: "p5", usuarioId: "u2", estado: "enviada", resueltoEn: "2026-11-28T16:59:00Z" };
const rMiaVieja = { ...pVig, clave: "p6", estado: "duplicada", resueltoEn: "2026-11-27T16:00:00Z" };
const b1 = planBarrido([cVig, cVen, cOtra], [pVig, pVen, pOtraVig, pOtraVen, rOtra, rMiaVieja], "u1", ahoraB);
nota("barrido con sesión: borra la copia vencida y la de otra cuenta", JSON.stringify(b1.copiasBorrar.sort()) === JSON.stringify(["u1:c2", "u2:c1"]));
nota("…vence la pendiente propia (rechazada, con el motivo)", b1.entradasVencer.length === 1 && b1.entradasVencer[0].clave === "p2" && b1.entradasVencer[0].estado === "rechazada" && b1.entradasVencer[0].motivo === MOTIVO_ENTRADA_VENCIDA);
nota("…borra pendiente vencida ajena, resuelta ajena y resuelta vieja; deja la pendiente vigente ajena", JSON.stringify(b1.entradasBorrar.sort()) === JSON.stringify(["p4", "p5", "p6"]));
const b2 = planBarrido([cVig, cVen, cOtra], [pVig, pVen, pOtraVig, rOtra], null, ahoraB);
nota("barrido sin sesión conocida: solo lo vencido", JSON.stringify(b2.copiasBorrar) === JSON.stringify(["u1:c2"]) && JSON.stringify(b2.entradasBorrar) === JSON.stringify(["p2"]) && b2.entradasVencer.length === 0);

const pasan = resultados.filter(Boolean).length;
console.log(`\nResultado: ${pasan}/${resultados.length}`);
process.exitCode = pasan === resultados.length ? 0 : 1;
