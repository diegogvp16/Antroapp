"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OPCIONES_VISIBILIDAD, describirRegla, type TipoRegla } from "@/lib/domain/config-rp";
import {
  MAX_TARIFAS_DIA,
  PERMISOS_CAJA_ALTA,
  ROLES_CAJA,
  cambiosDePermisos,
  esquemaReglaComision,
  matrizPorDefecto,
  type ModoPagoRp,
  type PermisoCajaAlta,
  type RolCaja,
} from "@/lib/domain/alta-club";
import { Campo, describir } from "./campo";
import { aEntradaRp, nuevaClave, type Borrador } from "./estado";

// Paso «Reglas de comisión y RPs» del alta: cómo se paga a los RPs (por
// reserva con regla del antro, o por día con tarifas), qué ven de sus
// clientes y, opcional, los permisos de caja por rol. Se guarda con el alta,
// en la misma transacción (sql/post-junta-2/10-alta-club-reglas.sql).

type Rp = Borrador["rp"];
type Permisos = Borrador["permisos"];

const MODOS: ReadonlyArray<{ valor: ModoPagoRp; titulo: string; detalle: string }> = [
  { valor: "reserva", titulo: "Por reserva que consume", detalle: "El RP gana cuando la mesa de su cliente consume y se cuadra." },
  { valor: "dia", titulo: "Por día trabajado", detalle: "Una tarifa por cada día con asistencia confirmada, sin importar las reservas." },
];
const TIPOS: ReadonlyArray<{ valor: TipoRegla; titulo: string }> = [
  { valor: "porcentaje", titulo: "Porcentaje del consumo" },
  { valor: "fijo", titulo: "Monto fijo por reserva que consume" },
  { valor: "cuota", titulo: "Con cuota: las primeras N de la semana no pagan" },
];
const ROL_TITULO: Record<RolCaja, string> = { staff: "Staff", gerente: "Gerente" };

const OPCION_CLASES =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-foreground";

export function PasoReglas({
  rp,
  permisos,
  errores,
  onCambio,
  onPermisos,
}: {
  rp: Rp;
  permisos: Permisos;
  errores: Record<string, string>;
  onCambio: (rp: Rp) => void;
  onPermisos: (p: Permisos) => void;
}) {
  const set = <K extends keyof Rp>(k: K, v: Rp[K]) => onCambio({ ...rp, [k]: v });
  const err = (k: string) => errores[`rp.${k}`];

  // Vista previa: solo si lo escrito ya es una regla válida.
  const entrada = aEntradaRp(rp);
  const regla = entrada.regla ? esquemaReglaComision.safeParse(entrada.regla) : null;
  const cambios = cambiosDePermisos(permisos.matriz).length;

  function cambiarPermiso(rol: RolCaja, permiso: PermisoCajaAlta, v: boolean) {
    onPermisos({ ...permisos, matriz: { ...permisos.matriz, [rol]: { ...permisos.matriz[rol], [permiso]: v } } });
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Así nace calculando el antro. Después, el dueño o el gerente lo cambian en «Reglas de pago a RPs»; esos cambios valen desde el lunes
        siguiente.
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Cómo se paga a los RPs</legend>
        {MODOS.map((m) => (
          <label key={m.valor} className={OPCION_CLASES}>
            <input type="radio" name="alta-modo-pago" className="mt-0.5 size-5" checked={rp.modo_pago === m.valor} onChange={() => set("modo_pago", m.valor)} />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{m.titulo}</span>
              <span className="text-xs text-muted-foreground">{m.detalle}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {rp.modo_pago === "reserva" ? (
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold">Regla de comisión del antro</legend>
          <div className="flex flex-col gap-1">
            {TIPOS.map((t) => (
              <label key={t.valor} className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
                <input type="radio" name="alta-tipo-regla" className="size-5" checked={rp.tipo === t.valor} onChange={() => set("tipo", t.valor)} />
                {t.titulo}
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {rp.tipo === "cuota" && (
              <Campo id="alta-cuota" etiqueta="Reservas sin pago (N)" error={err("regla.cuota")} ayuda="Por semana, de lunes a domingo.">
                <Input
                  id="alta-cuota"
                  className="h-10"
                  inputMode="numeric"
                  autoComplete="off"
                  value={rp.cuota_texto}
                  aria-invalid={!!err("regla.cuota") || undefined}
                  aria-describedby={describir("alta-cuota", err("regla.cuota"), "x")}
                  onChange={(e) => set("cuota_texto", e.target.value.replace(/\D/g, "").slice(0, 3))}
                />
              </Campo>
            )}
            {rp.tipo === "porcentaje" ? (
              <Campo id="alta-porcentaje" etiqueta="Porcentaje del consumo" error={err("regla.porcentaje_bp")}>
                <Input
                  id="alta-porcentaje"
                  className="h-10"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="10"
                  value={rp.porcentaje_texto}
                  aria-invalid={!!err("regla.porcentaje_bp") || undefined}
                  aria-describedby={describir("alta-porcentaje", err("regla.porcentaje_bp"))}
                  onChange={(e) => set("porcentaje_texto", e.target.value)}
                />
              </Campo>
            ) : (
              <Campo
                id="alta-monto"
                etiqueta={rp.tipo === "cuota" ? `Pago desde la reserva ${Number(rp.cuota_texto || 0) + 1} (pesos)` : "Pago por reserva (pesos)"}
                error={err("regla.monto_centavos")}
              >
                <Input
                  id="alta-monto"
                  className="h-10"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="150"
                  value={rp.monto_texto}
                  aria-invalid={!!err("regla.monto_centavos") || undefined}
                  aria-describedby={describir("alta-monto", err("regla.monto_centavos"))}
                  onChange={(e) => set("monto_texto", e.target.value)}
                />
              </Campo>
            )}
          </div>
          {err("regla") && (
            <p role="alert" className="text-xs font-medium text-status-err">
              {err("regla")}
            </p>
          )}
          <div className="flex flex-col gap-1 rounded-lg bg-muted p-3 text-sm" aria-live="polite">
            <span className="text-xs text-muted-foreground">Así se calcula</span>
            <span>{regla?.success ? describirRegla(regla.data) : "Completa la regla para ver cómo queda."}</span>
            <span className="text-xs text-muted-foreground">Vale desde esta misma semana: el antro es nuevo y no tiene comisiones que respetar.</span>
          </div>
        </fieldset>
      ) : (
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold">Tarifa por día trabajado</legend>
          <p className="text-xs text-muted-foreground">
            Día 1 = el primer día que el RP trabaja en la semana (lunes a domingo), día 2 = el segundo… Si trabaja más días de los que pongas, se
            repite la tarifa del último.
          </p>
          <ul className="flex flex-col gap-2" aria-label="Tarifas por día">
            {rp.tarifas.map((t, i) => {
              const e = err(`tarifas_dia.${i}`);
              const id = `alta-tarifa-${i}`;
              const ultimo = i === rp.tarifas.length - 1;
              return (
                <li key={t.clave} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <label htmlFor={id} className="w-14 shrink-0 text-sm">
                      Día {i + 1}
                    </label>
                    <Input
                      id={id}
                      className="h-10 flex-1"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="Pesos, por ejemplo 300"
                      value={t.texto}
                      aria-invalid={!!e || undefined}
                      aria-describedby={e ? `${id}-error` : undefined}
                      onChange={(ev) => set("tarifas", rp.tarifas.map((x) => (x.clave === t.clave ? { ...x, texto: ev.target.value } : x)))}
                    />
                    {ultimo && rp.tarifas.length > 1 ? (
                      <Button type="button" variant="ghost" size="icon-lg" aria-label={`Quitar la tarifa del día ${i + 1}`} onClick={() => set("tarifas", rp.tarifas.slice(0, -1))}>
                        <Trash2 />
                      </Button>
                    ) : (
                      <span className="size-10 shrink-0" aria-hidden />
                    )}
                  </div>
                  {e && (
                    <p id={`${id}-error`} role="alert" className="text-xs font-medium text-status-err">
                      {e}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {err("tarifas_dia") && (
            <p role="alert" className="text-xs font-medium text-status-err">
              {err("tarifas_dia")}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-10 self-start"
            disabled={rp.tarifas.length >= MAX_TARIFAS_DIA}
            onClick={() => set("tarifas", [...rp.tarifas, { clave: nuevaClave(), texto: "" }])}
          >
            Agregar el día {rp.tarifas.length + 1}
          </Button>
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Qué ven los RPs de sus clientes</legend>
        {OPCIONES_VISIBILIDAD.map((o) => (
          <label key={o.valor} className={OPCION_CLASES}>
            <input type="radio" name="alta-visibilidad" className="mt-0.5 size-5" checked={rp.visibilidad === o.valor} onChange={() => set("visibilidad", o.valor)} />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{o.titulo}</span>
              <span className="text-xs text-muted-foreground">{o.detalle}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <section className="flex flex-col gap-3" aria-labelledby="alta-permisos-titulo">
        <h3 id="alta-permisos-titulo" className="text-sm font-semibold">
          Permisos de caja <span className="font-normal text-muted-foreground">(opcional)</span>
        </h3>
        <label className={OPCION_CLASES}>
          <input
            type="checkbox"
            className="mt-0.5 size-5"
            checked={permisos.personalizar}
            onChange={(e) => onPermisos({ ...permisos, personalizar: e.target.checked })}
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium">Cambiar los permisos de la plataforma</span>
            <span className="text-xs text-muted-foreground">
              Si no, el gerente puede todo y el staff recibe en la puerta, abre mesas, registra consumo, cobra y cierra mesas. El dueño y el admin
              siempre pueden todo.
            </span>
          </span>
        </label>

        {permisos.personalizar && (
          <div className="flex flex-col gap-2">
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">Permisos de caja por rol</caption>
                <thead className="bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      Permiso
                    </th>
                    {ROLES_CAJA.map((r) => (
                      <th key={r} scope="col" className="w-16 px-1 py-2 text-center font-medium">
                        {ROL_TITULO[r]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {PERMISOS_CAJA_ALTA.map((p) => (
                    <tr key={p.permiso}>
                      <th scope="row" className="px-3 py-2 text-left font-normal">
                        <span className="block font-medium">{p.titulo}</span>
                        <span className="block text-xs text-muted-foreground">{p.detalle}</span>
                      </th>
                      {ROLES_CAJA.map((r) => (
                        <td key={r} className="px-1 text-center">
                          <label className="inline-flex size-11 cursor-pointer items-center justify-center">
                            <input
                              type="checkbox"
                              className="size-5"
                              aria-label={`${ROL_TITULO[r]}: ${p.titulo}`}
                              checked={permisos.matriz[r][p.permiso]}
                              onChange={(e) => cambiarPermiso(r, p.permiso, e.target.checked)}
                            />
                          </label>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {cambios === 0 ? "Igual que la plataforma." : `${cambios} ${cambios === 1 ? "cambio" : "cambios"} respecto de la plataforma.`}
              </p>
              <Button type="button" variant="ghost" className="h-10" disabled={cambios === 0} onClick={() => onPermisos({ ...permisos, matriz: matrizPorDefecto() })}>
                Volver a los de la plataforma
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
