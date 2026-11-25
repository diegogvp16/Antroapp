import "server-only";
import { configCorreo, enviarCorreo } from "@/lib/correo";
import { registrarError } from "@/lib/log";
import type { clienteServicio } from "@/lib/supabase/servicio";
import { enlaceInvitacion, textoCorreoInvitacion, urlPublica, type RolInvitable } from "@/lib/domain/invitaciones";
import type { EnlacePendiente, ResultadoImportarPersonal } from "@/lib/domain/importar-personal";

// Paso común de POST /api/equipo/importar y /api/equipo/importar/reemitir:
// con la service role, emite los tokens de las invitaciones del lote que no
// tienen (invitaciones_emitir_tokens_lote; la base guarda solo su hash) y
// manda un correo por persona por lib/correo.ts. Devuelve los enlaces de las
// personas cuyo correo NO salió (modo archivo, apagado, falla o sin tiempo),
// para entregarlos a mano. El club y el rol salen de la base, no del cuerpo.

// Después de esto ya no se empiezan correos nuevos (la función tiene 60 s).
const PRESUPUESTO_CORREOS_MS = 40_000;

export type ResultadoEnvioLote = Pick<ResultadoImportarPersonal, "correos" | "enlaces">;

export async function emitirYEnviarLote(d: {
  svc: ReturnType<typeof clienteServicio>;
  loteId: string;
  clubId: string;
  quienId: string;
  origen: string;
  inicio: number;
  // Orden de salida de los enlaces (por correo); sin él, por nombre.
  orden?: Map<string, number>;
}): Promise<ResultadoEnvioLote | null> {
  const { svc } = d;
  const tok = await svc.rpc("invitaciones_emitir_tokens_lote", { p_lote_id: d.loteId });
  if (tok.error || !Array.isArray(tok.data)) {
    registrarError("importar personal: tokens", tok.error);
    return null;
  }
  const tokens = new Map((tok.data as { id: string; token: string }[]).map((t) => [t.id, t.token]));
  const [{ data: invs }, { data: club }, { data: quien }] = await Promise.all([
    svc.from("invitaciones").select("id, nombre, correo, telefono, rol, expira_en").eq("lote_id", d.loteId).order("creada_en"),
    svc.from("clubs").select("nombre").eq("id", d.clubId).maybeSingle(),
    svc.from("profiles").select("nombre").eq("id", d.quienId).maybeSingle(),
  ]);
  const base = urlPublica(process.env, d.origen);
  const lista = (invs ?? []).filter((i) => tokens.has(i.id));
  const correos = { enviados: 0, archivados: 0, fallidos: 0, sinIntentar: 0 };
  const enlaces: EnlacePendiente[] = [];
  // Resend admite pocas peticiones por segundo: en modo "enviar" se va de
  // dos en dos; si solo se archiva, más rápido.
  const concurrencia = configCorreo().modo === "enviar" ? 2 : 8;

  for (let i = 0; i < lista.length; i += concurrencia) {
    const tanda = lista.slice(i, i + concurrencia);
    if (Date.now() - d.inicio > PRESUPUESTO_CORREOS_MS) {
      for (const inv of tanda) {
        correos.sinIntentar++;
        enlaces.push({ nombre: inv.nombre, correo: inv.correo, telefono: inv.telefono, enlace: enlaceInvitacion(base, tokens.get(inv.id)!) });
      }
      continue;
    }
    await Promise.all(
      tanda.map(async (inv) => {
        const token = tokens.get(inv.id)!;
        const enlace = enlaceInvitacion(base, token);
        const texto = textoCorreoInvitacion({
          nombre: inv.nombre,
          rol: inv.rol as RolInvitable,
          club: club?.nombre ?? "tu antro",
          invita: quien?.nombre ?? null,
          enlace,
          expiraEn: inv.expira_en,
        });
        const envio = await enviarCorreo(svc, {
          plantilla: "invitacion:lote",
          para: inv.correo,
          asunto: texto.asunto,
          texto: texto.texto,
          clubId: d.clubId,
          ocultar: [enlace, token],
          mostrarSiSeArchiva: true,
        });
        if (envio.estado === "enviado") correos.enviados++;
        else {
          if (envio.estado === "archivado") correos.archivados++;
          else correos.fallidos++;
          enlaces.push({ nombre: inv.nombre, correo: inv.correo, telefono: inv.telefono, enlace });
        }
      }),
    );
  }

  const orden = d.orden;
  if (orden) enlaces.sort((a, b) => (orden.get(a.correo) ?? 0) - (orden.get(b.correo) ?? 0));
  else enlaces.sort((a, b) => a.nombre.localeCompare(b.nombre, "es-MX"));
  return { correos, enlaces };
}
