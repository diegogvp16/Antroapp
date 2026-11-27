// Revisión de RPs (antifraude): catálogo de reglas, sus definiciones y las
// estadísticas, en funciones puras. La base (sql/post-junta-3/30-antifraude-rps.sql)
// es la que detecta y manda; esto es lo mismo escrito en TypeScript para
// explicarlo en pantalla, validar los umbrales antes de mandarlos y probar
// las estadísticas (scripts/dev/probar-fraude-dominio.mjs). Si cambia una
// definición aquí, cambia también en fraude_detectar (y al revés).

// "Escaneos duplicados" se quitó: con la puerta de hoy un escaneo repetido no
// deja registro (ver docs/post-junta-3/fraude.md).
export const REGLAS_FRAUDE = ["cliente_repetido", "rafaga", "consumo_atipico"] as const;
export type ReglaFraude = (typeof REGLAS_FRAUDE)[number];

export const ESTADOS_ALERTA = ["revisar", "descartada", "confirmada"] as const;
export type EstadoAlerta = (typeof ESTADOS_ALERTA)[number];

export const esReglaFraude = (v: unknown): v is ReglaFraude =>
  typeof v === "string" && (REGLAS_FRAUDE as readonly string[]).includes(v);
export const esEstadoAlerta = (v: unknown): v is EstadoAlerta =>
  typeof v === "string" && (ESTADOS_ALERTA as readonly string[]).includes(v);

export interface LimiteParametro {
  etiqueta: string;
  defecto: number;
  min: number;
  max: number;
}

// Igual que fraude_catalogo() en la base (la prueba de la base compara ambos).
export const CATALOGO_FRAUDE: Record<ReglaFraude, Record<string, LimiteParametro>> = {
  cliente_repetido: {
    dias: { etiqueta: "Días hacia atrás", defecto: 30, min: 1, max: 180 },
    min_rps: { etiqueta: "RPs distintos", defecto: 2, min: 2, max: 10 },
  },
  rafaga: {
    min_reservas: { etiqueta: "Reservas", defecto: 8, min: 3, max: 100 },
    minutos: { etiqueta: "Minutos", defecto: 10, min: 1, max: 240 },
  },
  consumo_atipico: {
    pct_bajo: { etiqueta: "% de la mediana (bajo)", defecto: 20, min: 1, max: 90 },
    min_cuentas_bajas: { etiqueta: "Cuentas bajas por semana", defecto: 3, min: 1, max: 50 },
    factor_alto: { etiqueta: "Veces la mediana (alto)", defecto: 5, min: 2, max: 50 },
    muestra_minima: { etiqueta: "Cuentas mínimas para la mediana", defecto: 20, min: 5, max: 1000 },
    dias_referencia: { etiqueta: "Días de referencia", defecto: 60, min: 7, max: 365 },
  },
};

export const NOMBRE_REGLA: Record<ReglaFraude, string> = {
  cliente_repetido: "Cliente repetido entre RPs",
  rafaga: "Ráfaga de reservas",
  consumo_atipico: "Consumo atípico",
};

export const NOMBRE_ESTADO: Record<EstadoAlerta, string> = {
  revisar: "Por revisar",
  descartada: "Descartada",
  confirmada: "Confirmada",
};

/** Explicación en palabras de cada regla, con los umbrales del antro. */
export function explicarRegla(regla: ReglaFraude, p: Record<string, number>): string {
  switch (regla) {
    case "cliente_repetido":
      return `Un RP "llega" a un cliente (su teléfono, a 10 dígitos) que en los ${p.dias} días anteriores ya reservó con otros RPs, y con él suman ${p.min_rps} o más RPs distintos. Puede ser un cliente que cambió de RP, o un RP que se "roba" clientes de otro. Sale una sola alerta por cliente y RP que llega: si la descartas, no vuelve a salir aunque siga reservando con él; solo un RP nuevo hace otra.`;
    case "rafaga":
      return `Un RP creó ${p.min_reservas} o más reservas en ${p.minutos} minutos o menos. Puede ser una lista real que capturó de golpe, o reservas inventadas para inflar su número. Se agrupa por la noche en que las creó (corte a las 08:00).`;
    case "consumo_atipico":
      return `Se toma la mediana del consumo de todas las cuentas cuadradas del antro con consumo mayor a cero de los últimos ${p.dias_referencia} días (al domingo de cada semana), si hay al menos ${p.muestra_minima}. Bajo: un RP con ${p.min_cuentas_bajas} o más cuentas en la semana por debajo del ${p.pct_bajo} % de esa mediana (consumos mínimos que solo sirven para que la reserva cuente). Alto: una cuenta de RP de más de ${p.factor_alto} veces la mediana.`;
  }
}

// ---------------------------------------------------------------------------
// Estadísticas (iguales a la base)
// ---------------------------------------------------------------------------

/** Igual que fraude_tel10() y lista_negra_tel(): la MISMA clave de teléfono en
 *  toda la app (lib/domain/whatsapp.ts, claveTelefono): los 10 dígitos si es
 *  de México en una forma conocida (10; 52/521/044/045/01 + 10), si no todos
 *  los dígitos (8 a 15), si no null. Ya no se quita un "1" inicial: eso
 *  convertía un +1 212 555 1234 en un número de México. */
export function normalizarTelefonoMx(t: string | null | undefined): string | null {
  // Escrita aquí (no importada) porque las pruebas de dominio cargan este
  // archivo sin el alias "@/"; debe quedar igual a claveTelefono.
  const d = (t ?? "").replace(/\D/g, "");
  if (/^\d{10}$/.test(d)) return d;
  if (/^52\d{10}$/.test(d)) return d.slice(2);
  if (/^521\d{10}$/.test(d)) return d.slice(3);
  if (/^04[45]\d{10}$/.test(d)) return d.slice(3);
  if (/^01\d{10}$/.test(d)) return d.slice(2);
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** Igual que fraude_enmascarar_texto(): 10 o más dígitos seguidos (con espacios, ( ) . - entre ellos) → ******1234. */
export function enmascararTexto(texto: string): string {
  return texto.replace(/\+?[0-9](?:[ ().-]*[0-9]){9,}/g, (m) => "******" + m.replace(/[^0-9]/g, "").slice(-4));
}

/** "5512345678" -> "******5678". */
export function enmascararTelefono(tel10: string | null | undefined): string | null {
  if (!tel10 || tel10.length < 4) return null;
  return "******" + tel10.slice(-4);
}

/** Mediana (promedio de los dos de en medio si son pares). Vacío: null. */
export function mediana(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  const v = [...valores].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Redondeo como numeric de Postgres (mitad lejos del cero). */
export function redondear(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

export interface UmbralesConsumo {
  pct_bajo: number;
  factor_alto: number;
}

/** Umbral bajo en centavos: round(mediana × pct / 100). */
export const umbralBajo = (medianaCentavos: number, pct: number) => redondear((medianaCentavos * pct) / 100);
/** Umbral alto: mediana × factor (sin redondear; "más de"). */
export const umbralAlto = (medianaCentavos: number, factor: number) => medianaCentavos * factor;

export type ClaseConsumo = "sin_consumo" | "bajo" | "alto" | "normal";

export function clasificarConsumo(consumoCentavos: number, medianaCentavos: number, u: UmbralesConsumo): ClaseConsumo {
  if (consumoCentavos <= 0) return "sin_consumo";
  if (consumoCentavos < umbralBajo(medianaCentavos, u.pct_bajo)) return "bajo";
  if (consumoCentavos > umbralAlto(medianaCentavos, u.factor_alto)) return "alto";
  return "normal";
}

/** Lo más que cabe en un intervalo [t, t + minutos] (instantes en ms). */
export function maximoEnVentana(instantesMs: readonly number[], minutos: number): number {
  const v = [...instantesMs].sort((a, b) => a - b);
  const ancho = minutos * 60_000;
  let mejor = 0;
  let j = 0;
  for (let i = 0; i < v.length; i++) {
    if (j < i) j = i;
    while (j + 1 < v.length && v[j + 1] <= v[i] + ancho) j++;
    mejor = Math.max(mejor, j - i + 1);
  }
  return mejor;
}

/** Suma días a "YYYY-MM-DD" (fecha de calendario, sin zona). */
function sumarDias(fecha: string, dias: number): string {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** Lunes de la semana de una fecha "YYYY-MM-DD". */
export function lunesDe(fecha: string): string {
  const [a, m, d] = fecha.split("-").map(Number);
  const dia = new Date(Date.UTC(a, m - 1, d)).getUTCDay(); // domingo=0
  return sumarDias(fecha, -((dia + 6) % 7));
}

export interface ReservaTel {
  id: string;
  fecha: string; // noche "YYYY-MM-DD"
  creada: string; // created_at ISO (para ordenar dentro de la noche)
  rpId: string;
  telefono: string | null;
}

const diasEntre = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

/**
 * Cliente repetido (igual que fraude_detectar): devuelve, por
 * "teléfono:RP que llega", la noche de su llegada más reciente que dispara.
 * Llegada = reserva del RP X sin otra reserva de X para ese teléfono en los
 * `dias` anteriores. Dispara si, contando las reservas del teléfono con
 * noche en [su noche - dias, su noche] hasta ella, hay min_rps RPs distintos.
 */
export function alertasClienteRepetido(reservas: readonly ReservaTel[], dias: number, minRps: number): Map<string, string> {
  const porTel = new Map<string, ReservaTel[]>();
  for (const r of reservas) {
    const tel = normalizarTelefonoMx(r.telefono);
    if (tel) porTel.set(tel, [...(porTel.get(tel) ?? []), r]);
  }
  const orden = (a: ReservaTel, b: ReservaTel) =>
    a.fecha.localeCompare(b.fecha) || a.creada.localeCompare(b.creada) || a.id.localeCompare(b.id);
  const salida = new Map<string, string>();
  for (const [tel, lista] of porTel) {
    const l = [...lista].sort(orden);
    l.forEach((r, i) => {
      const previa = l.slice(0, i).filter((y) => y.rpId === r.rpId).pop();
      if (previa && diasEntre(previa.fecha, r.fecha) <= dias) return; // no es llegada
      const rps = new Set(l.slice(0, i + 1).filter((y) => diasEntre(y.fecha, r.fecha) <= dias).map((y) => y.rpId));
      if (rps.size >= minRps) salida.set(`${tel}:${r.rpId}`, r.fecha);
    });
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Validación de umbrales (la base vuelve a validar)
// ---------------------------------------------------------------------------

/** Mensaje de error del primer umbral inválido, o null si todos están bien. */
export function validarParametros(regla: ReglaFraude, parametros: Record<string, unknown>): string | null {
  const cat = CATALOGO_FRAUDE[regla];
  for (const [clave, valor] of Object.entries(parametros)) {
    const lim = cat[clave];
    if (!lim) return "Ese umbral no existe para esta regla.";
    if (typeof valor !== "number" || !Number.isInteger(valor)) return `«${lim.etiqueta}» debe ser un número entero.`;
    if (valor < lim.min || valor > lim.max) return `«${lim.etiqueta}» debe estar entre ${lim.min} y ${lim.max}.`;
  }
  return null;
}

/** Valores por defecto de una regla. */
export function parametrosPorDefecto(regla: ReglaFraude): Record<string, number> {
  return Object.fromEntries(Object.entries(CATALOGO_FRAUDE[regla]).map(([k, v]) => [k, v.defecto]));
}

/** Nota obligatoria al revisar: 5 a 1000 caracteres (sin espacios de más). */
export function validarNota(nota: string): string | null {
  const t = nota.trim();
  if (t.length < 5) return "Escribe una nota de al menos 5 caracteres.";
  if (t.length > 1000) return "La nota no puede pasar de 1000 caracteres.";
  return null;
}

/** Transiciones permitidas: revisar → descartada | confirmada; reabrir → revisar. */
export function transicionesDe(estado: EstadoAlerta): EstadoAlerta[] {
  return estado === "revisar" ? ["descartada", "confirmada"] : ["revisar"];
}
