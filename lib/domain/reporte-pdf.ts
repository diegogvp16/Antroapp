// Reportes PDF del dueño: «Reporte de la noche» y «Reporte de la semana»
// (sql/post-junta-3/70-reportes-pdf.sql, docs/post-junta-3/reportes.md).
//
// Ninguna cifra se calcula aquí: todas vienen de la base
// (reporte_pdf_noche = reporte_cierre_noche; reporte_pdf_semana = las 7
// noches del cierre, sus sumas y grupo_rendimiento_rp). Aquí solo se
// normaliza lo que llega, se da formato (centavos → pesos MXN al final) y se
// arma el PDF con lib/pdf/escritor.ts.

import { ALTO_HOJA, ANCHO_HOJA, DocumentoPdf, partirTexto, recortarTexto, type Alineacion, type Color, type Fuente } from "@/lib/pdf/escritor";
import { esParcial, fechaHoraEnZona, normalizarReporte, textoDiferencia, type ReporteCierre } from "@/lib/domain/cierre-noche";

// ---------------------------------------------------------------------------
// Datos.
// ---------------------------------------------------------------------------

export type ReporteNochePdf = ReporteCierre & { generado_local: string };

export interface RpSemana {
  rp_id: string;
  rp_nombre: string;
  rp_activo: boolean;
  reservas: number;
  por_venir: number;
  entraron: number;
  consumieron: number;
  consumo_centavos: number;
  ticket_centavos: number;
  comisiones_centavos: number;
}

const CLAVES_NOCHE_SEMANA = [
  "reservas",
  "personas",
  "entraron",
  "consumieron",
  "no_llegaron",
  "por_llegar",
  "cuentas",
  "cuentas_walk_in",
  "personas_walk_in",
  "mesas_usadas",
  "grupos",
  "consumo_centavos",
  "cuentas_con_consumo",
  "ticket_promedio_centavos",
  "efectivo_centavos",
  "tarjeta_centavos",
  "otro_centavos",
  "cobrado_centavos",
  "por_cobrar_centavos",
  "comision_reserva_centavos",
  "pago_dia_centavos",
  "comisiones_centavos",
  "cuentas_rp_sin_cuadrar",
  "consumos_anulados",
  "consumos_anulados_centavos",
  "cobros_anulados",
  "cobros_anulados_centavos",
  "mesas_reabiertas",
  "diferencia_centavos",
] as const;
type ClaveNocheSemana = (typeof CLAVES_NOCHE_SEMANA)[number];

export type NocheSemana = Record<ClaveNocheSemana, number> & {
  fecha: string;
  momento: "pasada" | "en_curso" | "futura";
  termino: boolean;
  estado_caja: "abierta" | "cerrada" | "sin_caja";
  /** La noche se cerró en caja con cuadre general (si no, diferencia_centavos = 0 y no cuenta). */
  con_cuadre: boolean;
};

export type TotalesSemana = Record<Exclude<ClaveNocheSemana, "mesas_usadas">, number> & {
  noches_con_consumo: number;
  noches_sin_terminar: number;
  noches_con_cuadre: number;
};

export interface ReporteSemanaPdf {
  club: { id: string; nombre: string; zona_horaria: string };
  lunes: string;
  domingo: string;
  semana_iso: { anio: number; semana: number };
  noche_en_curso: string;
  parcial: boolean;
  mesas_antro: number;
  noches: NocheSemana[];
  totales: TotalesSemana;
  rps: RpSemana[];
  generado_en: string;
  generado_local: string;
}

type Crudo = Record<string, unknown>;
const obj = (v: unknown): Crudo => (v && typeof v === "object" && !Array.isArray(v) ? (v as Crudo) : {});
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const texto = (v: unknown): string => (typeof v === "string" ? v : "");
function numeros<K extends string>(fuente: unknown, claves: readonly K[]): Record<K, number> {
  const o = obj(fuente);
  return Object.fromEntries(claves.map((k) => [k, num(o[k])])) as Record<K, number>;
}

/** Texto libre (nombres, notas) a lo más `max` letras, con "…". La base no
 *  siempre limita el largo y el PDF no debe crecer sin fin por un nombre. */
export function limitar(t: string, max = 120): string {
  if (t.length <= max) return t;
  const letras = Array.from(t);
  return letras.length <= max ? t : letras.slice(0, max - 1).join("").trimEnd() + "…";
}

export function normalizarNochePdf(crudo: unknown): ReporteNochePdf {
  const r = normalizarReporte(crudo);
  return {
    ...r,
    club: { ...r.club, nombre: limitar(r.club.nombre) },
    cuadre: r.cuadre
      ? {
          ...r.cuadre,
          notas: r.cuadre.notas === null ? null : limitar(r.cuadre.notas, 300),
          hecho_por_nombre: r.cuadre.hecho_por_nombre === null ? null : limitar(r.cuadre.hecho_por_nombre, 80),
        }
      : null,
    rps: r.rps.map((x) => ({ ...x, rp_nombre: limitar(x.rp_nombre) })),
    generado_local: texto(obj(crudo).generado_local),
  };
}

export function normalizarSemanaPdf(crudo: unknown): ReporteSemanaPdf {
  const r = obj(crudo);
  const club = obj(r.club);
  const semana = obj(r.semana_iso);
  const totales = obj(r.totales);
  return {
    club: { id: texto(club.id), nombre: limitar(texto(club.nombre)), zona_horaria: texto(club.zona_horaria) || "America/Mexico_City" },
    lunes: texto(r.lunes),
    domingo: texto(r.domingo),
    semana_iso: { anio: num(semana.anio), semana: num(semana.semana) },
    noche_en_curso: texto(r.noche_en_curso),
    parcial: r.parcial === true,
    mesas_antro: num(r.mesas_antro),
    noches: (Array.isArray(r.noches) ? r.noches : []).map((x) => {
      const o = obj(x);
      const m = o.momento;
      const e = o.estado_caja;
      return {
        ...numeros(o, CLAVES_NOCHE_SEMANA),
        fecha: texto(o.fecha),
        momento: m === "pasada" || m === "futura" ? m : "en_curso",
        termino: o.termino === true,
        estado_caja: e === "abierta" || e === "cerrada" ? e : "sin_caja",
        con_cuadre: o.con_cuadre === true,
      };
    }),
    totales: {
      ...numeros(
        totales,
        CLAVES_NOCHE_SEMANA.filter((k): k is Exclude<ClaveNocheSemana, "mesas_usadas"> => k !== "mesas_usadas"),
      ),
      noches_con_consumo: num(totales.noches_con_consumo),
      noches_sin_terminar: num(totales.noches_sin_terminar),
      noches_con_cuadre: num(totales.noches_con_cuadre),
    },
    rps: (Array.isArray(r.rps) ? r.rps : []).map((x) => {
      const o = obj(x);
      return {
        rp_id: texto(o.rp_id),
        rp_nombre: limitar(texto(o.rp_nombre) || "RP sin nombre"),
        rp_activo: o.rp_activo !== false,
        ...numeros(o, ["reservas", "por_venir", "entraron", "consumieron", "consumo_centavos", "ticket_centavos", "comisiones_centavos"] as const),
      };
    }),
    generado_en: texto(r.generado_en),
    generado_local: texto(r.generado_local),
  };
}

// ---------------------------------------------------------------------------
// Formato (solo al mostrar).
// ---------------------------------------------------------------------------

const formatoPesos = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
/** Centavos → "$1,234.50" (siempre con centavos: el reporte cuadra al centavo). */
export function pesos(centavos: number): string {
  return formatoPesos.format(centavos / 100).replace(/[  ]/g, " ").replace(/−/g, "-");
}
const formatoEntero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
export const entero = (n: number) => formatoEntero.format(n);

function fechaUtc(fechaISO: string): Date {
  const [a, m, d] = fechaISO.split("-").map(Number);
  return new Date(Date.UTC(a, (m || 1) - 1, d || 1));
}
const formatoFechaLarga = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const formatoFechaCorta = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const formatoDiaMes = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });

/** "2026-11-25" → "miércoles 25 de noviembre de 2026". */
export function fechaLarga(fechaISO: string): string {
  return formatoFechaLarga.format(fechaUtc(fechaISO)).replace(",", "");
}
/** "2026-11-25" → "mié 25 nov". */
export function fechaCorta(fechaISO: string): string {
  return formatoFechaCorta.format(fechaUtc(fechaISO)).replace(/\./g, "").replace(",", "");
}
/** "2026-11-23", "2026-11-29" → "del 23 de noviembre al 29 de noviembre de 2026". */
export function rangoSemana(lunes: string, domingo: string): string {
  const a = formatoDiaMes.format(fechaUtc(lunes));
  const b = formatoDiaMes.format(fechaUtc(domingo));
  const sinAnio = a.replace(/ de \d{4}$/, "");
  return lunes.slice(0, 4) === domingo.slice(0, 4) ? `del ${sinAnio} al ${b}` : `del ${a} al ${b}`;
}
/** "2026-11-27 14:05" → "27 de noviembre de 2026, 14:05". */
export function generadoTexto(local: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(local);
  if (!m) return local || "—";
  return `${formatoDiaMes.format(fechaUtc(m[1]))}, ${m[2]}`;
}

export function nombreArchivoPdf(tipo: "noche" | "semana", nombreAntro: string, fecha: string): string {
  const slug =
    nombreAntro
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "antro";
  const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : tipo;
  return `reporte-${tipo}-${slug}-${f}.pdf`;
}

/** ¿La noche tiene algo que reportar? */
export function nocheConDatos(rep: ReporteCierre): boolean {
  return (
    rep.reservas.reservas > 0 ||
    rep.consumo.total_centavos !== 0 ||
    rep.walk_ins.cuentas_total > 0 ||
    rep.cobros.total_centavos !== 0 ||
    rep.comisiones.total_centavos !== 0 ||
    rep.rps.length > 0
  );
}

export function semanaConDatos(rep: ReporteSemanaPdf): boolean {
  const t = rep.totales;
  return t.reservas > 0 || t.consumo_centavos !== 0 || t.cuentas > 0 || t.cobrado_centavos !== 0 || t.comisiones_centavos !== 0 || rep.rps.length > 0;
}

// ---------------------------------------------------------------------------
// Textos fijos del PDF (definiciones y fuente de las cifras).
// ---------------------------------------------------------------------------

export const DEF_TICKET =
  "Ticket promedio = consumo total ÷ cuentas con consumo, redondeado al centavo. Una cuenta es la de un cliente en una mesa (con reserva o walk-in); cuenta con consumo = tiene al menos un consumo no anulado.";
export const DEF_TICKET_SEMANA =
  "En la semana se divide el consumo de las 7 noches entre todas sus cuentas con consumo (no es el promedio de los tickets de cada noche).";

const DEFINICIONES_COMUNES = [
  "Noche: la noche de operación del antro, que termina a las 08:00 del día siguiente en su zona horaria.",
  "Consumo total: todo lo registrado en caja (cuentas con y sin reserva), sin anulados.",
  "Cuenta: la de un cliente en una mesa (con reserva o walk-in). Grupo de mesa: cada vez que se ocupa una mesa en la noche (una mesa puede tener varios grupos).",
  DEF_TICKET,
  "Reservas y personas: las reservas de esa noche y las personas que apartaron. Llegaron: con entrada confirmada en puerta. Consumieron: su cuenta tuvo consumo. No llegaron: la noche ya terminó y no entraron. Por llegar: la noche sigue y aún no entran.",
  "Cobrado por método: cobros registrados en caja, sin anulados. Por cobrar = consumo total − cobrado.",
  "Comisiones: comisiones de RP por reserva (nacen al cuadrar la mesa; las de $0 por la cuota también cuentan) más pagos por día de asistencia, sin anuladas. Son las mismas de la nómina.",
  "Rendimiento por RP: solo reservas traídas por cada RP (origen RP). Consumo = consumo de las cuentas de esas reservas.",
  "Cuadre: el conteo físico que se guarda al cerrar la noche en caja. Diferencia = contado − cobrado (sobran si es positiva, faltan si es negativa). Sin cierre en caja no hay cuadre.",
  "Anulaciones: consumos y cobros anulados con motivo (no cuentan en consumo ni en cobrado) y mesas que se reabrieron.",
];

const FUENTE_NOCHE =
  "Fuente: AntroApp, cierre de la noche (caja por mesa, cobros, cuadre, anulaciones y comisiones) y rendimiento por RP de /grupo. Las cifras coinciden con la pantalla de cierre de la noche, /grupo, la nómina y los CSV. Montos en pesos mexicanos (MXN).";
const FUENTE_SEMANA =
  "Fuente: AntroApp, suma de los 7 cierres de noche (lunes a domingo: caja, cobros, cuadres, anulaciones y comisiones) y rendimiento por RP de /grupo. Las cifras coinciden con /grupo, la nómina de la semana y los CSV. Montos en pesos mexicanos (MXN).";

// ---------------------------------------------------------------------------
// Maquetación.
// ---------------------------------------------------------------------------

const MARGEN = 40;
const ANCHO_UTIL = ANCHO_HOJA - MARGEN * 2;
const LIMITE_INFERIOR = ALTO_HOJA - 64; // deja lugar al pie
const NEGRO: Color = [0.07, 0.07, 0.07];
const GRIS: Color = [0.4, 0.4, 0.4];
const GRIS_LINEA: Color = [0.82, 0.82, 0.82];
const FONDO_ENCABEZADO: Color = [0.94, 0.94, 0.93];
const AMBAR_FONDO: Color = [1, 0.96, 0.86];
const AMBAR_BORDE: Color = [0.8, 0.55, 0.05];

interface Columna {
  titulo: string;
  ancho: number;
  alinear?: Alineacion;
}

class Maquetador {
  readonly doc = new DocumentoPdf();
  y = MARGEN;

  private readonly continua: string;

  constructor(continua: string) {
    this.continua = continua;
  }

  private saltoSiFalta(alto: number) {
    if (this.y + alto <= LIMITE_INFERIOR) return false;
    this.doc.nuevaPagina();
    this.y = MARGEN;
    this.doc.texto(MARGEN, this.y + 8, recortarTexto(this.continua, ANCHO_UTIL - 60, "normal", 8), { tam: 8, color: GRIS });
    this.doc.texto(MARGEN + ANCHO_UTIL, this.y + 8, "(continúa)", { tam: 8, color: GRIS, alinear: "der" });
    this.y += 22;
    return true;
  }

  parrafo(t: string, estilo: { fuente?: Fuente; tam?: number; color?: Color; antes?: number; despues?: number; maxRenglones?: number } = {}) {
    const tam = estilo.tam ?? 9.5;
    const fuente = estilo.fuente ?? "normal";
    const interlinea = tam * 1.3;
    this.y += estilo.antes ?? 0;
    for (const renglon of partirTexto(t, ANCHO_UTIL, fuente, tam, estilo.maxRenglones ?? 12)) {
      this.saltoSiFalta(interlinea);
      this.y += interlinea;
      this.doc.texto(MARGEN, this.y - tam * 0.25, renglon, { fuente, tam, color: estilo.color ?? NEGRO });
    }
    this.y += estilo.despues ?? 0;
  }

  /** Si lo que sigue (de `alto` puntos) no cabe en esta hoja pero sí en una
   *  nueva, salta antes: una tabla corta no se parte en dos hojas. */
  mantenerJunto(alto: number) {
    if (alto <= LIMITE_INFERIOR - MARGEN - 22) this.saltoSiFalta(alto);
  }

  titulo(t: string) {
    this.saltoSiFalta(40);
    this.y += 16;
    this.doc.texto(MARGEN, this.y, t, { fuente: "negrita", tam: 11.5, color: NEGRO });
    this.y += 5;
    this.doc.linea(MARGEN, this.y, MARGEN + ANCHO_UTIL, this.y, 0.6, GRIS_LINEA);
    this.y += 4;
  }

  /** Aviso en recuadro ámbar (noche en curso, sin datos…). */
  aviso(t: string) {
    const tam = 9.5;
    const interlinea = tam * 1.3;
    const renglones = partirTexto(t, ANCHO_UTIL - 20, "normal", tam, 6);
    const alto = renglones.length * interlinea + 12;
    this.saltoSiFalta(alto + 8);
    this.y += 8;
    this.doc.rect(MARGEN, this.y, ANCHO_UTIL, alto, AMBAR_FONDO, AMBAR_BORDE);
    let yy = this.y + 6;
    for (const r of renglones) {
      yy += interlinea;
      this.doc.texto(MARGEN + 10, yy - tam * 0.3, r, { tam, color: NEGRO });
    }
    this.y += alto;
  }

  /** Pares etiqueta / valor en dos columnas de pares. */
  cifras(pares: { etiqueta: string; valor: string; detalle?: string }[]) {
    const anchoPar = ANCHO_UTIL / 2;
    for (let i = 0; i < pares.length; i += 2) {
      const fila = pares.slice(i, i + 2);
      const altos = fila.map((p) => (p.detalle ? partirTexto(p.detalle, anchoPar - 12, "normal", 8, 3).length : 0));
      const alto = 26 + Math.max(0, ...altos) * 10;
      this.saltoSiFalta(alto);
      fila.forEach((p, j) => {
        const x = MARGEN + j * anchoPar;
        this.doc.texto(x, this.y + 11, recortarTexto(p.etiqueta, anchoPar - 12, "normal", 8.5), { tam: 8.5, color: GRIS });
        this.doc.texto(x, this.y + 24, recortarTexto(p.valor, anchoPar - 12, "negrita", 12), { fuente: "negrita", tam: 12, color: NEGRO });
        if (p.detalle) {
          partirTexto(p.detalle, anchoPar - 12, "normal", 8, 3).forEach((r, k) => {
            this.doc.texto(x, this.y + 35 + k * 10, r, { tam: 8, color: GRIS });
          });
        }
      });
      this.y += alto + 4;
    }
  }

  /** Tabla con encabezado (se repite si salta de hoja). La 1.ª columna parte
   *  renglones (3 como máximo, luego "…"); las demás se recortan con "…". */
  tabla(columnas: Columna[], filas: { celdas: string[]; negrita?: boolean; nota?: string }[]) {
    const tam = 8.5;
    const interlinea = 10.5;
    const total = columnas.reduce((s, c) => s + c.ancho, 0);
    const escala = ANCHO_UTIL / total;
    const cols = columnas.map((c) => ({ ...c, ancho: c.ancho * escala }));
    const encabezado = () => {
      const alto = 18;
      this.doc.rect(MARGEN, this.y, ANCHO_UTIL, alto, FONDO_ENCABEZADO);
      let x = MARGEN;
      for (const c of cols) {
        const t = recortarTexto(c.titulo, c.ancho - 8, "negrita", 8);
        if (c.alinear === "der") this.doc.texto(x + c.ancho - 4, this.y + 12, t, { fuente: "negrita", tam: 8, alinear: "der" });
        else this.doc.texto(x + 4, this.y + 12, t, { fuente: "negrita", tam: 8 });
        x += c.ancho;
      }
      this.y += alto;
    };
    this.saltoSiFalta(18 + 20);
    this.y += 6;
    encabezado();
    for (const fila of filas) {
      const fuente: Fuente = fila.negrita ? "negrita" : "normal";
      const primera = partirTexto(fila.celdas[0] ?? "", cols[0].ancho - 8, fuente, tam, 3);
      const nota = fila.nota ? partirTexto(fila.nota, cols[0].ancho - 8, "normal", 7.5, 2) : [];
      const alto = 8 + primera.length * interlinea + nota.length * 9;
      if (this.saltoSiFalta(alto)) encabezado();
      // Orden de escritura = orden de lectura: el primer renglón de la 1.ª
      // columna, luego las demás celdas y al final los renglones partidos y
      // la nota. Así un lector de texto (o de pantalla) lee la fila completa.
      const yy = this.y + 4 + interlinea - 2.5;
      this.doc.texto(MARGEN + 4, yy, primera[0] ?? "", { fuente, tam });
      let x = MARGEN + cols[0].ancho;
      cols.slice(1).forEach((c, j) => {
        const t = recortarTexto(fila.celdas[j + 1] ?? "", c.ancho - 6, fuente, tam);
        if (c.alinear === "der") this.doc.texto(x + c.ancho - 4, yy, t, { fuente, tam, alinear: "der" });
        else this.doc.texto(x + 4, yy, t, { fuente, tam });
        x += c.ancho;
      });
      primera.slice(1).forEach((r, k) => this.doc.texto(MARGEN + 4, yy + (k + 1) * interlinea, r, { fuente, tam }));
      nota.forEach((r, k) => this.doc.texto(MARGEN + 4, this.y + 4 + primera.length * interlinea + (k + 1) * 9 - 2, r, { tam: 7.5, color: GRIS }));
      this.y += alto;
      this.doc.linea(MARGEN, this.y, MARGEN + ANCHO_UTIL, this.y, 0.4, GRIS_LINEA);
    }
  }

  /** Encabezado del reporte (primera hoja). */
  encabezado(tipo: string, club: string, periodo: string, generado: string, zona: string) {
    this.doc.texto(MARGEN, this.y + 10, "ANTROAPP", { fuente: "negrita", tam: 8, color: GRIS });
    this.doc.texto(MARGEN + ANCHO_UTIL, this.y + 10, tipo.toUpperCase(), { fuente: "negrita", tam: 8, color: GRIS, alinear: "der" });
    this.y += 16;
    for (const r of partirTexto(club, ANCHO_UTIL, "negrita", 20, 3)) {
      this.y += 24;
      this.doc.texto(MARGEN, this.y - 4, r, { fuente: "negrita", tam: 20, color: NEGRO });
    }
    this.parrafo(`${tipo} · ${periodo}`, { tam: 11.5, antes: 2 });
    this.parrafo(`Generado el ${generado} (hora del antro, ${zona})`, { tam: 8.5, color: GRIS, antes: 2 });
    this.y += 6;
    this.doc.linea(MARGEN, this.y, MARGEN + ANCHO_UTIL, this.y, 1, NEGRO);
    this.y += 2;
  }

  definiciones(lista: string[]) {
    this.titulo("Definiciones");
    for (const d of lista) this.parrafo(`• ${d}`, { tam: 8, color: GRIS, despues: 2 });
  }

  /** Pie de cada hoja: de dónde salen las cifras y "Página i de N". */
  pies(fuente: string) {
    const n = this.doc.numeroPaginas;
    const renglones = partirTexto(fuente, ANCHO_UTIL - 70, "normal", 7, 3);
    for (let i = 0; i < n; i++) {
      this.doc.irAPagina(i);
      const y0 = ALTO_HOJA - 50;
      this.doc.linea(MARGEN, y0, MARGEN + ANCHO_UTIL, y0, 0.5, GRIS_LINEA);
      renglones.slice(0, 3).forEach((r, k) => this.doc.texto(MARGEN, y0 + 11 + k * 9, r, { tam: 7, color: GRIS }));
      this.doc.texto(MARGEN + ANCHO_UTIL, y0 + 11, `Página ${i + 1} de ${n}`, { tam: 7, color: GRIS, alinear: "der" });
    }
  }
}

// Alto aproximado de un título con su tabla (renglones de una línea + notas).
const altoTabla = (filas: number, notas = 0) => 25 + 24 + filas * 18.5 + notas * 9;

const plural = (n: number, uno: string, varios: string) => `${entero(n)} ${n === 1 ? uno : varios}`;

function tablaRps(m: Maquetador, rps: { rp_nombre: string; rp_activo: boolean; reservas: number; entraron: number; consumieron: number; consumo_centavos: number; comisiones_centavos: number }[]) {
  // Una lista corta va entera en una hoja; una larga empieza aquí si caben unas filas.
  m.mantenerJunto(altoTabla(rps.length <= 8 ? Math.max(rps.length, 1) : 3));
  m.titulo("Rendimiento por RP");
  if (rps.length === 0) {
    m.parrafo("Ningún RP tuvo reservas ni comisiones en este periodo.", { tam: 9, color: GRIS, antes: 2 });
    return;
  }
  m.tabla(
    [
      { titulo: "RP", ancho: 170 },
      { titulo: "Reservas", ancho: 62, alinear: "der" },
      { titulo: "Llegaron", ancho: 62, alinear: "der" },
      { titulo: "Consumieron", ancho: 72, alinear: "der" },
      { titulo: "Consumo", ancho: 84, alinear: "der" },
      { titulo: "Comisión", ancho: 82, alinear: "der" },
    ],
    rps.map((r) => ({
      celdas: [
        r.rp_nombre + (r.rp_activo ? "" : " (dado de baja)"),
        entero(r.reservas),
        entero(r.entraron),
        entero(r.consumieron),
        pesos(r.consumo_centavos),
        pesos(r.comisiones_centavos),
      ],
    })),
  );
}

function tablaAnulaciones(m: Maquetador, filas: [string, string, string][], titulo = "Anulaciones") {
  m.mantenerJunto(altoTabla(filas.length));
  m.titulo(titulo);
  m.tabla(
    [
      { titulo: "Concepto", ancho: 260 },
      { titulo: "Número", ancho: 136, alinear: "der" },
      { titulo: "Monto", ancho: 136, alinear: "der" },
    ],
    filas.map((celdas) => ({ celdas })),
  );
}

// ---------------------------------------------------------------------------
// Reporte de la noche.
// ---------------------------------------------------------------------------

export function pdfReporteNoche(rep: ReporteNochePdf): Uint8Array {
  const club = rep.club.nombre || "Antro";
  const m = new Maquetador(`${club} · Reporte de la noche del ${fechaLarga(rep.fecha)}`);
  m.encabezado("Reporte de la noche", club, `Noche del ${fechaLarga(rep.fecha)}`, generadoTexto(rep.generado_local), rep.club.zona_horaria);

  const con = nocheConDatos(rep);
  if (rep.momento === "futura") {
    m.aviso("Esta noche todavía no empieza: solo se ven las reservas apartadas hasta ahora.");
  } else if (esParcial(rep)) {
    m.aviso("Noche en curso: las cifras son parciales y pueden cambiar hasta el corte de las 08:00 o hasta que el gerente cierre la caja.");
  } else if (rep.noche.estado === "abierta") {
    m.aviso("La caja de esta noche sigue abierta aunque ya pasó su corte: puede haber cobros, cuadres o comisiones pendientes.");
  }
  if (!con) {
    m.aviso("Sin movimientos: esta noche no tiene reservas, consumo, cobros ni comisiones registrados.");
    m.definiciones(DEFINICIONES_COMUNES);
    m.pies(FUENTE_NOCHE);
    return m.doc.generar({ titulo: `Reporte de la noche · ${club} · ${rep.fecha}`, asunto: "Reporte de la noche" });
  }

  const c = rep.consumo;
  const r = rep.reservas;
  const w = rep.walk_ins;
  m.titulo("Resumen");
  m.cifras([
    { etiqueta: "Consumo total en caja", valor: pesos(c.total_centavos), detalle: `Con reserva ${pesos(c.con_reserva_centavos)} · sin reserva ${pesos(c.sin_reserva_centavos)}` },
    { etiqueta: "Ticket promedio", valor: pesos(c.ticket_promedio_centavos), detalle: `Consumo ÷ ${plural(c.cuentas_con_consumo, "cuenta con consumo", "cuentas con consumo")}` },
    { etiqueta: "Cuentas", valor: entero(w.cuentas_total), detalle: `${plural(w.cuentas_reserva, "con reserva", "con reserva")} · ${plural(w.cuentas, "sin reserva (walk-in)", "sin reserva (walk-in)")} · ${plural(c.cuentas_con_consumo, "con consumo", "con consumo")}` },
    { etiqueta: "Mesas usadas", valor: `${entero(rep.mesas.mesas_usadas)} de ${entero(rep.mesas.mesas_antro)}`, detalle: `${plural(rep.mesas.grupos, "grupo de mesa", "grupos de mesa")} en la noche` },
    { etiqueta: "Reservas", valor: entero(r.reservas), detalle: `${plural(r.personas, "persona", "personas")} · llegaron ${entero(r.entraron)} · consumieron ${entero(r.consumieron)}` },
    {
      etiqueta: rep.termino ? "No llegaron" : "Por llegar",
      valor: entero(rep.termino ? r.no_llegaron : r.por_llegar),
      detalle: `Llegaron sin consumir ${entero(r.entraron_sin_consumo)} · walk-in: ${plural(w.personas, "persona", "personas")}`,
    },
  ]);

  const k = rep.cobros;
  const q0 = rep.cuadre;
  const contado = (c: number | null | undefined) => (c === null || c === undefined ? "—" : pesos(c));
  m.mantenerJunto(altoTabla(6) + 30);
  m.titulo("Cobros y cuadre");
  m.tabla(
    [
      { titulo: "Método", ancho: 260 },
      { titulo: "Cobrado", ancho: 136, alinear: "der" },
      { titulo: "Contado al cerrar", ancho: 136, alinear: "der" },
    ],
    [
      { celdas: ["Efectivo", pesos(k.efectivo_centavos), contado(q0?.contado_efectivo_centavos)] },
      { celdas: ["Tarjeta", pesos(k.tarjeta_centavos), contado(q0?.contado_tarjeta_centavos)] },
      { celdas: ["Otro", pesos(k.otro_centavos), contado(q0?.contado_otro_centavos)] },
      { celdas: [`Total cobrado (${plural(k.cobros, "cobro", "cobros")})`, pesos(k.total_centavos), ""], negrita: true },
      { celdas: ["Por cobrar (consumo − cobrado)", pesos(k.por_cobrar_centavos), ""] },
      { celdas: ["Diferencia del cuadre (contado − cobrado)", "", q0 ? textoDiferencia(q0.diferencia_centavos, pesos) : "—"], negrita: true },
    ],
  );
  if (q0) {
    m.parrafo(
      `Cuadre de ${q0.hecho_por_nombre ?? "Equipo"} · ${fechaHoraEnZona(q0.hecho_en, rep.club.zona_horaria)} · registrado en caja ${pesos(q0.registrado_centavos)} · saldo sin cobrar al cerrar ${pesos(q0.saldo_sin_cobrar_centavos)}.`,
      { tam: 8.5, color: GRIS, antes: 4, maxRenglones: 3 },
    );
    if (q0.notas) m.parrafo(`Notas del cuadre: ${q0.notas}`, { tam: 8.5, color: GRIS, antes: 2, maxRenglones: 4 });
  } else {
    m.parrafo("Sin cuadre general: la noche no se ha cerrado en caja (no hay conteo físico ni diferencia).", { tam: 8.5, color: GRIS, antes: 4 });
  }

  const q = rep.comisiones;
  m.mantenerJunto(altoTabla(3) + 24);
  m.titulo("Comisiones de RPs");
  m.tabla(
    [
      { titulo: "Concepto", ancho: 300 },
      { titulo: "Monto", ancho: 232, alinear: "der" },
    ],
    [
      { celdas: [`Comisiones por reserva (${entero(q.comisiones)})`, pesos(q.comision_centavos)] },
      { celdas: [`Pagos por día (${entero(q.pagos_dia)})`, pesos(q.pago_dia_centavos)] },
      { celdas: ["Total de comisiones", pesos(q.total_centavos)], negrita: true },
    ],
  );
  if (q.cuentas_rp_sin_cuadrar > 0) {
    m.parrafo(
      `${plural(q.cuentas_rp_sin_cuadrar, "cuenta de RP sigue", "cuentas de RP siguen")} sin cuadrar: su comisión nace al cuadrar la mesa y todavía no está en el total.`,
      { tam: 8.5, color: GRIS, antes: 4 },
    );
  }

  tablaRps(m, rep.rps);
  const a = rep.anulaciones;
  tablaAnulaciones(m, [
    [`Consumos anulados`, entero(a.consumos), pesos(a.consumos_centavos)],
    [`Cobros anulados`, entero(a.cobros), pesos(a.cobros_centavos)],
    ["Mesas reabiertas", entero(a.mesas_reabiertas), "—"],
  ]);
  m.definiciones(DEFINICIONES_COMUNES);
  m.pies(FUENTE_NOCHE);
  return m.doc.generar({ titulo: `Reporte de la noche · ${club} · ${rep.fecha}`, asunto: "Reporte de la noche" });
}

// ---------------------------------------------------------------------------
// Reporte de la semana.
// ---------------------------------------------------------------------------

function notaNoche(n: NocheSemana): string | undefined {
  if (n.momento === "futura") return "todavía no empieza";
  if (!n.termino) return "en curso (parcial)";
  if (n.estado_caja === "abierta") return "caja sin cerrar";
  if (n.estado_caja === "sin_caja") return "sin caja";
  return undefined;
}

export function pdfReporteSemana(rep: ReporteSemanaPdf): Uint8Array {
  const club = rep.club.nombre || "Antro";
  const periodo = `Semana ${rep.semana_iso.semana} de ${rep.semana_iso.anio}, ${rangoSemana(rep.lunes, rep.domingo)}`;
  const m = new Maquetador(`${club} · Reporte de la semana ${rep.semana_iso.semana} de ${rep.semana_iso.anio}`);
  m.encabezado("Reporte de la semana", club, periodo, generadoTexto(rep.generado_local), rep.club.zona_horaria);

  if (rep.parcial) {
    m.aviso(
      `Semana en curso: ${plural(rep.totales.noches_sin_terminar, "noche no ha terminado", "noches no han terminado")}. Las cifras son parciales y pueden cambiar.`,
    );
  }
  if (!semanaConDatos(rep)) {
    m.aviso("Sin movimientos: esta semana no tiene reservas, consumo, cobros ni comisiones registrados.");
    m.definiciones([...DEFINICIONES_COMUNES, DEF_TICKET_SEMANA]);
    m.pies(FUENTE_SEMANA);
    return m.doc.generar({ titulo: `Reporte de la semana · ${club} · ${rep.lunes}`, asunto: "Reporte de la semana" });
  }

  const t = rep.totales;
  m.titulo("Resumen de la semana");
  m.cifras([
    { etiqueta: "Consumo total en caja", valor: pesos(t.consumo_centavos), detalle: `${plural(t.noches_con_consumo, "noche con consumo", "noches con consumo")}` },
    { etiqueta: "Ticket promedio", valor: pesos(t.ticket_promedio_centavos), detalle: `Consumo ÷ ${plural(t.cuentas_con_consumo, "cuenta con consumo", "cuentas con consumo")}` },
    { etiqueta: "Cuentas", valor: entero(t.cuentas), detalle: `${plural(t.cuentas_walk_in, "sin reserva (walk-in)", "sin reserva (walk-in)")} · ${plural(t.cuentas_con_consumo, "con consumo", "con consumo")}` },
    { etiqueta: "Grupos de mesa", valor: entero(t.grupos), detalle: `Veces que se ocupó una mesa · el antro tiene ${plural(rep.mesas_antro, "mesa", "mesas")}` },
    { etiqueta: "Reservas", valor: entero(t.reservas), detalle: `${plural(t.personas, "persona", "personas")} · llegaron ${entero(t.entraron)} · consumieron ${entero(t.consumieron)}` },
    { etiqueta: "No llegaron", valor: entero(t.no_llegaron), detalle: `Por llegar ${entero(t.por_llegar)} · walk-in: ${plural(t.personas_walk_in, "persona", "personas")}` },
  ]);

  m.mantenerJunto(altoTabla(rep.noches.length + 1, rep.noches.filter((n) => notaNoche(n)).length));
  m.titulo("Noche por noche");
  m.tabla(
    [
      { titulo: "Noche", ancho: 86 },
      { titulo: "Reservas", ancho: 52, alinear: "der" },
      { titulo: "Llegaron", ancho: 52, alinear: "der" },
      { titulo: "Cuentas", ancho: 50, alinear: "der" },
      { titulo: "Consumo", ancho: 76, alinear: "der" },
      { titulo: "Ticket", ancho: 66, alinear: "der" },
      { titulo: "Cobrado", ancho: 76, alinear: "der" },
      { titulo: "Comisiones", ancho: 74, alinear: "der" },
    ],
    [
      ...rep.noches.map((n) => ({
        celdas: [
          fechaCorta(n.fecha),
          entero(n.reservas),
          entero(n.entraron),
          entero(n.cuentas),
          pesos(n.consumo_centavos),
          pesos(n.ticket_promedio_centavos),
          pesos(n.cobrado_centavos),
          pesos(n.comisiones_centavos),
        ],
        nota: notaNoche(n),
      })),
      {
        celdas: [
          "Semana",
          entero(t.reservas),
          entero(t.entraron),
          entero(t.cuentas),
          pesos(t.consumo_centavos),
          pesos(t.ticket_promedio_centavos),
          pesos(t.cobrado_centavos),
          pesos(t.comisiones_centavos),
        ],
        negrita: true,
      },
    ],
  );

  m.mantenerJunto(altoTabla(5));
  m.titulo("Cobrado por método");
  m.tabla(
    [
      { titulo: "Método", ancho: 300 },
      { titulo: "Monto", ancho: 232, alinear: "der" },
    ],
    [
      { celdas: ["Efectivo", pesos(t.efectivo_centavos)] },
      { celdas: ["Tarjeta", pesos(t.tarjeta_centavos)] },
      { celdas: ["Otro", pesos(t.otro_centavos)] },
      { celdas: ["Total cobrado", pesos(t.cobrado_centavos)], negrita: true },
      { celdas: ["Por cobrar (consumo − cobrado)", pesos(t.por_cobrar_centavos)] },
    ],
  );

  m.mantenerJunto(altoTabla(3) + 24);
  m.titulo("Comisiones de RPs");
  m.tabla(
    [
      { titulo: "Concepto", ancho: 300 },
      { titulo: "Monto", ancho: 232, alinear: "der" },
    ],
    [
      { celdas: ["Comisiones por reserva", pesos(t.comision_reserva_centavos)] },
      { celdas: ["Pagos por día", pesos(t.pago_dia_centavos)] },
      { celdas: ["Total de comisiones", pesos(t.comisiones_centavos)], negrita: true },
    ],
  );
  if (t.cuentas_rp_sin_cuadrar > 0) {
    m.parrafo(
      `${plural(t.cuentas_rp_sin_cuadrar, "cuenta de RP sigue", "cuentas de RP siguen")} sin cuadrar: su comisión nace al cuadrar la mesa y todavía no está en el total.`,
      { tam: 8.5, color: GRIS, antes: 4 },
    );
  }

  tablaRps(m, rep.rps);
  tablaAnulaciones(m, [
    ["Consumos anulados", entero(t.consumos_anulados), pesos(t.consumos_anulados_centavos)],
    ["Cobros anulados", entero(t.cobros_anulados), pesos(t.cobros_anulados_centavos)],
    ["Mesas reabiertas", entero(t.mesas_reabiertas), "—"],
    ["Noches cerradas con cuadre", `${entero(t.noches_con_cuadre)} de ${entero(rep.noches.length)}`, "—"],
    ["Diferencia de los cuadres (contado − cobrado)", "", t.noches_con_cuadre > 0 ? textoDiferencia(t.diferencia_centavos, pesos) : "—"],
  ], "Anulaciones y cuadres");
  m.definiciones([...DEFINICIONES_COMUNES, DEF_TICKET_SEMANA]);
  m.pies(FUENTE_SEMANA);
  return m.doc.generar({ titulo: `Reporte de la semana · ${club} · ${rep.lunes}`, asunto: "Reporte de la semana" });
}

/** Cómo terminó la entrega del PDF (para decir algo cierto en pantalla). */
export type EntregaPdf = "compartido" | "descargado" | "abierto" | "cancelado";

/** Tiempo antes de soltar el blob: el visor o la descarga pueden tardar en leerlo. */
const SOLTAR_BLOB_MS = 60_000;

/**
 * Entrega el PDF al usuario:
 * 1. En teléfono o app instalada (pantalla táctil o modo standalone), si el
 *    navegador comparte archivos (navigator.canShare({ files })), abre la
 *    hoja del sistema: «Guardar en Archivos», WhatsApp, correo… Es lo único
 *    confiable en iOS, sobre todo con la app instalada.
 * 2. Si no, descarga normal con <a download>.
 * 3. Si el navegador no sabe descargar, abre el PDF en otra pestaña.
 * Se llama directo desde el clic (navigator.share necesita el gesto).
 */
export async function entregarPdf(bytes: Uint8Array, nombreArchivo: string, titulo: string): Promise<EntregaPdf> {
  const copia = new Uint8Array(bytes.length);
  copia.set(bytes);
  const blob = new Blob([copia.buffer], { type: "application/pdf" });

  const movil =
    window.matchMedia?.("(pointer: coarse)").matches === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (movil && typeof navigator.share === "function" && typeof navigator.canShare === "function") {
    const archivo = new File([blob], nombreArchivo, { type: "application/pdf" });
    if (navigator.canShare({ files: [archivo] })) {
      try {
        await navigator.share({ files: [archivo], title: titulo });
        return "compartido";
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return "cancelado";
        // Otro error (permiso, tipo no admitido): se intenta la descarga.
      }
    }
  }

  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), SOLTAR_BLOB_MS);
  if ("download" in HTMLAnchorElement.prototype) {
    const a = document.createElement("a");
    a.href = url;
    a.download = nombreArchivo;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return "descargado";
  }
  if (!window.open(url, "_blank", "noopener")) window.location.assign(url);
  return "abierto";
}

/** Texto para la pantalla según cómo terminó la entrega. */
export function mensajeEntrega(e: EntregaPdf): string {
  switch (e) {
    case "compartido":
      return "Se generó el PDF.";
    case "descargado":
      return "Se generó el PDF. Si no lo ves, revisa tus descargas.";
    case "abierto":
      return "Se generó el PDF y se abrió en otra pestaña.";
    case "cancelado":
      return "Se generó el PDF, pero no se guardó ni se compartió.";
  }
}
