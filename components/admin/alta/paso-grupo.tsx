"use client";

import { Input } from "@/components/ui/input";
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
