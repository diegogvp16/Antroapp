"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { describirRegla } from "@/lib/domain/config-rp";
import { CLAVES_CONFIG, TITULO_CLAVE, describirValor, type ClaveConfig } from "@/lib/domain/config-grupo";
import { Campo, SELECT_CLASES } from "./campo";
import type { Borrador } from "./estado";

type Grupo = Borrador["grupo"];
export type GrupoExistente = { id: string; nombre: string; antros: number };

const MODOS: ReadonlyArray<{ valor: Grupo["modo"]; etiqueta: string; ayuda: string }> = [
  { valor: "ninguno", etiqueta: "Antro independiente", ayuda: "No pertenece a ningún grupo." },
  { valor: "nuevo", etiqueta: "Grupo nuevo", ayuda: "Crea el grupo con este antro como el primero." },
  { valor: "existente", etiqueta: "Agregar a un grupo existente", ayuda: "El dueño del grupo verá este antro en /grupo." },
];

export function PasoGrupo({
  grupo,
  grupos,
  hayDueno,
  errores,
  onCambio,
}: {
  grupo: Grupo;
  grupos: GrupoExistente[] | null;
  hayDueno: boolean;
  errores: Record<string, string>;
  onCambio: (g: Grupo) => void;
}) {
  const set = <K extends keyof Grupo>(k: K, v: Grupo[K]) => onCambio({ ...grupo, [k]: v });
  const opcionesDueno: ReadonlyArray<{ valor: Grupo["dueno_grupo"]; etiqueta: string }> = [
    ...(grupo.modo === "existente" ? [{ valor: "ninguno" as const, etiqueta: "Nadie más (el grupo ya tiene dueño)" }] : []),
    { valor: "dueno_antro", etiqueta: hayDueno ? "El dueño de este antro" : "El dueño de este antro (agrégalo en Equipo)" },
    { valor: "cuenta_nueva", etiqueta: "Una cuenta nueva" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">¿Pertenece a un grupo?</legend>
        {MODOS.map((m) => (
          <label key={m.valor} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-foreground">
            <input
              type="radio"
              name="grupo-modo"
              className="mt-0.5 size-5"
              checked={grupo.modo === m.valor}
              onChange={() =>
                onCambio({
                  ...grupo,
                  modo: m.valor,
                  dueno_grupo: m.valor === "existente" ? "ninguno" : grupo.dueno_grupo === "ninguno" ? "dueno_antro" : grupo.dueno_grupo,
                })
              }
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{m.etiqueta}</span>
              <span className="text-xs text-muted-foreground">{m.ayuda}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {grupo.modo === "nuevo" && (
        <Campo id="grupo-nombre" etiqueta="Nombre del grupo" error={errores["grupo.nombre"]}>
          <Input id="grupo-nombre" className="h-10" maxLength={120} value={grupo.nombre} aria-invalid={!!errores["grupo.nombre"] || undefined} onChange={(e) => set("nombre", e.target.value)} />
        </Campo>
      )}

      {grupo.modo === "existente" && (
        <Campo id="grupo-id" etiqueta="Grupo" error={errores["grupo.grupo_id"]}>
          <select id="grupo-id" className={SELECT_CLASES} value={grupo.grupo_id} onChange={(e) => set("grupo_id", e.target.value)}>
            <option value="">{grupos === null ? "Cargando grupos…" : grupos.length === 0 ? "No hay grupos todavía" : "Elige un grupo"}</option>
            {(grupos ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.nombre} ({g.antros} {g.antros === 1 ? "antro" : "antros"})
              </option>
            ))}
          </select>
        </Campo>
      )}

      {grupo.modo === "existente" && grupo.grupo_id && (
        <ConfigDelGrupo grupoId={grupo.grupo_id} config={grupo.config} onConfig={(c) => set("config", c)} />
      )}

      {grupo.modo !== "ninguno" && (
        <>
          <Campo id="grupo-dueno" etiqueta="Dueño del grupo" error={errores["grupo.dueno_grupo"]} ayuda="Ve las cifras de todos los antros del grupo en /grupo.">
            <select id="grupo-dueno" className={SELECT_CLASES} value={grupo.dueno_grupo} onChange={(e) => set("dueno_grupo", e.target.value as Grupo["dueno_grupo"])}>
              {opcionesDueno.map((o) => (
                <option key={o.valor} value={o.valor}>
                  {o.etiqueta}
                </option>
              ))}
            </select>
          </Campo>
          {grupo.dueno_grupo === "cuenta_nueva" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Campo id="grupo-cuenta-nombre" etiqueta="Nombre" error={errores["grupo.cuenta.nombre"] ?? errores["grupo.cuenta"]}>
                <Input id="grupo-cuenta-nombre" className="h-10" value={grupo.cuenta.nombre} onChange={(e) => set("cuenta", { ...grupo.cuenta, nombre: e.target.value })} />
              </Campo>
              <Campo id="grupo-cuenta-correo" etiqueta="Correo" error={errores["grupo.cuenta.correo"]}>
                <Input id="grupo-cuenta-correo" type="email" className="h-10" value={grupo.cuenta.correo} onChange={(e) => set("cuenta", { ...grupo.cuenta, correo: e.target.value })} />
              </Campo>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Grupo existente: qué define el grupo y si el antro lo sigue
// (sql/post-junta-2/12-config-grupo.sql; la base lo aplica en el alta).
type ValoresGrupo = Partial<Record<ClaveConfig, { valor: unknown; bloqueado: boolean }>>;
const descr = (r: Parameters<typeof describirRegla>[0]) => describirRegla(r);

function ConfigDelGrupo({ grupoId, config, onConfig }: { grupoId: string; config: Grupo["config"]; onConfig: (c: Grupo["config"]) => void }) {
  const [claves, setClaves] = useState<ValoresGrupo | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vigente = true;
    setClaves(null);
    setError(false);
    createClient()
      .rpc("grupo_config_actual", { p_grupo: grupoId })
      .then(({ data, error: e }) => {
        if (!vigente) return;
        if (e) setError(true);
        else setClaves(((data as { claves?: ValoresGrupo } | null)?.claves ?? {}) as ValoresGrupo);
      });
    return () => {
      vigente = false;
    };
  }, [grupoId]);

  if (error) return <p className="text-xs text-muted-foreground">No se pudo leer la configuración del grupo. Si el grupo define valores, la base los aplica igual al antro nuevo.</p>;
  if (!claves) return <p className="text-sm text-muted-foreground">Leyendo la configuración del grupo…</p>;
  const definidas = CLAVES_CONFIG.filter((k) => claves[k]);
  if (definidas.length === 0) {
    return <p className="text-xs text-muted-foreground">El grupo todavía no define valores por defecto: el antro nace con lo de este alta y seguirá al grupo en lo que defina después.</p>;
  }
  const bloqueadas = definidas.filter((k) => claves[k]?.bloqueado);
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-semibold">Configuración del grupo</legend>
      <ul className="flex flex-col gap-1 text-sm">
        {definidas.map((k) => (
          <li key={k} className="break-words">
            <span className="font-medium">{TITULO_CLAVE[k]}:</span> {describirValor(k, claves[k]?.valor, descr)}
            {claves[k]?.bloqueado && <span className="text-xs text-muted-foreground"> (bloqueado)</span>}
          </li>
        ))}
      </ul>
      {(
        [
          { valor: "grupo", etiqueta: "Usar la del grupo (recomendado)", ayuda: "Reemplaza lo de los pasos anteriores en lo que el grupo define. El antro sigue al grupo." },
          { valor: "alta", etiqueta: "Usar lo de este alta", ayuda: "El antro se queda con lo que pusiste; los cambios del grupo no lo tocan hasta que vuelva al del grupo." },
        ] as const
      ).map((o) => (
        <label key={o.valor} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-foreground">
          <input type="radio" name="grupo-config" className="mt-0.5 size-5" checked={config === o.valor} onChange={() => onConfig(o.valor)} />
          <span className="flex flex-col">
            <span className="text-sm font-medium">{o.etiqueta}</span>
            <span className="text-xs text-muted-foreground">{o.ayuda}</span>
          </span>
        </label>
      ))}
      {config === "alta" && bloqueadas.length > 0 && (
        <p className="text-xs text-status-warn">El grupo bloqueó {bloqueadas.map((k) => TITULO_CLAVE[k].toLowerCase()).join(", ")}: eso se aplica aunque elijas lo de este alta.</p>
      )}
    </fieldset>
  );
}
