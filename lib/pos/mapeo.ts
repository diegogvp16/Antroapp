// Mapeo de columnas y normalización de ventas del POS. Puro (sin "@/").
//
// 1. elegirEncabezado: la fila de encabezados (muchos reportes traen
//    títulos arriba: «Reporte de ventas del 25/11/2026»).
// 2. sugerirMapeo: propone qué columna es cada dato por el nombre del
//    encabezado (sin acentos ni mayúsculas). La persona lo revisa.
// 3. normalizarVentas: con el mapeo, cada fila → VentaPos, con errores (la
//    fila no entra) y avisos (entra, pero ojo). Las filas de totales del
//    reporte («TOTAL», sin ticket) se ignoran con aviso.
// La base vuelve a validar todo (pos_leer_lineas).

import { detectarFormatoNumeros, leerCantidad, leerMonto, multiplicarCentavos, type FormatoNumeros } from "./numeros";
import { leerFechaHora, nocheDe } from "./fecha-hora";
import {
  CAMPOS_POS,
  LARGO,
  MAX_CANTIDAD_POS,
  MAX_CENTAVOS_POS,
  MAX_LINEAS_POS,
  PRODUCTO_SIN_DETALLE,
  type CampoPos,
  type FilaCruda,
  type MapeoPos,
  type TablaCruda,
  type TablaPos,
  type VentaPos,
} from "./tipos";

export const normalizarEncabezado = (t: string) =>
  (t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Nombres con que los POS suelen llamar a cada dato (ya normalizados).
// «exactos» valen más que «contiene».
const SINONIMOS: Record<CampoPos, { exactos: string[]; contiene: string[] }> = {
  ticket: {
    exactos: ["folio", "ticket", "no ticket", "num ticket", "numero ticket", "numero de ticket", "ticket no", "folio ticket",
      "orden", "no orden", "comanda", "nota", "cheque", "no cheque", "numero de cheque", "no cuenta", "num cuenta",
      "numero de cuenta", "folio cuenta", "id venta", "transaccion", "id transaccion"],
    contiene: ["folio", "ticket", "comanda", "cheque", "orden"],
  },
  fecha: {
    exactos: ["fecha", "fecha hora", "fecha y hora", "fechahora", "fecha de venta", "fecha venta", "fecha apertura",
      "fecha de apertura", "fecha pedido", "fecha de pedido", "fecha ticket", "date", "datetime", "timestamp", "dia"],
    contiene: ["fecha"],
  },
  hora: {
    exactos: ["hora", "hora de venta", "hora de la venta", "hora venta", "hora apertura", "hora de apertura", "hora pedido",
      "hora de pedido", "time"],
    contiene: ["hora"],
  },
  mesa: {
    exactos: ["mesa", "no mesa", "num mesa", "numero de mesa", "numero mesa", "mesa no", "table", "area mesa"],
    contiene: ["mesa"],
  },
  cuenta: {
    exactos: ["cuenta", "comensal", "subcuenta", "cliente", "nombre cliente", "nombre del cliente", "asiento", "silla"],
    contiene: ["comensal", "subcuenta", "cliente"],
  },
  producto: {
    exactos: ["producto", "articulo", "descripcion", "platillo", "item", "concepto", "nombre producto",
      "nombre del producto", "descripcion producto", "producto descripcion", "product"],
    contiene: ["producto", "articulo", "descripcion", "platillo"],
  },
  cantidad: {
    exactos: ["cantidad", "cant", "qty", "unidades", "piezas", "pzas", "cant vendida"],
    contiene: ["cantidad"],
  },
  precio_unitario: {
    exactos: ["precio", "precio unitario", "p unitario", "precio unit", "pu", "precio u", "precio venta", "unit price"],
    contiene: ["precio"],
  },
  total: {
    exactos: ["total", "importe", "monto", "total linea", "importe total", "total partida", "venta", "total venta", "amount"],
    contiene: ["importe", "total", "monto"],
  },
  metodo_pago: {
    exactos: ["forma de pago", "forma pago", "metodo de pago", "metodo pago", "tipo de pago", "tipo pago", "pago"],
    contiene: ["pago"],
  },
  mesero: {
    exactos: ["mesero", "camarero", "empleado", "vendedor", "atendio", "cajero", "usuario", "mesera"],
    contiene: ["mesero", "mesera", "camarero"],
  },
};

/** ¿El encabezado es la hora de CIERRE (o de cobro) del ticket? Ligar
 *  por la hora de cierre puede caer en el grupo que se sentó después. */
export const esColumnaCierre = (encabezado: string) => /\b(cierre|cerrad[ao]s?|cobro|cobrad[ao]|pago|pagad[ao])\b/.test(normalizarEncabezado(encabezado));

function puntaje(campo: CampoPos, encabezado: string): number {
  const h = normalizarEncabezado(encabezado);
  if (!h) return 0;
  const s = SINONIMOS[campo];
  let p = 0;
  if (s.exactos.includes(h)) p = 100 - s.exactos.indexOf(h) * 0.1;
  else {
    const palabras = h.split(" ");
    for (const c of s.contiene) if (palabras.includes(c) || h.includes(c)) {
      p = 50 - s.contiene.indexOf(c);
      break;
    }
  }
  // Fecha u hora de cierre: solo si no hay otra (y con aviso, avisosMapeo).
  if (p > 0 && (campo === "fecha" || campo === "hora") && esColumnaCierre(encabezado)) p = Math.max(1, p - 45);
  return p;
}

/** Fila de encabezados: entre las primeras 15, la que más nombres
 *  reconoce; si ninguna reconoce 2 o más, la primera fila. */
export function elegirEncabezado(cruda: TablaCruda): TablaPos {
  const primeras = cruda.filas.slice(0, 15);
  let mejor = 0;
  let idx = 0;
  primeras.forEach((f, i) => {
    const reconocidos = new Set<CampoPos>();
    for (const celda of f.celdas) for (const c of CAMPOS_POS) if (puntaje(c.campo, celda) >= 50) reconocidos.add(c.campo);
    if (reconocidos.size > mejor) {
      mejor = reconocidos.size;
      idx = i;
    }
  });
  if (mejor < 2) idx = 0;
  const enc = cruda.filas[idx];
  if (!enc) return { encabezados: [], filaEncabezado: 0, filas: [], avisos: cruda.avisos };
  // Encabezados vacíos o repetidos: «Columna C», «Total (2)».
  const vistos = new Map<string, number>();
  const encabezados = enc.celdas.map((c, i) => {
    let nombre = c.trim() || `Columna ${letraColumna(i)}`;
    const k = nombre.toLowerCase();
    const n = (vistos.get(k) ?? 0) + 1;
    vistos.set(k, n);
    if (n > 1) nombre = `${nombre} (${n})`;
    return nombre;
  });
  const avisos = [...cruda.avisos];
  if (idx > 0) avisos.push(`Los encabezados están en la fila ${enc.n}; las filas de arriba se ignoran.`);
  return { encabezados, filaEncabezado: enc.n, filas: cruda.filas.slice(idx + 1), avisos };
}

export function letraColumna(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Propone el mapeo: cada dato a la columna con mejor puntaje, sin repetir columnas. */
export function sugerirMapeo(encabezados: readonly string[]): MapeoPos["columnas"] {
  const pares: { campo: CampoPos; col: string; p: number }[] = [];
  for (const c of CAMPOS_POS) for (const h of encabezados) {
    const p = puntaje(c.campo, h);
    if (p > 0) pares.push({ campo: c.campo, col: h, p });
  }
  pares.sort((a, b) => b.p - a.p);
  const columnas: MapeoPos["columnas"] = {};
  const usadas = new Set<string>();
  for (const { campo, col } of pares) {
    if (columnas[campo] || usadas.has(col)) continue;
    columnas[campo] = col;
    usadas.add(col);
  }
  return columnas;
}

/** ¿El mapeo alcanza para importar? Devuelve lo que falta (vacío = listo). */
export function faltantesMapeo(mapeo: MapeoPos, encabezados: readonly string[]): string[] {
  const c = mapeo.columnas;
  const existe = (campo: CampoPos) => Boolean(c[campo] && encabezados.includes(c[campo] as string));
  const faltan: string[] = [];
  if (!existe("ticket")) faltan.push("Ticket o folio");
  if (!existe("fecha")) faltan.push("Fecha");
  if (!existe("total") && !existe("precio_unitario")) faltan.push("Total (o precio unitario)");
  const usadas = Object.values(c).filter(Boolean);
  if (new Set(usadas).size !== usadas.length) faltan.push("Cada columna solo puede ser un dato");
  return faltan;
}

/** El mapeo guardado, pero solo con columnas que existen en este archivo. */
export function ajustarMapeo(guardado: MapeoPos, encabezados: readonly string[]): MapeoPos {
  const columnas: MapeoPos["columnas"] = {};
  for (const [campo, col] of Object.entries(guardado.columnas ?? {})) {
    if (col && encabezados.includes(col)) columnas[campo as CampoPos] = col;
  }
  const ajustado: MapeoPos = { columnas, formato_fecha: guardado.formato_fecha === "mdy" ? "mdy" : "dmy" };
  if (guardado.formato_montos === "punto" || guardado.formato_montos === "coma") ajustado.formato_montos = guardado.formato_montos;
  return ajustado;
}

/** Avisos del mapeo (no impiden importar). */
export function avisosMapeo(mapeo: MapeoPos): string[] {
  const avisos: string[] = [];
  const cierre = (["fecha", "hora"] as const).map((c) => mapeo.columnas[c]).filter((c): c is string => Boolean(c && esColumnaCierre(c)));
  if (cierre.length) {
    avisos.push(
      `«${cierre[0]}» parece la hora de CIERRE o cobro del ticket. Las ventas se ligan a la mesa por esa hora: si la mesa ya tenía otro grupo, pueden quedar en el grupo equivocado o pedir que elijas. Si el POS trae la hora de la venta o de apertura, usa esa.`,
    );
  }
  return avisos;
}

/** Formato de los números (punto o coma decimal) de las columnas de
 *  montos y cantidad: el del mapeo; si no, el de los valores de cada
 *  columna; si una columna no lo dice, el del resto. */
export function formatosNumeros(tabla: TablaPos, mapeo: MapeoPos): {
  detectado: FormatoNumeros | "mixto" | null;
  porColumna: Partial<Record<"total" | "precio_unitario" | "cantidad", FormatoNumeros>>;
} {
  const valores = (campo: CampoPos) => {
    const i = mapeo.columnas[campo] ? tabla.encabezados.indexOf(mapeo.columnas[campo] as string) : -1;
    return i < 0 ? [] : tabla.filas.map((f) => f.celdas[i] ?? "");
  };
  const campos = ["total", "precio_unitario", "cantidad"] as const;
  const detectado = detectarFormatoNumeros(campos.flatMap((c) => valores(c)));
  const porColumna: Partial<Record<(typeof campos)[number], FormatoNumeros>> = {};
  for (const c of campos) {
    if (mapeo.formato_montos) porColumna[c] = mapeo.formato_montos;
    else {
      const propio = detectarFormatoNumeros(valores(c));
      if (propio === "punto" || propio === "coma") porColumna[c] = propio;
      else if (propio === null && (detectado === "punto" || detectado === "coma")) porColumna[c] = detectado;
    }
  }
  return { detectado, porColumna };
}

export interface FilaRevisada {
  linea: number;
  venta: VentaPos | null;
  errores: string[];
  avisos: string[];
  /** Fila de totales del reporte u otra que no es venta: no cuenta. */
  ignorada: boolean;
}

export interface ResultadoNormalizar {
  filas: FilaRevisada[];
  ventas: VentaPos[];
  conError: number;
  ignoradas: number;
  totalCentavos: number;
  noches: string[];
  /** Error de todo el archivo (p. ej. demasiadas líneas). */
  errorGeneral: string | null;
}

const limpiar = (t: string | undefined) => (t ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();

export function normalizarVentas(tabla: TablaPos, mapeo: MapeoPos): ResultadoNormalizar {
  const idx = (campo: CampoPos) => {
    const col = mapeo.columnas[campo];
    return col ? tabla.encabezados.indexOf(col) : -1;
  };
  const i = Object.fromEntries(CAMPOS_POS.map((c) => [c.campo, idx(c.campo)])) as Record<CampoPos, number>;
  const celda = (f: FilaCruda, campo: CampoPos) => (i[campo] >= 0 ? limpiar(f.celdas[i[campo]]) : "");
  const formato = mapeo.formato_fecha === "mdy" ? "mdy" : "dmy";
  const { porColumna } = formatosNumeros(tabla, mapeo);
  const filas: FilaRevisada[] = [];

  for (const f of tabla.filas) {
    const errores: string[] = [];
    const avisos: string[] = [];
    const mapeadas = CAMPOS_POS.map((c) => celda(f, c.campo));
    if (mapeadas.every((x) => x === "")) continue; // fila vacía en las columnas que importan
    const ticket = celda(f, "ticket");
    if (!ticket) {
      if (f.celdas.some((x) => /^(gran )?total(es)?\b|^suma\b|^subtotal\b/i.test(limpiar(x)))) {
        filas.push({ linea: f.n, venta: null, errores: [], avisos: ["Fila de totales del reporte: se ignora."], ignorada: true });
        continue;
      }
      errores.push("falta el ticket o folio");
    } else if (ticket.length > LARGO.ticket) errores.push(`el ticket tiene más de ${LARGO.ticket} caracteres`);

    const fh = leerFechaHora(celda(f, "fecha"), i.hora >= 0 ? celda(f, "hora") : null, formato);
    if (!fh.ok) errores.push(fh.error);

    // Cantidad
    let cantidad = 1;
    const tCant = celda(f, "cantidad");
    if (tCant) {
      const c = leerCantidad(tCant, MAX_CANTIDAD_POS, porColumna.cantidad);
      if (!c.ok) errores.push(`cantidad: ${c.error}`);
      else if (c.valor === 0) errores.push("la cantidad es 0");
      else {
        cantidad = c.valor;
        if (c.redondeado) avisos.push("La cantidad se redondeó a 3 decimales.");
      }
    }
    // Precio unitario
    let precio: number | null = null;
    const tPrecio = celda(f, "precio_unitario");
    if (tPrecio) {
      const p = leerMonto(tPrecio, MAX_CENTAVOS_POS, porColumna.precio_unitario);
      if (!p.ok) errores.push(`precio: ${p.error}`);
      else precio = p.valor;
    }
    // Total
    let total: number | null = null;
    const tTotal = celda(f, "total");
    if (tTotal) {
      const t = leerMonto(tTotal, MAX_CENTAVOS_POS, porColumna.total);
      if (!t.ok) errores.push(`total: ${t.error}`);
      else {
        total = t.valor;
        if (t.redondeado) avisos.push("El total se redondeó a centavos.");
      }
    } else if (precio !== null) {
      total = multiplicarCentavos(cantidad, precio);
      if (Math.abs(total) > MAX_CENTAVOS_POS) errores.push("el total (cantidad × precio) es demasiado grande");
    } else if (!errores.some((e) => e.startsWith("total") || e.startsWith("precio"))) errores.push("falta el total");

    if (total !== null && precio !== null && tTotal && Math.abs(multiplicarCentavos(cantidad, precio) - total) > 1) {
      avisos.push("El total no es cantidad × precio (¿descuento?). Se usa el total.");
    }
    if (total !== null && total < 0) avisos.push("Total negativo (devolución o cancelación): resta.");
    else if (total === 0) avisos.push("Total en cero (cortesía).");
    if (cantidad < 0 && (total ?? 0) >= 0) avisos.push("Cantidad negativa con total positivo: revisa la línea.");

    const mesa = celda(f, "mesa");
    if (mesa.length > LARGO.mesa) errores.push(`la mesa tiene más de ${LARGO.mesa} caracteres`);
    if (!mesa && i.mesa >= 0) avisos.push("Sin mesa: se guarda, pero no se liga a la caja.");

    let producto = celda(f, "producto");
    if (!producto) producto = PRODUCTO_SIN_DETALLE;
    if (producto.length > LARGO.producto) {
      producto = producto.slice(0, LARGO.producto);
      avisos.push(`El producto se recortó a ${LARGO.producto} caracteres.`);
    }
    const recortar = (t: string, n: number, nombre: string) => {
      if (t.length <= n) return t || null;
      avisos.push(`${nombre} se recortó a ${n} caracteres.`);
      return t.slice(0, n);
    };
    const cuenta = recortar(celda(f, "cuenta"), LARGO.cuenta, "La cuenta");
    const metodoPago = recortar(celda(f, "metodo_pago"), LARGO.metodo_pago, "La forma de pago");
    const mesero = recortar(celda(f, "mesero"), LARGO.mesero, "El mesero");

    const venta: VentaPos | null =
      errores.length || !fh.ok || total === null
        ? null
        : { linea: f.n, ticket, fechaHora: fh.valor, mesa: mesa || null, cuenta, producto, cantidad, precioUnitarioCentavos: precio, totalCentavos: total, metodoPago, mesero };
    filas.push({ linea: f.n, venta, errores, avisos, ignorada: false });
  }

  // Fechas futuras (más de un día): error, igual que en la base (que lo
  // revisa con la hora del antro; aquí, con la de UTC, un poco más holgado).
  const limite = new Date(Date.now() + 86400000).toISOString().slice(0, 19);
  for (const f of filas) {
    if (f.venta && f.venta.fechaHora > limite) {
      f.errores.push("la fecha es futura");
      f.venta = null;
    } else if (f.venta && f.venta.fechaHora < "2020-01-01") {
      f.errores.push("la fecha es anterior a 2020");
      f.venta = null;
    }
  }
  const validas = filas.flatMap((f) => (f.venta ? [f.venta] : []));
  return {
    filas,
    ventas: validas,
    conError: filas.filter((f) => f.errores.length).length,
    ignoradas: filas.filter((f) => f.ignorada).length,
    totalCentavos: validas.reduce((a, v) => a + v.totalCentavos, 0),
    noches: [...new Set(validas.map((v) => nocheDe(v.fechaHora)))].sort(),
    errorGeneral:
      validas.length > MAX_LINEAS_POS
        ? `Máximo ${MAX_LINEAS_POS.toLocaleString("es-MX")} líneas por importación (vienen ${validas.length.toLocaleString("es-MX")}). Parte el archivo por noche.`
        : null,
  };
}

/** Lo que se manda a la base (pos_preparar / pos_importar). */
export function lineasParaBase(ventas: readonly VentaPos[], asignadas: ReadonlyMap<number, string> = new Map()) {
  return ventas.map((v) => ({
    linea: v.linea,
    ticket: v.ticket,
    fecha_hora: v.fechaHora,
    mesa: v.mesa,
    cuenta: v.cuenta,
    producto: v.producto,
    cantidad: v.cantidad,
    precio_unitario_centavos: v.precioUnitarioCentavos,
    total_centavos: v.totalCentavos,
    metodo_pago: v.metodoPago,
    mesero: v.mesero,
    cuenta_id: asignadas.get(v.linea) ?? null,
  }));
}

/** Valores de muestra de una columna (para el paso de mapeo). */
export function muestras(tabla: TablaPos, columna: string, n = 3): string[] {
  const i = tabla.encabezados.indexOf(columna);
  if (i < 0) return [];
  const salida: string[] = [];
  for (const f of tabla.filas) {
    const v = limpiar(f.celdas[i]);
    if (v && !salida.includes(v)) salida.push(v);
    if (salida.length >= n) break;
  }
  return salida;
}
