"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { etiquetaNoche } from "@/lib/fechas";
import { describirRegla } from "@/lib/domain/config-rp";
import {
  CLAVES_CONFIG,
  CUANDO_APLICA,
  TITULO_CLAVE,
  describirValor,
  textoCambio,
  textoOrigen,
  type CambioGrupo,
  type ClaveConfig,
  type Origen,
} from "@/lib/domain/config-grupo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useEditores } from "./editores-config";

// Configuración del grupo (dueño del grupo y admin): valores por defecto que
// los antros del grupo heredan mientras no los sobrescriban. Todo lo
// autoriza, valida y aplica la base (grupo_config_* y club_config_heredar,
// sql/post-junta-2/12-config-grupo.sql).

type ValorGrupo = { valor: unknown; bloqueado: boolean; actualizado_en: string; quien: string | null };
type Antro = { club_id: string; nombre: string; ciudad: string | null; origen: Record<ClaveConfig, Origen> };
type Datos = {
  grupo: { id: string; nombre: string };
  siguiente_lunes: string;
  claves: Partial<Record<ClaveConfig, ValorGrupo>>;
  antros: Antro[];
  historial: CambioGrupo[];
};
type Resultado = { siguen: number; cambiaron: number; propios: number; vigente_desde: string | null };

const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const descr = (r: Parameters<typeof describirRegla>[0]) => describirRegla(r);

export function ConfigGrupo({ grupoId }: { grupoId: string }) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const { data, error: e } = await createClient().rpc("grupo_config_actual", { p_grupo: grupoId });
    if (e) {
      setError(mensajeParaUsuario(e, "No pudimos cargar la configuración del grupo."));
      return;
    }
    setError(null);
    setDatos(data as Datos);
  }, [grupoId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  if (error && !datos) {
    return (
      <Card size="sm">
        <CardContent className="flex flex-col gap-2 px-4">
          <p role="alert" className="text-sm break-words text-status-err">
            {error}
          </p>
          <Button type="button" variant="outline" className="h-10 w-fit" onClick={cargar}>
            Reintentar
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!datos) return <p className="text-sm text-muted-foreground">Cargando la configuración del grupo…</p>;
  return <Contenido key={grupoId} datos={datos} recargar={cargar} />;
}

// «3 antros» / «1 antro» / «ningún antro»: los que siguen al grupo en esa
// clave (con bloqueo, todos).
function antrosQueSiguen(datos: Datos, k: ClaveConfig, bloqueado: boolean): string {
  const n = bloqueado ? datos.antros.length : datos.antros.filter((a) => (a.origen?.[k] ?? "sin_valor") !== "propio").length;
  return n === 0 ? "ningún antro (hoy)." : n === 1 ? "1 antro." : `${n} antros.`;
}

function Contenido({ datos, recargar }: { datos: Datos; recargar: () => Promise<void> }) {
  const valores = Object.fromEntries(Object.entries(datos.claves).map(([k, v]) => [k, v?.valor])) as Partial<Record<ClaveConfig, unknown>>;
  const editores = useEditores(`grupo-${datos.grupo.id}`, valores);
  const [bloqueos, setBloqueos] = useState<Record<ClaveConfig, boolean>>(
    () => Object.fromEntries(CLAVES_CONFIG.map((k) => [k, datos.claves[k]?.bloqueado ?? false])) as Record<ClaveConfig, boolean>,
  );
  const [guardando, setGuardando] = useState<string | null>(null);
  const [mensajes, setMensajes] = useState<Partial<Record<ClaveConfig, { tipo: "ok" | "err"; texto: string }>>>({});
  const [avisoAntros, setAvisoAntros] = useState<{ tipo: "ok" | "err"; texto: string } | null>(null);
  // El modo de pago cambia dinero de esta semana al momento: se confirma antes.
  const [confirmaModo, setConfirmaModo] = useState(false);

  const mensaje = (k: ClaveConfig, tipo: "ok" | "err", texto: string) => setMensajes((m) => ({ ...m, [k]: { tipo, texto } }));

  async function guardar(k: ClaveConfig) {
    const l = editores[k].leer();
    if ("error" in l) return mensaje(k, "err", l.error);
    if (k === "modo_pago" && !confirmaModo) return mensaje(k, "err", "Confirma que el cambio se aplica al momento.");
    setGuardando(k);
    const { data, error } = await createClient().rpc("grupo_config_cambiar", {
      p_grupo: datos.grupo.id,
      p_clave: k,
      p_valor: l.valor,
      p_bloqueado: bloqueos[k],
    });
    setGuardando(null);
    if (error) return mensaje(k, "err", mensajeParaUsuario(error, "No se pudo guardar. Intenta de nuevo."));
    const r = data as Resultado;
    const desde = k === "regla_comision" && r.vigente_desde ? ` Empieza el ${etiquetaNoche(r.vigente_desde)}; esta semana no cambia.` : "";
    const propios = r.propios > 0 && !bloqueos[k] ? ` ${r.propios} ${r.propios === 1 ? "antro tiene" : "antros tienen"} su propio valor y no cambia${r.propios === 1 ? "" : "n"}.` : "";
    mensaje(k, "ok", `Guardado. ${r.siguen} ${r.siguen === 1 ? "antro lo sigue" : "antros lo siguen"}.${desde}${propios}`);
    if (k === "modo_pago") setConfirmaModo(false);
    await recargar();
  }

  async function quitar(k: ClaveConfig) {
    setGuardando(k);
    const { error } = await createClient().rpc("grupo_config_quitar", { p_grupo: datos.grupo.id, p_clave: k });
    setGuardando(null);
    if (error) return mensaje(k, "err", mensajeParaUsuario(error, "No se pudo quitar. Intenta de nuevo."));
    mensaje(k, "ok", "El grupo ya no lo define. Cada antro conserva lo que tenía.");
    await recargar();
  }

  async function heredar(club: Antro, k: ClaveConfig) {
    setGuardando(`${club.club_id}-${k}`);
    setAvisoAntros(null);
    const { data, error } = await createClient().rpc("club_config_heredar", { p_club: club.club_id, p_clave: k });
    setGuardando(null);
    if (error) return setAvisoAntros({ tipo: "err", texto: mensajeParaUsuario(error, "No se pudo cambiar. Intenta de nuevo.") });
    const desde = (data as { vigente_desde?: string | null })?.vigente_desde;
    setAvisoAntros({ tipo: "ok", texto: `${club.nombre} ya sigue al grupo en «${TITULO_CLAVE[k]}».${desde ? ` Empieza el ${etiquetaNoche(desde)}.` : ""}` });
    await recargar();
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Lo que definas aquí lo toman los antros del grupo que no tengan su propio valor. Si un antro lo cambia en su panel, queda «propio» y el grupo ya
        no lo pisa (hasta que vuelva al del grupo). Con «bloqueado», ningún antro lo puede cambiar.
      </p>

      {CLAVES_CONFIG.map((k) => {
        const g = datos.claves[k];
        const m = mensajes[k];
        const ocupado = guardando !== null;
        return (
          <Card key={k}>
            <CardContent className="flex flex-col gap-3 px-5 py-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">{TITULO_CLAVE[k]}</h2>
                {g ? <Badge variant="ok">Definido por el grupo</Badge> : <Badge variant="neutral">Sin definir</Badge>}
                {g?.bloqueado && <Badge variant="warn">Bloqueado</Badge>}
              </div>
              <p className="text-sm break-words">
                {g ? describirValor(k, g.valor, descr) : "Cada antro usa lo suyo."}
                {g && (
                  <span className="block text-xs text-muted-foreground">
                    {g.quien ?? "—"} · {fechaHora.format(new Date(g.actualizado_en))}
                  </span>
                )}
              </p>
              <details className="rounded-lg border border-border">
                <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">{g ? "Cambiar" : "Definir para el grupo"}</summary>
                <div className="flex flex-col gap-3 border-t border-border p-3">
                  {editores[k].ui}
                  <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
                    <input type="checkbox" className="size-5" checked={bloqueos[k]} onChange={(e) => setBloqueos({ ...bloqueos, [k]: e.target.checked })} />
                    Bloquear: ningún antro lo puede cambiar (también se aplica a los que tienen el suyo)
                  </label>
                  <p className={k === "modo_pago" ? "text-sm break-words text-status-warn" : "text-xs text-muted-foreground"}>{CUANDO_APLICA[k]}</p>
                  {k === "modo_pago" && (
                    <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
                      <input type="checkbox" className="size-5" checked={confirmaModo} onChange={(e) => setConfirmaModo(e.target.checked)} />
                      Entiendo que cambia al momento en {antrosQueSiguen(datos, k, bloqueos[k])}
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" className="h-10" disabled={ocupado || (k === "modo_pago" && !confirmaModo)} onClick={() => guardar(k)}>
                      {guardando === k ? "Guardando…" : k === "regla_comision" ? `Programar desde el ${etiquetaNoche(datos.siguiente_lunes)}` : "Guardar para el grupo"}
                    </Button>
                    {g && (
                      <Button type="button" variant="outline" className="h-10" disabled={ocupado} onClick={() => quitar(k)}>
                        Dejar de definirlo
                      </Button>
                    )}
                  </div>
                </div>
              </details>
              {m && (
                <p role={m.tipo === "err" ? "alert" : "status"} className={`text-sm break-words ${m.tipo === "err" ? "text-status-err" : "text-status-ok"}`}>
                  {m.texto}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Antros del grupo</h2>
        {avisoAntros && (
          <p role={avisoAntros.tipo === "err" ? "alert" : "status"} className={`text-sm break-words ${avisoAntros.tipo === "err" ? "text-status-err" : "text-status-ok"}`}>
            {avisoAntros.texto}
          </p>
        )}
        {datos.antros.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Este grupo todavía no tiene antros.</p>
        ) : (
          datos.antros.map((a) => (
            <Card key={a.club_id} size="sm">
              <CardContent className="flex flex-col gap-2 px-4">
                <h3 className="text-sm font-semibold break-words">
                  {a.nombre}
                  {a.ciudad && <span className="font-normal text-muted-foreground"> · {a.ciudad}</span>}
                </h3>
                <ul className="flex flex-col divide-y divide-border">
                  {CLAVES_CONFIG.map((k) => {
                    const o = a.origen?.[k] ?? "sin_valor";
                    const puedeHeredar = o === "propio" && !!datos.claves[k];
                    return (
                      <li key={k} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1.5">
                        <span className="text-sm">{TITULO_CLAVE[k]}</span>
                        <span className="flex items-center gap-2">
                          <Badge variant={o === "grupo" ? "ok" : "neutral"}>{textoOrigen(o)}</Badge>
                          {puedeHeredar && (
                            <Button type="button" variant="outline" className="h-10" disabled={guardando !== null} onClick={() => heredar(a, k)}>
                              {guardando === `${a.club_id}-${k}` ? "Cambiando…" : "Volver al del grupo"}
                            </Button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <details className="rounded-lg border border-border">
        <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium">Cambios del grupo ({datos.historial.length})</summary>
        {datos.historial.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">Todavía no hay cambios.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {datos.historial.map((c, i) => (
              <li key={`${c.hecho_en}-${i}`} className="flex flex-col gap-0.5 px-4 py-2.5 text-sm">
                <span className="break-words">{textoCambio(c, descr)}</span>
                <span className="text-xs text-muted-foreground">
                  {c.quien ?? "—"} · {fechaHora.format(new Date(c.hecho_en))}
                  {c.vigente_desde ? ` · desde el ${etiquetaNoche(c.vigente_desde)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
