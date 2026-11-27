"use client";

// Revisión de RPs (antifraude): llamadas a la base. Todo lo autoriza y lo
// valida la base (sql/post-junta-3/30-antifraude-rps.sql); aquí solo se
// pide y se tipa. Detrás de la bandera por antro 'antifraude'.
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import type { EstadoAlerta, LimiteParametro, ReglaFraude } from "@/lib/domain/fraude";

export interface AntroRevision {
  club_id: string;
  nombre: string;
  zona_horaria: string;
  activa: boolean; // bandera 'antifraude' del antro
}

export interface AlertaLista {
  id: string;
  regla: ReglaFraude;
  estado: EstadoAlerta;
  ventana_inicio: string;
  ventana_fin: string;
  rp_id: string | null;
  rp_nombre: string | null;
  rp_nombres: string[];
  resumen: string;
  creada_en: string;
  actualizada_en: string;
  ya_no_aplica_en: string | null; // "Por revisar" que en una búsqueda posterior ya no se cumplió
  revisada_en: string | null;
  revisada_por_nombre: string | null;
  total: number; // total de alertas con esos filtros (para "mostrando X de N")
}

export interface CambioAlerta {
  de: EstadoAlerta;
  a: EstadoAlerta;
  nota: string; // ya enmascarada por la base
  resumen: string; // lo que decía la alerta al decidir
  evidencia: Record<string, unknown>; // la evidencia con la que se decidió
  hecho_por_nombre: string | null;
  hecho_en: string;
}

export interface AlertaDetalle extends Omit<AlertaLista, "rp_nombres" | "total"> {
  evidencia: Record<string, unknown>;
  cambios: CambioAlerta[];
}

export interface ReglaConfig {
  regla: ReglaFraude;
  activa: boolean;
  parametros: Record<string, number>;
  limites: Record<string, LimiteParametro>;
  propia: boolean;
  cambiado_en: string | null;
  cambiado_por_nombre: string | null;
}

export interface CambioRegla {
  id: number;
  regla: ReglaFraude;
  antes: { activa: boolean; parametros: Record<string, number> } | null;
  despues: { activa: boolean; parametros: Record<string, number> };
  hecho_por_nombre: string | null;
  hecho_en: string;
}

export interface ResumenDeteccion {
  desde: string;
  hasta: string;
  telefonos: { ilegibles: number; sin_telefono: number };
  reglas: Record<
    ReglaFraude,
    {
      activa: boolean;
      detectadas?: number;
      nuevas?: number;
      actualizadas?: number;
      ya_no_aplican?: number;
      semanas_sin_muestra?: { semana: string; muestra: number }[];
    }
  >;
}

export type Resultado<T> = { ok: true; datos: T } | { ok: false; mensaje: string };

async function llamar<T>(fn: string, args: Record<string, unknown> | undefined, generico: string): Promise<Resultado<T>> {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) return { ok: false, mensaje: mensajeParaUsuario(error, generico) };
  return { ok: true, datos: data as T };
}

export const misAntrosRevision = () =>
  llamar<AntroRevision[]>("fraude_mis_antros", undefined, "No pudimos cargar tus antros. Intenta de nuevo.");

export const detectarAlertas = (clubId: string, desde: string, hasta: string) =>
  llamar<ResumenDeteccion>("fraude_detectar", { p_club_id: clubId, p_desde: desde, p_hasta: hasta }, "No pudimos buscar alertas. Intenta de nuevo.");

export interface UltimaDeteccion {
  hecho_en: string;
  hecho_por_nombre: string | null;
  desde: string;
  hasta: string;
  resumen: ResumenDeteccion;
  siguiente_en: string;
}

export const ultimaDeteccion = (clubId: string) =>
  llamar<UltimaDeteccion | null>("fraude_ultima_deteccion", { p_club_id: clubId }, "No pudimos cargar la última búsqueda.");

export const POR_PAGINA = 50;

export const listarAlertas = (
  clubId: string,
  f: { estado: EstadoAlerta | null; regla: ReglaFraude | null; rpId: string | null; desde: string | null; hasta: string | null },
  desplazamiento = 0,
) =>
  llamar<AlertaLista[]>(
    "fraude_alertas_listar",
    {
      p_club_id: clubId,
      p_estado: f.estado,
      p_regla: f.regla,
      p_rp_id: f.rpId,
      p_desde: f.desde,
      p_hasta: f.hasta,
      p_limite: POR_PAGINA,
      p_desplazamiento: desplazamiento,
    },
    "No pudimos cargar las alertas. Intenta de nuevo.",
  );

export const rpsDeAlertas = (clubId: string) =>
  llamar<{ rp_id: string; nombre: string }[]>("fraude_alertas_rps", { p_club_id: clubId }, "No pudimos cargar los RPs.");

export const detalleAlerta = (alertaId: string) =>
  llamar<AlertaDetalle>("fraude_alerta_detalle", { p_alerta_id: alertaId }, "No pudimos abrir la alerta. Intenta de nuevo.");

export const cambiarAlerta = (alertaId: string, estado: EstadoAlerta, nota: string) =>
  llamar<null>("fraude_alerta_cambiar", { p_alerta_id: alertaId, p_estado: estado, p_nota: nota }, "No se guardó el cambio. Intenta de nuevo.");

export const leerReglas = (clubId: string) =>
  llamar<ReglaConfig[]>("fraude_reglas_leer", { p_club_id: clubId }, "No pudimos cargar las reglas. Intenta de nuevo.");

export const guardarRegla = (clubId: string, regla: ReglaFraude, activa: boolean, parametros: Record<string, number>) =>
  llamar<null>("fraude_regla_guardar", { p_club_id: clubId, p_regla: regla, p_activa: activa, p_parametros: parametros }, "No se guardó la regla. Intenta de nuevo.");

export const leerCambiosReglas = (clubId: string) =>
  llamar<CambioRegla[]>("fraude_reglas_cambios_leer", { p_club_id: clubId, p_limite: 30 }, "No pudimos cargar los cambios.");
