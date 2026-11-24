"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { parsearPesosACentavos } from "@/lib/cover";
import { etiquetaNoche } from "@/lib/fechas";
import {
  OPCIONES_VISIBILIDAD,
  describirRegla,
  porcentajeABp,
  validarRegla,
  type NivelVisibilidad,
  type Regla,
  type TipoRegla,
} from "@/lib/domain/config-rp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Qué ven los RPs de sus clientes y la regla de comisión del antro. Lo usan
// el dueño (/dueno/panel) y el gerente (/staff/panel). La regla nueva vale
// desde el lunes siguiente (nunca retroactivo); quién y cuándo queda en la
// bitácora. Todo lo valida y autoriza la base (config_rp_*).

type ReglaDesc = Regla & { origen?: "regla" | "anterior"; vigente_desde?: string };
type Config = {
  nivel_visibilidad: NivelVisibilidad;
  modo_pago: "reserva" | "dia";
  vigente: ReglaDesc;
  programada: ReglaDesc | null;
  siguiente_lunes: string;
  rps_con_regla_propia: number;
};
type Cambio = { hecho_en: string; que: string; antes: unknown; despues: unknown; vigente_desde: string | null; quien: string };

const TIPOS: ReadonlyArray<{ valor: TipoRegla; titulo: string }> = [
  { valor: "porcentaje", titulo: "Porcentaje del consumo" },
  { valor: "fijo", titulo: "Monto fijo por reserva que consume" },
  { valor: "cuota", titulo: "Con cuota: las primeras N de la semana no pagan" },
];
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function textoCambio(c: Cambio): string {
  if (c.que === "visibilidad") {
    const t = (v: unknown) => OPCIONES_VISIBILIDAD.find((o) => o.valor === v)?.titulo ?? String(v);
    return `Lo que ven los RPs: «${t(c.antes)}» → «${t(c.despues)}»`;
  }
  return `Regla de comisión: ${describirRegla(c.despues as Regla)}${c.vigente_desde ? ` (desde el ${etiquetaNoche(c.vigente_desde)})` : ""}`;
}

export function ConfigRpAntro({ clubId }: { clubId: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [historial, setHistorial] = useState<Cambio[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nivel, setNivel] = useState<NivelVisibilidad>("estado_monto");
  const [tipo, setTipo] = useState<TipoRegla>("fijo");
  const [montoTxt, setMontoTxt] = useState("");
  const [porcTxt, setPorcTxt] = useState("");
  const [cuotaTxt, setCuotaTxt] = useState("4");
  const [aviso, setAviso] = useState<string | null>(null);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<"nivel" | "regla" | null>(null);

  const cargar = useCallback(async () => {
    const supabase = createClient();
    const [c, h] = await Promise.all([supabase.rpc("config_rp_actual", { p_club: clubId }), supabase.rpc("config_rp_historial", { p_club: clubId })]);
    if (c.error) {
      setError(mensajeParaUsuario(c.error, "No pudimos cargar la configuración de los RPs."));
      return;
    }
    const cfg = c.data as Config;
    setConfig(cfg);
    setNivel(cfg.nivel_visibilidad);
    setHistorial((h.data ?? []) as Cambio[]);
  }, [clubId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function guardarNivel() {
    setGuardando("nivel");
    setAviso(null);
    const { error: e } = await createClient().rpc("config_rp_cambiar_visibilidad", { p_club: clubId, p_nivel: nivel });
    setGuardando(null);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo guardar."));
    setAviso("Listo: tus RPs ya ven sus reservas así.");
    cargar();
  }

  async function guardarRegla() {
    setErrorForm(null);
    setAviso(null);
    const centavos = parsearPesosACentavos(montoTxt);
    const regla: Regla = {
      tipo,
      cuota: tipo === "cuota" ? Number(cuotaTxt) : 0,
      porcentaje_bp: tipo === "porcentaje" ? porcentajeABp(porcTxt) : null,
      monto_centavos: tipo === "porcentaje" ? null : centavos,
    };
    const problema = validarRegla(regla);
    if (problema) return setErrorForm(problema);
    setGuardando("regla");
    const { data, error: e } = await createClient().rpc("config_rp_cambiar_regla", {
      p_club: clubId,
      p_tipo: regla.tipo,
      p_cuota: regla.cuota,
      p_porcentaje_bp: regla.porcentaje_bp,
      p_monto_centavos: regla.monto_centavos,
    });
    setGuardando(null);
    if (e) return setErrorForm(mensajeParaUsuario(e, "No se pudo guardar la regla."));
    const desde = (data as { vigente_desde?: string })?.vigente_desde;
    setAviso(`Regla programada: empieza el ${desde ? etiquetaNoche(desde) : "lunes"}. Esta semana sigue la regla actual.`);
    cargar();
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-status-err">
        {error}
      </p>
    );
  }
  if (!config) return <p className="text-sm text-muted-foreground">Cargando…</p>;

  return (
    <div className="flex flex-col gap-4">
      {aviso && (
        <p role="status" className="text-sm text-status-ok">
          {aviso}
        </p>
      )}

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-5">
          <h3 className="text-sm font-semibold">Qué ven tus RPs de sus clientes</h3>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Qué ven tus RPs</legend>
            {OPCIONES_VISIBILIDAD.map((o) => (
              <label key={o.valor} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-foreground">
                <input type="radio" name={`nivel-${clubId}`} className="mt-0.5 size-5" checked={nivel === o.valor} onChange={() => setNivel(o.valor)} />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{o.titulo}</span>
                  <span className="text-xs text-muted-foreground">{o.detalle}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button type="button" className="h-10 self-start" disabled={guardando !== null || nivel === config.nivel_visibilidad} onClick={guardarNivel}>
            {guardando === "nivel" ? "Guardando…" : "Guardar"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-5">
          <h3 className="text-sm font-semibold">Comisión por reserva</h3>
          {config.modo_pago === "dia" && (
            <p className="text-sm text-muted-foreground">
              Tu antro paga a sus RPs <strong>por día de asistencia</strong>. Esta regla solo se usa en el modo «por reserva».
            </p>
          )}
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Esta semana</span>
            <span>{describirRegla(config.vigente)}</span>
          </div>
          {config.programada && (
            <div className="flex flex-col gap-1 rounded-lg border border-status-warn/40 bg-status-warn/10 p-3 text-sm">
              <Badge variant="warn">Desde el {etiquetaNoche(config.programada.vigente_desde ?? config.siguiente_lunes)}</Badge>
              <span>{describirRegla(config.programada)}</span>
            </div>
          )}
          {config.rps_con_regla_propia > 0 && (
            <p className="text-xs text-muted-foreground">
              {config.rps_con_regla_propia} {config.rps_con_regla_propia === 1 ? "RP tiene" : "RPs tienen"} una regla propia: para ellos sigue esa (abajo, «Sueldo individual por RP»).
            </p>
          )}

          <fieldset className="mt-2 flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Nueva regla</legend>
            {TIPOS.map((t) => (
              <label key={t.valor} className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
                <input type="radio" name={`tipo-${clubId}`} className="size-5" checked={tipo === t.valor} onChange={() => setTipo(t.valor)} />
                {t.titulo}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            {tipo === "cuota" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`cuota-${clubId}`}>Reservas sin pago (N)</Label>
                <Input id={`cuota-${clubId}`} className="h-10" inputMode="numeric" value={cuotaTxt} onChange={(e) => setCuotaTxt(e.target.value.replace(/\D/g, "").slice(0, 3))} />
              </div>
            )}
            {tipo === "porcentaje" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`porc-${clubId}`}>Porcentaje del consumo</Label>
                <Input id={`porc-${clubId}`} className="h-10" inputMode="decimal" placeholder="10" value={porcTxt} onChange={(e) => setPorcTxt(e.target.value)} />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`monto-${clubId}`}>{tipo === "cuota" ? `Pago desde la reserva ${Number(cuotaTxt || 0) + 1} (pesos)` : "Pago por reserva (pesos)"}</Label>
                <Input id={`monto-${clubId}`} className="h-10" inputMode="decimal" placeholder="150" value={montoTxt} onChange={(e) => setMontoTxt(e.target.value)} />
              </div>
            )}
          </div>
          {errorForm && (
            <p role="alert" className="text-xs font-medium text-status-err">
              {errorForm}
            </p>
          )}
          <Button type="button" className="h-10 self-start" disabled={guardando !== null} onClick={guardarRegla}>
            {guardando === "regla" ? "Guardando…" : `Programar desde el ${etiquetaNoche(config.siguiente_lunes)}`}
          </Button>
          <p className="text-xs text-muted-foreground">
            Nunca cambia lo de la semana en curso: lo que ya se calculó o se calcule hasta el domingo sigue con la regla actual.
          </p>
        </CardContent>
      </Card>

      {historial.length > 0 && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Cambios ({historial.length})</summary>
          <ul className="flex flex-col divide-y divide-border border-t border-border">
            {historial.map((c, i) => (
              <li key={`${c.hecho_en}-${i}`} className="flex flex-col gap-0.5 px-4 py-2.5 text-sm">
                <span>{textoCambio(c)}</span>
                <span className="text-xs text-muted-foreground">
                  {c.quien} · {fechaHora.format(new Date(c.hecho_en))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
