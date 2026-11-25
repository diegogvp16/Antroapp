"use client";

import { useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CoverCampo } from "@/components/cover-campo";
import { parsearPesosACentavos, validarCover } from "@/lib/cover";
import { OPCIONES_VISIBILIDAD, porcentajeABp, validarRegla, type NivelVisibilidad, type Regla, type TipoRegla } from "@/lib/domain/config-rp";
import { PERMISOS_CAJA_ALTA, ROLES_CAJA, cambiosDePermisos, matrizPorDefecto, type MatrizPermisos, type PermisoCajaAlta, type RolCaja } from "@/lib/domain/alta-club";
import type { CeldaPermiso, ClaveConfig, ValorCover, ValorModo, ValorRegla, ValorTolerancia } from "@/lib/domain/config-grupo";
import type { CoverModo } from "@/types";

// Editores de cada valor de la configuración del grupo. Cada uno guarda su
// propio borrador y entrega el valor ya en la forma que espera la base
// (_config_normalizar en sql/post-junta-2/12-config-grupo.sql), o un error.
// La base vuelve a validar todo.

export type Lectura = { valor: unknown } | { error: string };
export type Editor = { ui: ReactNode; leer: () => Lectura };

const OPCION = "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-foreground";
const TIPOS: ReadonlyArray<{ valor: TipoRegla; titulo: string }> = [
  { valor: "porcentaje", titulo: "Porcentaje del consumo" },
  { valor: "fijo", titulo: "Monto fijo por reserva que consume" },
  { valor: "cuota", titulo: "Con cuota: las primeras N de la semana no pagan" },
];
const centavosATexto = (c: number | null | undefined) => (c == null ? "" : c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));
const bpATexto = (bp: number | null | undefined) => (bp == null ? "" : String(bp / 100));

function useRegla(id: string, inicial: ValorRegla | null): Editor {
  const [tipo, setTipo] = useState<TipoRegla>(inicial?.tipo ?? "fijo");
  const [cuota, setCuota] = useState(inicial?.tipo === "cuota" ? String(inicial.cuota) : "4");
  const [porc, setPorc] = useState(bpATexto(inicial?.porcentaje_bp));
  const [monto, setMonto] = useState(centavosATexto(inicial?.monto_centavos));
  const leer = (): Lectura => {
    const r: Regla = {
      tipo,
      cuota: tipo === "cuota" ? Number(cuota) : 0,
      porcentaje_bp: tipo === "porcentaje" ? porcentajeABp(porc) : null,
      monto_centavos: tipo === "porcentaje" ? null : parsearPesosACentavos(monto),
    };
    const e = validarRegla(r);
    return e ? { error: e } : { valor: r };
  };
  const ui = (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Tipo de regla</legend>
        {TIPOS.map((t) => (
          <label key={t.valor} className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
            <input type="radio" name={`${id}-tipo`} className="size-5" checked={tipo === t.valor} onChange={() => setTipo(t.valor)} />
            {t.titulo}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        {tipo === "cuota" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-cuota`}>Reservas sin pago (N)</Label>
            <Input id={`${id}-cuota`} className="h-10" inputMode="numeric" value={cuota} onChange={(e) => setCuota(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </div>
        )}
        {tipo === "porcentaje" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-porc`}>Porcentaje del consumo</Label>
            <Input id={`${id}-porc`} className="h-10" inputMode="decimal" placeholder="10" value={porc} onChange={(e) => setPorc(e.target.value)} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-monto`}>{tipo === "cuota" ? `Pago desde la reserva ${Number(cuota || 0) + 1} (pesos)` : "Pago por reserva (pesos)"}</Label>
            <Input id={`${id}-monto`} className="h-10" inputMode="decimal" placeholder="150" value={monto} onChange={(e) => setMonto(e.target.value)} />
          </div>
        )}
      </div>
    </div>
  );
  return { ui, leer };
}

function useVisibilidad(id: string, inicial: NivelVisibilidad | null): Editor {
  const [nivel, setNivel] = useState<NivelVisibilidad>(inicial ?? "estado_monto");
  const ui = (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">Qué ven los RPs</legend>
      {OPCIONES_VISIBILIDAD.map((o) => (
        <label key={o.valor} className={OPCION}>
          <input type="radio" name={`${id}-nivel`} className="mt-0.5 size-5" checked={nivel === o.valor} onChange={() => setNivel(o.valor)} />
          <span className="flex flex-col">
            <span className="text-sm font-medium">{o.titulo}</span>
            <span className="text-xs text-muted-foreground">{o.detalle}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
  return { ui, leer: () => ({ valor: nivel }) };
}

function useModo(id: string, inicial: ValorModo | null): Editor {
  const [modo, setModo] = useState<ValorModo["modo"]>(inicial?.modo ?? "reserva");
  const [tarifas, setTarifas] = useState<string[]>(
    inicial?.tarifas_dia?.length ? inicial.tarifas_dia.map((t) => centavosATexto(t.monto_centavos)) : [""],
  );
  const leer = (): Lectura => {
    if (modo === "reserva") return { valor: { modo, tarifas_dia: [] } };
    const lista: ValorModo["tarifas_dia"] = [];
    for (let i = 0; i < tarifas.length; i++) {
      const c = parsearPesosACentavos(tarifas[i]);
      if (c == null || c > 10_000_000) return { error: `Escribe la tarifa del día ${i + 1} (de $0 a $100,000).` };
      lista.push({ posicion: i + 1, monto_centavos: c });
    }
    return lista.length ? { valor: { modo, tarifas_dia: lista } } : { error: "Escribe al menos la tarifa del día 1." };
  };
  const ui = (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Cómo se paga a los RPs</legend>
        {(
          [
            { valor: "reserva", titulo: "Por reserva que consume", detalle: "Con la regla de comisión del antro." },
            { valor: "dia", titulo: "Por día trabajado", detalle: "Una tarifa por cada día con asistencia confirmada." },
          ] as const
        ).map((m) => (
          <label key={m.valor} className={OPCION}>
            <input type="radio" name={`${id}-modo`} className="mt-0.5 size-5" checked={modo === m.valor} onChange={() => setModo(m.valor)} />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{m.titulo}</span>
              <span className="text-xs text-muted-foreground">{m.detalle}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {modo === "dia" && (
        <ul className="flex flex-col gap-2" aria-label="Tarifas por día">
          {tarifas.map((t, i) => (
            <li key={i} className="flex items-center gap-2">
              <label htmlFor={`${id}-tarifa-${i}`} className="w-14 shrink-0 text-sm">
                Día {i + 1}
              </label>
              <Input
                id={`${id}-tarifa-${i}`}
                className="h-10 flex-1"
                inputMode="decimal"
                placeholder="Pesos, por ejemplo 300"
                value={t}
                onChange={(e) => setTarifas(tarifas.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {i === tarifas.length - 1 && tarifas.length > 1 ? (
                <Button type="button" variant="ghost" size="icon-lg" aria-label={`Quitar la tarifa del día ${i + 1}`} onClick={() => setTarifas(tarifas.slice(0, -1))}>
                  <Trash2 />
                </Button>
              ) : (
                <span className="size-10 shrink-0" aria-hidden />
              )}
            </li>
          ))}
          {tarifas.length < 7 && (
            <li>
              <Button type="button" variant="outline" className="h-10" onClick={() => setTarifas([...tarifas, ""])}>
                Agregar el día {tarifas.length + 1}
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
  return { ui, leer };
}

const ROL_TITULO: Record<RolCaja, string> = { staff: "Staff", gerente: "Gerente" };

function usePermisos(id: string, inicial: CeldaPermiso[] | null): Editor {
  const [matriz, setMatriz] = useState<MatrizPermisos>(() => {
    const m = matrizPorDefecto();
    for (const c of inicial ?? []) {
      if (c.rol in m && c.permiso in m[c.rol]) m[c.rol][c.permiso as PermisoCajaAlta] = c.permitido;
    }
    return m;
  });
  const cambios = cambiosDePermisos(matriz).length;
  const ui = (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-0 text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Permiso</th>
              {ROLES_CAJA.map((r) => (
                <th key={r} className="w-16 px-1 py-1 text-center font-medium">
                  {ROL_TITULO[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISOS_CAJA_ALTA.map((p) => (
              <tr key={p.permiso} className="border-t border-border">
                <td className="py-1.5 pr-2">{p.titulo}</td>
                {ROLES_CAJA.map((r) => (
                  <td key={r} className="px-1 text-center">
                    <label className="inline-flex size-10 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        className="size-5"
                        aria-label={`${ROL_TITULO[r]}: ${p.titulo}`}
                        checked={matriz[r][p.permiso]}
                        onChange={(e) => setMatriz({ ...matriz, [r]: { ...matriz[r], [p.permiso]: e.target.checked } })}
                      />
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {cambios === 0 ? "Igual que la plataforma." : `${cambios} ${cambios === 1 ? "cambio" : "cambios"} respecto de la plataforma.`} Las casillas por persona
        de cada antro siguen ganando.
      </p>
      <Button type="button" variant="outline" className="h-10 self-start" onClick={() => setMatriz(matrizPorDefecto())} id={`${id}-plataforma`}>
        Volver a los de la plataforma
      </Button>
    </div>
  );
  return { ui, leer: () => ({ valor: cambiosDePermisos(matriz) }) };
}

function useCover(id: string, inicial: ValorCover | null): Editor {
  const [modo, setModo] = useState<CoverModo>(inicial?.cover_modo ?? "oculto");
  const [monto, setMonto] = useState(centavosATexto(inicial?.cover_monto_centavos));
  const leer = (): Lectura => {
    const r = validarCover(modo, monto);
    if (!r.ok) return { error: r.error };
    return { valor: { cover_modo: r.cover_modo, cover_monto_centavos: r.cover_monto == null ? null : Math.round(r.cover_monto * 100) } };
  };
  return { ui: <CoverCampo idPrefix={id} modo={modo} monto={monto} onModoChange={setModo} onMontoChange={setMonto} />, leer };
}

function useTolerancia(id: string, inicial: ValorTolerancia | null): Editor {
  const [hora, setHora] = useState(inicial?.tolerancia_hora ?? "");
  const leer = (): Lectura =>
    hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora) ? { error: "Escribe la hora en formato HH:MM." } : { valor: { tolerancia_hora: hora || null } };
  const ui = (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-hora`}>Llegar a más tardar a las</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={`${id}-hora`} type="time" className="h-10 w-36" value={hora} onChange={(e) => setHora(e.target.value)} />
        <Button type="button" variant="outline" className="h-10" disabled={!hora} onClick={() => setHora("")}>
          Sin límite
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hora ? `Después de las ${hora} la reserva se marca como tarde en la puerta.` : "Sin hora límite."}</p>
    </div>
  );
  return { ui, leer };
}

// Un editor por clave (siempre se llaman todos: reglas de los hooks).
export function useEditores(prefijo: string, valores: Partial<Record<ClaveConfig, unknown>>): Record<ClaveConfig, Editor> {
  return {
    regla_comision: useRegla(`${prefijo}-regla`, (valores.regla_comision as ValorRegla) ?? null),
    visibilidad_rp: useVisibilidad(`${prefijo}-vis`, (valores.visibilidad_rp as NivelVisibilidad) ?? null),
    modo_pago: useModo(`${prefijo}-modo`, (valores.modo_pago as ValorModo) ?? null),
    caja_permisos: usePermisos(`${prefijo}-caja`, (valores.caja_permisos as CeldaPermiso[]) ?? null),
    cover: useCover(`${prefijo}-cover`, (valores.cover as ValorCover) ?? null),
    tolerancia: useTolerancia(`${prefijo}-tol`, (valores.tolerancia as ValorTolerancia) ?? null),
  };
}
