"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ETIQUETA_ROL, MAX_PERSONAL, ROLES_PERSONAL, leerListaPersonal, type RolPersonal } from "@/lib/domain/alta-club";
import { Campo, SELECT_CLASES, TEXTAREA_CLASES } from "./campo";
import { nuevaClave, type Borrador, type FilaPersonal } from "./estado";

type Equipo = Pick<Borrador, "conDueno" | "dueno" | "personal">;

export function PasoEquipo({
  equipo,
  errores,
  onCambio,
}: {
  equipo: Equipo;
  errores: Record<string, string>;
  onCambio: (e: Equipo) => void;
}) {
  const [lista, setLista] = useState("");
  const [rolLista, setRolLista] = useState<RolPersonal>("rp");
  const [avisoLista, setAvisoLista] = useState<string[]>([]);
  const { personal } = equipo;
  const cuenta = (rol: RolPersonal) => personal.filter((p) => p.rol === rol).length;

  const cambiar = (clave: string, cambio: Partial<FilaPersonal>) =>
    onCambio({ ...equipo, personal: personal.map((p) => (p.clave === clave ? { ...p, ...cambio } : p)) });

  function agregarLista() {
    const { filas, errores: errs } = leerListaPersonal(lista, rolLista);
    const espacio = MAX_PERSONAL - personal.length;
    const aceptadas = filas.slice(0, Math.max(0, espacio));
    onCambio({ ...equipo, personal: [...personal, ...aceptadas.map((f) => ({ ...f, clave: nuevaClave() }))] });
    const avisos = [...errs];
    if (filas.length > aceptadas.length) avisos.push(`Se llegó al máximo de ${MAX_PERSONAL} personas: ${filas.length - aceptadas.length} no se agregaron.`);
    setAvisoLista(avisos);
    // Se quedan en el cuadro solo las líneas con error, para corregirlas.
    setLista(errs.length ? lista.split(/\r?\n/).filter((_, i) => errs.some((e) => e.startsWith(`Línea ${i + 1}:`))).join("\n") : "");
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Cada persona recibe una contraseña temporal que verás <strong>una sola vez</strong> al terminar. Pueden cambiarla en «¿Olvidaste tu contraseña?».
      </p>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">Dueño del antro</legend>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5" checked={equipo.conDueno} onChange={(e) => onCambio({ ...equipo, conDueno: e.target.checked })} />
          Crear la cuenta del dueño ahora
        </label>
        {equipo.conDueno && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo id="dueno-nombre" etiqueta="Nombre" error={errores["dueno.nombre"]}>
              <Input id="dueno-nombre" className="h-10" autoComplete="off" value={equipo.dueno.nombre} aria-invalid={!!errores["dueno.nombre"] || undefined} onChange={(e) => onCambio({ ...equipo, dueno: { ...equipo.dueno, nombre: e.target.value } })} />
            </Campo>
            <Campo id="dueno-correo" etiqueta="Correo" error={errores["dueno.correo"]}>
              <Input id="dueno-correo" className="h-10" type="email" autoComplete="off" value={equipo.dueno.correo} aria-invalid={!!errores["dueno.correo"] || undefined} onChange={(e) => onCambio({ ...equipo, dueno: { ...equipo.dueno, correo: e.target.value } })} />
            </Campo>
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">Pegar una lista</legend>
        <Campo id="lista-personal" etiqueta="Una persona por línea: Nombre, correo" ayuda="Puedes copiarla de una hoja de cálculo (columnas Nombre y Correo).">
          <textarea
            id="lista-personal"
            className={TEXTAREA_CLASES}
            value={lista}
            placeholder={"Ana López, ana@correo.com\nLuis Pérez, luis@correo.com"}
            onChange={(e) => setLista(e.target.value)}
          />
        </Campo>
        <div className="flex flex-wrap items-end gap-3">
          <Campo id="lista-rol" etiqueta="Como">
            <select id="lista-rol" className={`${SELECT_CLASES} w-36`} value={rolLista} onChange={(e) => setRolLista(e.target.value as RolPersonal)}>
              {ROLES_PERSONAL.map((r) => (
                <option key={r} value={r}>
                  {ETIQUETA_ROL[r]}
                </option>
              ))}
            </select>
          </Campo>
          <Button type="button" variant="outline" className="h-10" onClick={agregarLista} disabled={!lista.trim()}>
            Agregar de la lista
          </Button>
        </div>
        {avisoLista.length > 0 && (
          <ul role="alert" className="flex flex-col gap-1 text-xs font-medium text-status-warn">
            {avisoLista.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {ROLES_PERSONAL.map((r) => (
            <Badge key={r} variant="neutral">
              {ETIQUETA_ROL[r]}: {cuenta(r)}
            </Badge>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={personal.length >= MAX_PERSONAL}
          onClick={() => onCambio({ ...equipo, personal: [...personal, { clave: nuevaClave(), nombre: "", correo: "", rol: "staff" }] })}
        >
          Agregar una persona
        </Button>
      </div>

      {errores.personal && (
        <p role="alert" className="text-xs font-medium text-status-err">
          {errores.personal}
        </p>
      )}

      {personal.length > 0 && (
        <ul className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto pr-1" aria-label="Personal del antro">
          {personal.map((p, i) => {
            const e = errores[`personal.${i}.nombre`] ?? errores[`personal.${i}.correo`] ?? errores[`personal.${i}.rol`];
            return (
              <li key={p.clave} className="flex flex-col gap-1.5 border-b border-border pb-3 last:border-b-0">
                <div className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_1fr_8rem_auto]">
                  <Input aria-label={`Nombre de la persona ${i + 1}`} placeholder="Nombre" className="h-10" value={p.nombre} aria-invalid={!!errores[`personal.${i}.nombre`] || undefined} onChange={(ev) => cambiar(p.clave, { nombre: ev.target.value })} />
                  <Button type="button" variant="ghost" size="icon-lg" className="sm:order-last" aria-label={`Quitar a ${p.nombre || `la persona ${i + 1}`}`} onClick={() => onCambio({ ...equipo, personal: personal.filter((x) => x.clave !== p.clave) })}>
                    <Trash2 />
                  </Button>
                  <Input aria-label={`Correo de ${p.nombre || `la persona ${i + 1}`}`} placeholder="Correo" type="email" className="h-10" value={p.correo} aria-invalid={!!errores[`personal.${i}.correo`] || undefined} onChange={(ev) => cambiar(p.clave, { correo: ev.target.value })} />
                  <select aria-label={`Rol de ${p.nombre || `la persona ${i + 1}`}`} className={SELECT_CLASES} value={p.rol} onChange={(ev) => cambiar(p.clave, { rol: ev.target.value as RolPersonal })}>
                    {ROLES_PERSONAL.map((r) => (
                      <option key={r} value={r}>
                        {ETIQUETA_ROL[r]}
                      </option>
                    ))}
                  </select>
                </div>
                {e && (
                  <p role="alert" className="text-xs font-medium text-status-err">
                    {e}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
