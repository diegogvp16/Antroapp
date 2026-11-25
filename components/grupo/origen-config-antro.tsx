"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { etiquetaNoche } from "@/lib/fechas";
import { describirRegla } from "@/lib/domain/config-rp";
import { CLAVES_CONFIG, TITULO_CLAVE, describirValor, type ClaveConfig, type Origen } from "@/lib/domain/config-grupo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// En la configuración de UN antro: de dónde sale cada valor («Del grupo» o
// «Propio»), con «Volver al del grupo» y «Usar uno propio». Solo aparece si
// el antro está en un grupo. Lo resuelve la base (club_config_efectiva).

type Clave = { origen: Origen; bloqueado: boolean; valor: unknown; valor_grupo: unknown; puede_cambiar: boolean };
type Efectiva = { grupo: { id: string; nombre: string } | null; puede_editar_grupo: boolean; claves: Record<ClaveConfig, Clave> };

const descr = (r: Parameters<typeof describirRegla>[0]) => describirRegla(r);

// Claves que el grupo bloqueó en este antro → nombre del grupo (para que el
// panel desactive lo que la base va a rechazar).
export type BloqueosGrupo = Partial<Record<ClaveConfig, string>>;

export function OrigenConfigAntro({
  clubId,
  version = 0,
  onCambio,
  onBloqueos,
}: {
  clubId: string;
  version?: number;
  onCambio?: () => void;
  onBloqueos?: (b: BloqueosGrupo) => void;
}) {
  const [datos, setDatos] = useState<Efectiva | null>(null);
  // En una ref: el panel la pasa en línea y no debe volver a disparar la carga.
  const avisarBloqueos = useRef(onBloqueos);
  useEffect(() => {
    avisarBloqueos.current = onBloqueos;
  });
  const [aviso, setAviso] = useState<{ tipo: "ok" | "err"; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<ClaveConfig | null>(null);

  const cargar = useCallback(async () => {
    const { data, error } = await createClient().rpc("club_config_efectiva", { p_club: clubId });
    // Sin permiso o sin el SQL nuevo: no se muestra nada (el resto del panel sigue igual).
    if (error) {
      setDatos(null);
      avisarBloqueos.current?.({});
      return;
    }
    const e = data as Efectiva;
    setDatos(e);
    const bloqueos: BloqueosGrupo = {};
    if (e?.grupo) for (const k of CLAVES_CONFIG) if (e.claves?.[k]?.bloqueado) bloqueos[k] = e.grupo.nombre;
    avisarBloqueos.current?.(bloqueos);
  }, [clubId]);

  // version: el panel la sube cuando cambia algo del antro (puede volverlo propio).
  useEffect(() => {
    cargar();
  }, [cargar, version]);

  if (!datos?.grupo) return null;
  const grupo = datos.grupo;

  async function accion(k: ClaveConfig, que: "heredar" | "sobrescribir") {
    setOcupado(k);
    setAviso(null);
    const supabase = createClient();
    const r =
      que === "heredar"
        ? await supabase.rpc("club_config_heredar", { p_club: clubId, p_clave: k })
        : await supabase.rpc("club_config_sobrescribir", { p_club: clubId, p_clave: k });
    setOcupado(null);
    if (r.error) return setAviso({ tipo: "err", texto: mensajeParaUsuario(r.error, "No se pudo cambiar. Intenta de nuevo.") });
    const desde = que === "heredar" ? (r.data as { vigente_desde?: string | null } | null)?.vigente_desde : null;
    setAviso({
      tipo: "ok",
      texto:
        que === "heredar"
          ? `«${TITULO_CLAVE[k]}» ya sigue al grupo.${desde ? ` La regla del grupo empieza el ${etiquetaNoche(desde)}; esta semana no cambia.` : ""}`
          : `«${TITULO_CLAVE[k]}» queda con el valor propio de este antro; los cambios del grupo ya no lo tocan.`,
    });
    await cargar();
    onCambio?.();
  }

  return (
    <Card id="origen-config-grupo">
      <CardContent className="flex flex-col gap-3 px-5 py-5">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold break-words">Configuración del grupo «{grupo.nombre}»</h3>
          <p className="text-xs text-muted-foreground">
            «Del grupo»: lo define el dueño del grupo y aquí se sigue. «Propio»: este antro usa el suyo. Si cambias algo abajo, queda propio.
          </p>
        </div>
        {aviso && (
          <p role={aviso.tipo === "err" ? "alert" : "status"} className={`text-sm break-words ${aviso.tipo === "err" ? "text-status-err" : "text-status-ok"}`}>
            {aviso.texto}
          </p>
        )}
        <ul className="flex flex-col divide-y divide-border">
          {CLAVES_CONFIG.map((k) => {
            const c = datos.claves[k];
            if (!c) return null;
            const delGrupo = c.origen === "grupo";
            const hayGrupo = c.valor_grupo != null;
            return (
              <li key={k} className="flex flex-col gap-1.5 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{TITULO_CLAVE[k]}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={delGrupo ? "ok" : "neutral"}>{delGrupo ? "Del grupo" : "Propio"}</Badge>
                    {c.bloqueado && <Badge variant="warn">Bloqueado por el grupo</Badge>}
                  </span>
                </div>
                <span className="text-xs break-words text-muted-foreground">
                  {describirValor(k, c.valor, descr)}
                  {!delGrupo && hayGrupo && ` · El grupo: ${describirValor(k, c.valor_grupo, descr)}`}
                  {/* La regla del grupo vale desde el lunes siguiente: mientras, esta semana sigue la anterior. */}
                  {delGrupo && hayGrupo && JSON.stringify(c.valor) !== JSON.stringify(c.valor_grupo) && ` · Desde el lunes: ${describirValor(k, c.valor_grupo, descr)}`}
                </span>
                {c.puede_cambiar && hayGrupo && !delGrupo && (
                  <Button type="button" variant="outline" className="h-10 self-start" disabled={ocupado !== null} onClick={() => accion(k, "heredar")}>
                    {ocupado === k ? "Cambiando…" : "Volver al del grupo"}
                  </Button>
                )}
                {c.puede_cambiar && delGrupo && !c.bloqueado && (
                  <Button type="button" variant="ghost" className="h-10 self-start" disabled={ocupado !== null} onClick={() => accion(k, "sobrescribir")}>
                    {ocupado === k ? "Cambiando…" : "Usar uno propio"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
