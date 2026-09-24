// Lógica compartida de turnos de RP. Hay dos tipos de turno y los tres
// lugares que consultan `rp_schedule` (panel de staff, escaneo de asistencia
// y panel del RP) tienen que interpretarlos igual:
//
//   * Fecha suelta (es_fijo false/null): vale solo para ese día exacto.
//   * Turno fijo   (es_fijo true): vale todas las semanas, en los días de
//     `dias_semana`, a partir de `fecha_inicio`. Es una sola fila, sin
//     fecha de fin.
//
// Convención de día de semana: la de getDay() de JavaScript,
// domingo = 0, lunes = 1 ... sábado = 6. Es la que ya usaban getWeekRange()
// y los botones del formulario, así que se conserva para no tener que
// traducir entre lo guardado y lo comparado.

export interface TurnoRow {
  id: string;
  fecha: string;
  es_fijo: boolean | null;
  dias_semana: number[] | null;
  fecha_inicio: string | null;
}

export const DIAS_SEMANA = [
  { value: 1, corto: "L", nombre: "Lun" },
  { value: 2, corto: "M", nombre: "Mar" },
  { value: 3, corto: "M", nombre: "Mié" },
  { value: 4, corto: "J", nombre: "Jue" },
  { value: 5, corto: "V", nombre: "Vie" },
  { value: 6, corto: "S", nombre: "Sáb" },
  { value: 0, corto: "D", nombre: "Dom" },
];

// "2026-09-25" -> getDay() de ese día en hora local. Se construye con
// T00:00:00 para que el navegador lo lea como fecha local y no como UTC
// (que correría el día hacia atrás en México).
export function diaSemanaDeISO(fechaISO: string): number {
  return new Date(`${fechaISO}T00:00:00`).getDay();
}

export function esTurnoFijo(turno: TurnoRow): boolean {
  return turno.es_fijo === true;
}

// ¿Este turno cubre la fecha indicada?
export function turnoAplicaEnFecha(turno: TurnoRow, fechaISO: string): boolean {
  if (!esTurnoFijo(turno)) {
    return turno.fecha === fechaISO;
  }
  if (!turno.dias_semana || turno.dias_semana.length === 0) {
    return false;
  }
  // Un turno fijo no aplica antes de su fecha de inicio.
  if (turno.fecha_inicio && fechaISO < turno.fecha_inicio) {
    return false;
  }
  return turno.dias_semana.includes(diaSemanaDeISO(fechaISO));
}

// "Vie y Sáb" / "Lun, Mié y Vie" — en el orden de la semana, no en el que
// se hayan ido picando los botones.
export function formatearDias(dias: number[]): string {
  const nombres = DIAS_SEMANA.filter((d) => dias.includes(d.value)).map(
    (d) => d.nombre,
  );
  if (nombres.length === 0) return "";
  if (nombres.length === 1) return nombres[0];
  return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
}

export function formatearFechaCorta(fechaISO: string): string {
  const [a, m, d] = fechaISO.split("-");
  return `${d}/${m}/${a}`;
}

// "Fijo: Vie y Sáb desde 25/09/2026"
export function describirTurno(turno: TurnoRow): string {
  if (!esTurnoFijo(turno)) {
    return formatearFechaCorta(turno.fecha);
  }
  const dias = formatearDias(turno.dias_semana ?? []);
  const desde = formatearFechaCorta(turno.fecha_inicio ?? turno.fecha);
  return `Fijo: ${dias} desde ${desde}`;
}
