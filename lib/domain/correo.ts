// Reglas del envío de correos de la app (B7). Puro: sin imports con "@/" ni
// "server-only", para que las pruebas lo carguen con Node. El único punto
// que lo usa en la app es lib/correo.ts (servidor).
//
// Modos (variable CORREO_MODO):
//   archivo  (por defecto) — no sale nada; queda en la bandeja
//                            (correos_salida) para revisarlo en /admin/correos.
//   enviar   — se manda con Resend y queda en la bandeja con su resultado.
//              SOLO en producción de verdad (VERCEL_ENV=production y la base
//              no es la de dev). En vista previa, dev o local se manda solo a
//              los correos de CORREO_LISTA_BLANCA; a los demás se archiva.
//   apagado  — no se manda ni se guarda nada.
// Un valor desconocido cuenta como "archivo" (lo seguro).
import type { SupabaseClient } from "@supabase/supabase-js";

export type ModoCorreo = "archivo" | "enviar" | "apagado";
export type EntornoCorreo = "production" | "preview" | "development" | "local";
export type EstadoCorreo = "archivado" | "enviado" | "fallido";

// Ref del proyecto de Supabase de desarrollo (no es secreto). Si la app
// habla con esta base, no es producción aunque VERCEL_ENV diga otra cosa.
export const REF_SUPABASE_DEV = "ygumrpckbtlngzspqdvo";

export const MAX_ASUNTO = 200;
export const MAX_CUERPO = 20_000;
const PLANTILLA = /^[a-z0-9_:.-]{1,80}$/;
const CORREO = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[^@\s,;<>"']+$/;

export interface ConfigCorreo {
  modo: ModoCorreo;
  entorno: EntornoCorreo;
  esProduccion: boolean;
  listaBlanca: string[];
  remitente: string | null;
  llave: string | null;
  avisos: string[];
}

type Env = Record<string, string | undefined>;

export function normalizarCorreo(texto: string | null | undefined): string | null {
  const c = (texto ?? "").trim().toLowerCase();
  return c.length <= 320 && CORREO.test(c) ? c : null;
}

export function leerConfigCorreo(env: Env): ConfigCorreo {
  const avisos: string[] = [];
  const crudo = (env.CORREO_MODO ?? "").trim().toLowerCase();
  let modo: ModoCorreo = "archivo";
  if (crudo === "archivo" || crudo === "enviar" || crudo === "apagado") modo = crudo;
  else if (crudo) avisos.push(`CORREO_MODO="${crudo.slice(0, 20)}" no se reconoce: se usa "archivo".`);

  const v = (env.VERCEL_ENV ?? "").trim();
  const entorno: EntornoCorreo = v === "production" || v === "preview" || v === "development" ? v : "local";
  const baseDev = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(REF_SUPABASE_DEV);
  if (entorno === "production" && baseDev) avisos.push("VERCEL_ENV dice producción pero la base es la de dev: se trata como no producción.");
  const esProduccion = entorno === "production" && !baseDev;

  const listaBlanca = [...new Set((env.CORREO_LISTA_BLANCA ?? "").split(/[\s,;]+/).map(normalizarCorreo).filter((c): c is string => !!c))];
  const remitente = (env.CORREO_DE ?? env.ALERTAS_DE ?? "").trim() || null;
  const llave = (env.RESEND_API_KEY ?? "").trim() || null;
  if (modo === "enviar" && (!llave || !remitente)) avisos.push("Modo enviar sin RESEND_API_KEY o sin CORREO_DE: todo se archiva.");
  return { modo, entorno, esProduccion, listaBlanca, remitente, llave, avisos };
}

export type Decision = { accion: "enviar" | "archivar" | "nada"; motivo: string | null };

// Qué se hace con un correo a `destinatario` (ya normalizado).
export function decidirEnvio(cfg: ConfigCorreo, destinatario: string): Decision {
  if (cfg.modo === "apagado") return { accion: "nada", motivo: "Modo apagado." };
  if (cfg.modo === "archivo") return { accion: "archivar", motivo: "Modo archivo: no se mandó." };
  if (!cfg.llave || !cfg.remitente) return { accion: "archivar", motivo: "Modo enviar sin llave o remitente: solo se archivó." };
  if (!cfg.esProduccion && !cfg.listaBlanca.includes(destinatario)) {
    return { accion: "archivar", motivo: `Fuera de producción (${cfg.entorno}) y el destinatario no está en la lista blanca: no se mandó.` };
  }
  return { accion: "enviar", motivo: cfg.esProduccion ? null : `Lista blanca (${cfg.entorno}).` };
}

export interface DatosCorreo {
  plantilla: string;
  para: string;
  asunto: string;
  texto: string;
  clubId?: string | null;
  // Textos que van en el correo pero NO se guardan en la bandeja (enlaces con
  // token, contraseñas temporales…): en la copia archivada salen "[oculto]".
  ocultar?: string[];
  // Si el correo NO sale (modo archivo, fuera de producción…), guardar en la
  // bandeja el texto completo, sin ocultar nada, para que el admin pueda
  // hacérselo llegar a mano (invitaciones; solo el admin lee la bandeja). En
  // cuanto se intenta mandar, lo de `ocultar` queda "[oculto]" como siempre.
  mostrarSiSeArchiva?: boolean;
}

export interface CorreoPreparado {
  plantilla: string;
  destinatario: string;
  asunto: string;
  cuerpo: string;
  cuerpoArchivado: string;
  clubId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function prepararCorreo(d: DatosCorreo): CorreoPreparado | { error: string } {
  const plantilla = (d.plantilla ?? "").trim().toLowerCase();
  if (!PLANTILLA.test(plantilla)) return { error: "plantilla" };
  const destinatario = normalizarCorreo(d.para);
  if (!destinatario) return { error: "destinatario" };
  // Una sola línea (sin saltos que inyecten cabeceras) y con tope.
  const asunto = (d.asunto ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, MAX_ASUNTO);
  if (!asunto) return { error: "asunto" };
  const cuerpo = (d.texto ?? "").slice(0, MAX_CUERPO);
  let cuerpoArchivado = cuerpo;
  for (const s of d.ocultar ?? []) if (s && s.length >= 4) cuerpoArchivado = cuerpoArchivado.split(s).join("[oculto]");
  const clubId = d.clubId && UUID.test(d.clubId) ? d.clubId : null;
  return { plantilla, destinatario, asunto, cuerpo, cuerpoArchivado, clubId };
}

export type ResultadoCorreo =
  | { estado: "enviado" | "archivado" | "fallido"; id: string | null }
  | { estado: "apagado" | "invalido"; id: null };

export interface DepsCorreo {
  svc: SupabaseClient;
  cfg: ConfigCorreo;
  fetch: typeof fetch;
  registrarError: (etiqueta: string, error: unknown) => void;
  timeoutMs?: number;
}

// Procesa un correo: decide, deja la fila en la bandeja y, si toca, lo manda.
// Nunca lanza: una falla al mandar no debe romper lo que lo provocó.
export async function procesarCorreo(deps: DepsCorreo, datos: DatosCorreo): Promise<ResultadoCorreo> {
  const { svc, cfg } = deps;
  try {
    const p = prepararCorreo(datos);
    if ("error" in p) {
      deps.registrarError("correo: datos inválidos", { code: p.error });
      return { estado: "invalido", id: null };
    }
    const decision = decidirEnvio(cfg, p.destinatario);
    if (decision.accion === "nada") return { estado: "apagado", id: null };

    const ins = await svc
      .from("correos_salida")
      .insert({
        plantilla: p.plantilla,
        destinatario: p.destinatario,
        asunto: p.asunto,
        cuerpo: decision.accion === "archivar" && datos.mostrarSiSeArchiva ? p.cuerpo : p.cuerpoArchivado,
        estado: "archivado",
        motivo: decision.accion === "enviar" ? "Enviando…" : decision.motivo,
        entorno: cfg.entorno,
        club_id: p.clubId,
      })
      .select("id")
      .single();
    const id: string | null = ins.data?.id ?? null;
    if (ins.error) {
      deps.registrarError("correo: bandeja", ins.error);
      // Sin bandeja, lo archivado se perdería: se reporta como falla. Lo que
      // sí se debía mandar, se manda de todos modos.
      if (decision.accion === "archivar") return { estado: "fallido", id: null };
    }
    if (decision.accion === "archivar") return { estado: "archivado", id };

    const actualizar = async (cambios: Record<string, unknown>) => {
      if (!id) return;
      const u = await svc.from("correos_salida").update(cambios).eq("id", id);
      if (u.error) deps.registrarError("correo: bandeja (resultado)", u.error);
    };
    const asunto = cfg.esProduccion ? p.asunto : `[Prueba] ${p.asunto}`.slice(0, MAX_ASUNTO);
    let r: Response;
    try {
      r = await deps.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.llave}`,
          "Content-Type": "application/json",
          ...(id ? { "Idempotency-Key": `correo-${id}` } : {}),
        },
        body: JSON.stringify({ from: cfg.remitente, to: [p.destinatario], subject: asunto, text: p.cuerpo }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      });
    } catch (e) {
      deps.registrarError("correo: envío", e);
      await actualizar({ estado: "fallido", motivo: "Sin respuesta del proveedor (puede haberse mandado)." });
      return { estado: "fallido", id };
    }
    if (!r.ok) {
      deps.registrarError("correo: Resend", { status: r.status });
      await actualizar({ estado: "fallido", motivo: `El proveedor respondió ${r.status}.` });
      return { estado: "fallido", id };
    }
    const cuerpo = (await r.json().catch(() => null)) as { id?: unknown } | null;
    await actualizar({
      estado: "enviado",
      motivo: decision.motivo,
      enviado_en: new Date().toISOString(),
      proveedor_id: typeof cuerpo?.id === "string" ? cuerpo.id.slice(0, 120) : null,
    });
    return { estado: "enviado", id };
  } catch (e) {
    deps.registrarError("correo: inesperado", e);
    return { estado: "fallido", id: null };
  }
}

// Resumen del modo SIN secretos, para mostrarlo al admin.
export function resumenModo(cfg: ConfigCorreo) {
  return {
    modo: cfg.modo,
    entorno: cfg.entorno,
    esProduccion: cfg.esProduccion,
    listaBlanca: cfg.listaBlanca.length,
    remitente: !!cfg.remitente,
    llave: !!cfg.llave,
    avisos: cfg.avisos,
  };
}
export type ResumenModoCorreo = ReturnType<typeof resumenModo>;
