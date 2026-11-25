// Panel de salud del admin (/admin/salud): tipos de lo que devuelven
// admin_salud() y admin_salud_reglas() (sql/post-junta-2/32-salud.sql) y
// reglas puras para mostrarlo. Sin Supabase, para probarlas sin red.

import { formatearCentavos } from "@/lib/domain/caja";

export interface ConteoLogin {
  total: number;
  fallidos: number;
  correos: number;
  ips: number;
}

export interface GrupoError {
  mensaje: string;
  ruta: string | null;
  veces: number;
  veces_24h: number;
  ultimo: string;
}

export interface SaludPlataforma {
  generado_en: string;
  umbrales: {
    ventana_minutos: number;
    max_fallos_correo_ip: number;
    max_fallos_correo: number;
    max_fallos_ip: number;
    degradado_max_fallos_correo_ip: number;
    degradado_max_fallos_ip: number;
    registros_por_ip_hora: number;
    degradado_registros_por_ip_hora: number;
    reservas_por_ip_hora: number;
    reservas_por_telefono_noche: number;
  };
  login: { hora: ConteoLogin; dia: ConteoLogin };
  bloqueos: {
    pares_correo_ip: number;
    correos: number;
    ips: number;
    pares_correo_ip_degradado: number;
    ips_degradado: number;
  };
  registro: {
    hora: { total: number; degradados: number };
    dia: { total: number; degradados: number; ips: number; ips_con_degradado: number; por_tipo: Record<string, number> };
    ips_al_limite_hora: number;
    top_ips_dia: { registros: number; degradados: number }[];
  };
  // null si la base todavía no tiene reserva_intentos (post-junta-2/72).
  reservas_sin_cuenta: { hora: number; dia: number; ips_al_limite_hora: number; telefonos_al_limite: number } | null;
  alertas: { tipo: string; ultima: string; veces_7d: number }[];
  errores: { dia: number; semana: number; grupos_total: number; grupos: GrupoError[] };
}

export interface ReglaDescrita {
  origen: "regla" | "anterior";
  tipo: "porcentaje" | "fijo" | "cuota";
  cuota: number;
  porcentaje_bp: number | null;
  monto_centavos: number | null;
  vigente_desde?: string;
}

export type CodigoAlertaRegla =
  | "legacy"
  | "sin_regla"
  | "dia_sin_tarifas"
  | "regla_id_inconsistente"
  | "noche_sin_cerrar"
  | "pendientes_viejas";

export interface EstadoReglasAntro {
  club_id: string;
  nombre: string;
  publicado: boolean;
  modo_pago: "reserva" | "dia";
  hoy: string;
  semana_desde: string;
  regla: ReglaDescrita | null;
  programada: Omit<ReglaDescrita, "origen"> | null;
  rps_activos: number;
  rps_con_regla_propia: number;
  rps_con_tarifa_dia_propia: number;
  tarifas_dia: number;
  comisiones_semana: number;
  comisiones_semana_en_cero: number;
  comision_semana_centavos: number;
  pagos_dia_semana: number;
  pagos_dia_semana_centavos: number;
  comisiones_inconsistentes: number;
  noches_sin_cerrar: number;
  pendientes_viejas: number;
  alertas: CodigoAlertaRegla[];
}

export type Tono = "ok" | "warn" | "err";

// "12.5 %" con un decimal; "—" si no hubo intentos.
export function porcentajeFallo(fallidos: number, total: number): string {
  if (!total) return "—";
  const p = Math.round((fallidos * 1000) / total) / 10;
  return `${p.toLocaleString("es-MX", { maximumFractionDigits: 1 })} %`;
}

// Tono del % de fallo: hasta 30 % es normal (la gente se equivoca de
// contraseña), arriba de 60 % con volumen suele ser alguien probando.
export function tonoFallo(fallidos: number, total: number): Tono {
  if (total < 10) return "ok";
  const p = fallidos / total;
  if (p > 0.6) return "err";
  if (p > 0.3) return "warn";
  return "ok";
}

export const ALERTA_REGLA: Record<CodigoAlertaRegla, { texto: string; tono: Tono }> = {
  legacy: { texto: "Sin regla nueva: sigue con la configuración anterior", tono: "warn" },
  sin_regla: { texto: "Comisión en $0: los RPs sin regla propia no ganan", tono: "err" },
  dia_sin_tarifas: { texto: "Pago por día sin tarifas", tono: "err" },
  regla_id_inconsistente: { texto: "Comisiones que no guardaron la regla vigente", tono: "err" },
  noche_sin_cerrar: { texto: "Noche de caja sin cerrar", tono: "warn" },
  pendientes_viejas: { texto: "Pagos pendientes de hace más de 4 semanas", tono: "warn" },
};

// Orden para la lista: primero los que tienen alertas rojas, luego ámbar,
// luego el resto; dentro, publicados primero y por nombre.
export function ordenarAntros(filas: EstadoReglasAntro[]): EstadoReglasAntro[] {
  const peso = (f: EstadoReglasAntro) =>
    f.alertas.some((a) => ALERTA_REGLA[a]?.tono === "err") ? 0 : f.alertas.some((a) => ALERTA_REGLA[a]?.tono === "warn") ? 1 : 2;
  return [...filas].sort(
    (a, b) => peso(a) - peso(b) || Number(b.publicado) - Number(a.publicado) || a.nombre.localeCompare(b.nombre, "es-MX"),
  );
}

// "$150 por reserva que consume", "10 % del consumo", "Desde la 4.ª de la
// semana, $200 cada una". Para pago por día no aplica (lo dicen las tarifas).
export function describirRegla(r: Omit<ReglaDescrita, "origen"> | null | undefined): string {
  if (!r) return "Sin regla";
  // La configuración anterior con desbloqueo sale como "cuota" y puede ser
  // en porcentaje (porcentaje_bp) en vez de monto fijo.
  const pago =
    r.porcentaje_bp != null
      ? `${(r.porcentaje_bp / 100).toLocaleString("es-MX", { maximumFractionDigits: 2 })} % del consumo`
      : formatearCentavos(r.monto_centavos ?? 0);
  if (r.tipo === "cuota") return `Las primeras ${r.cuota} de la semana no pagan; después, ${pago} cada una`;
  if (r.tipo === "porcentaje") return pago;
  return `${pago} por reserva que consume`;
}
