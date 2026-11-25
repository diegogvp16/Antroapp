// Configuración por grupo (sql/post-junta-2/12-config-grupo.sql): claves,
// textos y descripción de cada valor. Sin React ni Supabase; no importa nada
// con "@/" ni otros módulos, para que las pruebas lo carguen con Node.
//
// El valor efectivo de cada antro vive en sus tablas de siempre y lo
// resuelve la base; aquí solo se describe lo que la base devuelve.

export const CLAVES_CONFIG = ["regla_comision", "visibilidad_rp", "modo_pago", "caja_permisos", "cover", "tolerancia"] as const;
export type ClaveConfig = (typeof CLAVES_CONFIG)[number];

export type Origen = "grupo" | "propio" | "sin_valor" | "sin_grupo";

export const TITULO_CLAVE: Record<ClaveConfig, string> = {
  regla_comision: "Regla de comisión",
  visibilidad_rp: "Qué ven los RPs",
  modo_pago: "Cómo se paga a los RPs",
  caja_permisos: "Permisos de caja por rol",
  cover: "Cover",
  tolerancia: "Hora límite de llegada",
};

// Cuándo vale un cambio del grupo en sus antros.
export const CUANDO_APLICA: Record<ClaveConfig, string> = {
  regla_comision: "Vale desde el lunes siguiente en cada antro; esta semana no cambia.",
  visibilidad_rp: "Al momento.",
  // Excepción explícita a «desde el lunes siguiente» (decisión pendiente de
  // Diego, docs/post-junta-2/b-alta.md): la pantalla pide confirmarla.
  modo_pago:
    "No espera al lunes: cambia al momento en todos los antros que siguen al grupo. La siguiente cuenta cuadrada o asistencia de esta semana ya usa el modo y las tarifas nuevas.",
  caja_permisos: "Al momento.",
  cover: "Al momento (es informativo para el cliente).",
  tolerancia: "Al momento.",
};

export const esClave = (x: unknown): x is ClaveConfig => typeof x === "string" && (CLAVES_CONFIG as readonly string[]).includes(x);

export function textoOrigen(o: Origen): string {
  switch (o) {
    case "grupo":
      return "Del grupo";
    case "propio":
      return "Propio";
    case "sin_valor":
      return "Propio (el grupo no lo define)";
    default:
      return "Propio";
  }
}

// ---------- Valores (misma forma que _config_normalizar) ----------
export type ValorRegla = { tipo: "porcentaje" | "fijo" | "cuota"; cuota: number; porcentaje_bp: number | null; monto_centavos: number | null };
export type ValorModo = { modo: "reserva" | "dia"; tarifas_dia: { posicion: number; monto_centavos: number }[] };
export type CeldaPermiso = { permiso: string; rol: "staff" | "gerente"; permitido: boolean };
export type ValorCover = { cover_modo: "oculto" | "monto" | "libre" | "consultar"; cover_monto_centavos: number | null };
export type ValorTolerancia = { tolerancia_hora: string | null };

export const pesos = (centavos: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: centavos % 100 === 0 ? 0 : 2 }).format(centavos / 100);

const VISIBILIDAD: Record<string, string> = {
  estado: "Solo el estado",
  estado_monto: "Estado y monto",
  estado_monto_botellas: "Estado, monto y botellas",
};
const COVER: Record<string, string> = {
  oculto: "No se muestra",
  libre: "Entrada libre",
  consultar: "Consultar en la puerta",
};
const PERMISO: Record<string, string> = {
  puerta: "recibir en la puerta",
  abrir_mesa: "abrir mesas",
  registrar_consumo: "registrar consumo",
  cobrar: "cobrar",
  cerrar_mesa: "cerrar mesas",
  reabrir_mesa: "reabrir mesas",
  anular: "anular",
  cuadrar_mesa: "cuadrar mesas",
  cerrar_noche: "cerrar la noche",
};

// Descripción corta de un valor. describirRegla viene de lib/domain/config-rp
// (se pasa para no importar otro módulo desde aquí).
export function describirValor(clave: ClaveConfig, valor: unknown, describirRegla: (r: ValorRegla) => string): string {
  if (valor == null) return clave === "regla_comision" ? "La de antes (sin regla nueva)" : "—";
  switch (clave) {
    case "regla_comision":
      return describirRegla(valor as ValorRegla);
    case "visibilidad_rp":
      return VISIBILIDAD[String(valor)] ?? String(valor);
    case "modo_pago": {
      const v = valor as ValorModo;
      if (v.modo === "reserva") return "Por reserva que consume";
      const t = (v.tarifas_dia ?? []).map((x) => pesos(x.monto_centavos)).join(" · ");
      return `Por día trabajado${t ? ` (${t})` : ""}`;
    }
    case "caja_permisos": {
      const lista = valor as CeldaPermiso[];
      if (!lista.length) return "Los de la plataforma";
      return lista
        .map((c) => `${c.rol === "staff" ? "Staff" : "Gerente"} ${c.permitido ? "sí" : "no"} ${PERMISO[c.permiso] ?? c.permiso}`)
        .join("; ");
    }
    case "cover": {
      const v = valor as ValorCover;
      return v.cover_modo === "monto" && v.cover_monto_centavos ? pesos(v.cover_monto_centavos) : (COVER[v.cover_modo] ?? v.cover_modo);
    }
    case "tolerancia": {
      const v = valor as ValorTolerancia;
      return v.tolerancia_hora ? `Hasta las ${v.tolerancia_hora}` : "Sin límite";
    }
  }
}

// ---------- Bitácora ----------
export type CambioGrupo = {
  hecho_en: string;
  clave: ClaveConfig | "todas";
  accion: "grupo_define" | "grupo_quita" | "club_sobrescribe" | "club_hereda" | "alta_hereda" | "alta_propia";
  antes: unknown;
  despues: unknown;
  bloqueado: boolean | null;
  vigente_desde: string | null;
  antros: number | null;
  antro: string | null;
  quien: string | null;
};

export function textoCambio(c: CambioGrupo, describirRegla: (r: ValorRegla) => string): string {
  const titulo = esClave(c.clave) ? TITULO_CLAVE[c.clave] : "Configuración";
  const antro = c.antro ?? "un antro";
  switch (c.accion) {
    case "grupo_define": {
      const valor = esClave(c.clave) ? describirValor(c.clave, c.despues, describirRegla) : "";
      const n = c.antros ?? 0;
      return `${titulo}: ${valor}${c.bloqueado ? " (bloqueado)" : ""} · ${n} ${n === 1 ? "antro lo sigue" : "antros lo siguen"}`;
    }
    case "grupo_quita":
      return `${titulo}: el grupo dejó de definirlo (cada antro conserva lo que tenía)`;
    case "club_sobrescribe":
      return `${antro} usa su propio valor en «${titulo}»`;
    case "club_hereda":
      return `${antro} volvió al del grupo en «${titulo}»`;
    case "alta_hereda":
      return `${antro} se dio de alta con la configuración del grupo`;
    case "alta_propia":
      return `${antro} se dio de alta con su propia configuración`;
  }
}
