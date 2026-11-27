"use client";

// Reglas de la revisión de RPs de un antro: encender/apagar y umbrales, con
// la bitácora de cambios. Lo valida y autoriza la base (fraude_regla_guardar).
import { useCallback, useEffect, useState } from "react";
import {
  CATALOGO_FRAUDE,
  NOMBRE_REGLA,
  explicarRegla,
  validarParametros,
  type LimiteParametro,
  type ReglaFraude,
} from "@/lib/domain/fraude";
import { guardarRegla, leerCambiosReglas, leerReglas, type CambioRegla, type ReglaConfig } from "@/lib/fraude";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatoFechaHora } from "./evidencia-alerta";

function textoCambio(c: CambioRegla, limites: Record<string, Record<string, LimiteParametro>>): string {
  const lim = limites[c.regla] ?? {};
  // antes = null: estaba con los valores por defecto.
  const antes = c.antes?.parametros ?? Object.fromEntries(Object.entries(lim).map(([k, l]) => [k, l.defecto]));
  const partes: string[] = [];
  if ((c.antes?.activa ?? true) !== c.despues.activa) partes.push(c.despues.activa ? "encendida" : "apagada");
  for (const [k, v] of Object.entries(c.despues.parametros)) {
    if (antes[k] !== v) partes.push(`${lim[k]?.etiqueta ?? k}: ${antes[k] ?? "—"} → ${v}`);
  }
  return partes.join(" · ") || "sin cambios";
}

function TarjetaRegla({ clubId, regla, onGuardada }: { clubId: string; regla: ReglaConfig; onGuardada: () => void }) {
  const [activa, setActiva] = useState(regla.activa);
  const [valores, setValores] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(regla.parametros).map(([k, v]) => [k, String(v)])),
  );
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<{ ok: boolean; texto: string } | null>(null);

  const numeros = Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, v.trim() === "" ? NaN : Number(v)]));
  const cambio = activa !== regla.activa || Object.entries(numeros).some(([k, v]) => v !== regla.parametros[k]);

  async function guardar() {
    const invalido = validarParametros(regla.regla, numeros);
    if (invalido) {
      setMensaje({ ok: false, texto: invalido });
      return;
    }
    setGuardando(true);
    setMensaje(null);
    const r = await guardarRegla(clubId, regla.regla, activa, numeros);
    setGuardando(false);
    if (!r.ok) {
      setMensaje({ ok: false, texto: r.mensaje });
      return;
    }
    setMensaje({ ok: true, texto: "Guardado. Vale desde la siguiente búsqueda de alertas." });
    onGuardada();
  }

  const id = (k: string) => `regla_${regla.regla}_${k}`;
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 font-semibold break-words">{NOMBRE_REGLA[regla.regla]}</h3>
          <label className="flex min-h-10 shrink-0 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5 accent-primary"
              checked={activa}
              onChange={(e) => setActiva(e.target.checked)}
            />
            {activa ? "Encendida" : "Apagada"}
          </label>
        </div>
        <p className="text-sm text-muted-foreground">{explicarRegla(regla.regla, regla.parametros)}</p>
        <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
          {/* En el orden del catálogo (la base devuelve las claves en el orden de jsonb). */}
          {Object.keys(CATALOGO_FRAUDE[regla.regla])
            .filter((k) => regla.limites[k])
            .map((k) => [k, regla.limites[k]] as const)
            .map(([k, lim]) => (
            <div key={k} className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={id(k)}>{lim.etiqueta}</Label>
              <Input
                id={id(k)}
                type="number"
                inputMode="numeric"
                min={lim.min}
                max={lim.max}
                step={1}
                className="h-10"
                value={valores[k] ?? ""}
                onChange={(e) => setValores((v) => ({ ...v, [k]: e.target.value }))}
              />
              <span className="text-xs text-muted-foreground">
                De {lim.min} a {lim.max} · por defecto {lim.defecto}
              </span>
            </div>
          ))}
        </div>
        {mensaje && (
          <p className={`text-sm ${mensaje.ok ? "text-status-ok" : "text-destructive"}`} role={mensaje.ok ? "status" : "alert"}>
            {mensaje.texto}
          </p>
        )}
        <Button type="button" className="h-10 self-start" disabled={!cambio || guardando} onClick={guardar}>
          {guardando ? "Guardando..." : "Guardar regla"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function ReglasFraude({ clubId, zona }: { clubId: string; zona: string }) {
  const [reglas, setReglas] = useState<ReglaConfig[] | null>(null);
  const [cambios, setCambios] = useState<CambioRegla[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const fechaHora = formatoFechaHora(zona);

  const cargar = useCallback(async () => {
    const [r, c] = await Promise.all([leerReglas(clubId), leerCambiosReglas(clubId)]);
    if (!r.ok) {
      setError(r.mensaje);
      return;
    }
    setError(null);
    setReglas(r.datos ?? []);
    setCambios(c.ok ? (c.datos ?? []) : []);
    setVersion((v) => v + 1);
  }, [clubId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm break-words text-destructive" role="alert">{error}</p>
        <Button type="button" variant="outline" className="h-10 self-start" onClick={cargar}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (!reglas) return <p className="text-sm text-muted-foreground">Cargando reglas...</p>;

  const limites = Object.fromEntries(reglas.map((r) => [r.regla, r.limites])) as Record<ReglaFraude, ReglaConfig["limites"]>;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Las reglas solo señalan casos para revisar: una alerta no es una prueba. Los cambios valen para las siguientes
        búsquedas; las alertas ya revisadas no cambian.
      </p>
      {reglas.map((r) => (
        // key con versión: tras guardar, la tarjeta se reinicia con lo guardado.
        <TarjetaRegla key={`${r.regla}-${version}`} clubId={clubId} regla={r} onGuardada={cargar} />
      ))}
      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">Cambios recientes</h3>
        {cambios.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nadie ha cambiado las reglas: están con sus valores por defecto.</p>
        ) : (
          <ul className="flex flex-col text-sm">
            {cambios.map((c) => (
              <li key={c.id} className="border-b border-border py-2 last:border-b-0">
                <span className="font-medium">{NOMBRE_REGLA[c.regla]}</span>: {textoCambio(c, limites)}
                <span className="block text-xs text-muted-foreground">
                  {c.hecho_por_nombre ?? "Administración"} · {fechaHora(c.hecho_en)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
