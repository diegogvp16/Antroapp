// Fechas de operación de AntroApp, SIEMPRE en hora de la Ciudad de México,
// sin importar la zona horaria del dispositivo. "Hoy", la semana (lunes a
// domingo) y el mes se calculan aquí y en ningún otro lado.
//
// Convención de día de semana: la de getDay() de JavaScript,
// domingo = 0, lunes = 1 ... sábado = 6 (igual que lib/turnos.ts).

export const ZONA_OPERACION = "America/Mexico_City";

export interface RangoFechas {
  // Instantes reales (UTC por dentro), listos para .toISOString().
  inicio: Date;
  fin: Date;
}

interface PartesFecha {
  anio: number;
  mes: number; // 1-12
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

const formateador = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONA_OPERACION,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// Fecha y hora "de reloj de pared" en la Ciudad de México para un instante.
function partesEnMexico(instante: Date): PartesFecha {
  const valores: Record<string, number> = {};
  for (const parte of formateador.formatToParts(instante)) {
    if (parte.type !== "literal") valores[parte.type] = Number(parte.value);
  }
  return {
    anio: valores.year,
    mes: valores.month,
    dia: valores.day,
    hora: valores.hour,
    minuto: valores.minute,
    segundo: valores.second,
  };
}

function aISO(anio: number, mes: number, dia: number): string {
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function desdeISO(fechaISO: string): { anio: number; mes: number; dia: number } {
  const [anio, mes, dia] = fechaISO.split("-").map(Number);
  return { anio, mes, dia };
}

// Instante en que el reloj de la Ciudad de México marca esa fecha y hora.
// Se calcula el desfase real con Intl (no se asume UTC-6 fijo) y se
// corrige una segunda vez por si el desfase cambia justo en ese momento.
function instanteEnMexico(
  fechaISO: string,
  hora: number,
  minuto: number,
  segundo: number,
  ms: number,
): Date {
  const { anio, mes, dia } = desdeISO(fechaISO);
  const deseado = Date.UTC(anio, mes - 1, dia, hora, minuto, segundo, ms);
  let instante = deseado;
  for (let i = 0; i < 2; i++) {
    const p = partesEnMexico(new Date(instante));
    const visto = Date.UTC(p.anio, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo, ms);
    instante += deseado - visto;
  }
  return new Date(instante);
}

// "2026-11-10" -> "2026-11-13". Aritmética de calendario pura, sin zona.
export function sumarDiasISO(fechaISO: string, dias: number): string {
  const { anio, mes, dia } = desdeISO(fechaISO);
  const d = new Date(Date.UTC(anio, mes - 1, dia + dias));
  return aISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// Día de la semana de una fecha de calendario (domingo = 0 ... sábado = 6).
export function diaSemanaISO(fechaISO: string): number {
  const { anio, mes, dia } = desdeISO(fechaISO);
  return new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay();
}

// Fecha de hoy en la Ciudad de México, como "YYYY-MM-DD".
export function hoyMexico(ahora: Date = new Date()): string {
  const p = partesEnMexico(ahora);
  return aISO(p.anio, p.mes, p.dia);
}

// Semana de operación: lunes 00:00:00.000 a domingo 23:59:59.999, hora de
// la Ciudad de México. Si hoy es domingo (0), el lunes quedó 6 días atrás;
// cualquier otro día, se retrocede (día - 1) días.
export function semanaMexico(ahora: Date = new Date()): RangoFechas {
  const hoy = hoyMexico(ahora);
  const dia = diaSemanaISO(hoy);
  const lunes = sumarDiasISO(hoy, dia === 0 ? -6 : 1 - dia);
  const domingo = sumarDiasISO(lunes, 6);
  return {
    inicio: instanteEnMexico(lunes, 0, 0, 0, 0),
    fin: instanteEnMexico(domingo, 23, 59, 59, 999),
  };
}

// Hora (Ciudad de México) en que termina la noche de operación. Lo que pasa
// entre la medianoche y las 07:59 sigue siendo de la noche anterior.
export const CORTE_NOCHE_HORA = 8;

// Noche de operación en curso, como "YYYY-MM-DD": hoy, salvo de 00:00 a
// 07:59, que todavía es la noche de ayer. México no tiene horario de verano
// desde 2022, así que restar 8 horas al instante equivale a restarlas al
// reloj de pared.
export function nocheOperativaMexico(ahora: Date = new Date()): string {
  return hoyMexico(new Date(ahora.getTime() - CORTE_NOCHE_HORA * 3_600_000));
}

// Zona más al oeste de México (Baja California). Su noche operativa nunca va
// adelante de la de otra zona del país: sirve para no dar por vencido antes
// de tiempo algo cuya zona no se conoce.
export const ZONA_MAS_TARDIA_MEXICO = "America/Tijuana";

// Noche de operación en curso para la zona horaria de un antro
// (clubs.zona_horaria), igual que la base (club_fecha_operacion y
// obtener_reserva_por_qr): el reloj de pared de esa zona menos 8 horas.
// Sin zona, o con una zona que el navegador no conoce, la de la Ciudad de
// México.
export function nocheOperativaEn(zona: string | null | undefined, ahora: Date = new Date()): string {
  if (!zona || zona === ZONA_OPERACION) return nocheOperativaMexico(ahora);
  try {
    const v: Record<string, number> = {};
    const partes = new Intl.DateTimeFormat("en-US", {
      timeZone: zona,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(ahora);
    for (const p of partes) if (p.type !== "literal") v[p.type] = Number(p.value);
    const reloj = Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute) - CORTE_NOCHE_HORA * 3_600_000;
    return new Date(reloj).toISOString().slice(0, 10);
  } catch {
    return nocheOperativaMexico(ahora);
  }
}

export interface RangoNoches {
  // Fechas de calendario "YYYY-MM-DD", inclusivas, para comparar contra
  // columnas de tipo date (por ejemplo reservations.fecha).
  desde: string;
  hasta: string;
}

// Semana de operación (lunes a domingo) que contiene la noche en curso.
// `semanasAtras` = 1 da la semana anterior.
export function semanaOperativa(
  ahora: Date = new Date(),
  semanasAtras = 0,
): RangoNoches {
  const noche = nocheOperativaMexico(ahora);
  const dia = diaSemanaISO(noche);
  const lunes = sumarDiasISO(noche, (dia === 0 ? -6 : 1 - dia) - 7 * semanasAtras);
  return { desde: lunes, hasta: sumarDiasISO(lunes, 6) };
}

// Mes de la noche en curso: del día 1 al último día, como fechas de
// calendario.
export function mesOperativo(ahora: Date = new Date()): RangoNoches {
  const { anio, mes } = desdeISO(nocheOperativaMexico(ahora));
  const siguiente = mes === 12 ? aISO(anio + 1, 1, 1) : aISO(anio, mes + 1, 1);
  return { desde: aISO(anio, mes, 1), hasta: sumarDiasISO(siguiente, -1) };
}

// Mes en curso: día 1 00:00:00.000 al último día 23:59:59.999, hora de la
// Ciudad de México.
export function mesMexico(ahora: Date = new Date()): RangoFechas {
  const p = partesEnMexico(ahora);
  const primero = aISO(p.anio, p.mes, 1);
  const ultimo = sumarDiasISO(
    p.mes === 12 ? aISO(p.anio + 1, 1, 1) : aISO(p.anio, p.mes + 1, 1),
    -1,
  );
  return {
    inicio: instanteEnMexico(primero, 0, 0, 0, 0),
    fin: instanteEnMexico(ultimo, 23, 59, 59, 999),
  };
}

const formatoNoche = new Intl.DateTimeFormat("es-MX", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
});

// "2026-11-25" -> "mié 25 nov". La fecha es de calendario, así que se
// formatea en UTC para que la zona del dispositivo no la mueva de día.
export function etiquetaNoche(fechaISO: string): string {
  const { anio, mes, dia } = desdeISO(fechaISO);
  const partes: Record<string, string> = {};
  for (const p of formatoNoche.formatToParts(new Date(Date.UTC(anio, mes - 1, dia)))) {
    partes[p.type] = p.value.replace(/\./g, "");
  }
  return `${partes.weekday} ${partes.day} ${partes.month}`;
}

// "lun 23 nov – dom 29 nov"
export function etiquetaRango(rango: RangoNoches): string {
  return `${etiquetaNoche(rango.desde)} – ${etiquetaNoche(rango.hasta)}`;
}

const formatoFechaLarga = new Intl.DateTimeFormat("es-MX", {
  timeZone: ZONA_OPERACION,
  day: "numeric",
  month: "long",
  year: "numeric",
});

// Instante (ISO o Date) -> "12 de noviembre de 2026", en hora de México.
export function formatearFechaLarga(instante: string | Date): string {
  return formatoFechaLarga.format(new Date(instante));
}
