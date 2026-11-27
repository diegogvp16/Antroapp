"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccionConMotivo, FilaMonto, MensajeError, useAccion } from "@/components/caja/accion";
import { SelectorNoche } from "@/components/inventario/selector-noche";
import { nuevaClave } from "@/lib/clave";
import { formatearCentavos, horaCorta, METODO_LABEL, METODOS_PAGO, montoValido, nombreMesa, pesosACentavos, type MetodoPago } from "@/lib/domain/caja";
import {
  describirRegla,
  errorConfig,
  leerPorcentaje,
  ordenarLineas,
  sugerirParticipantes,
  sumaLineas,
  TIPO_LINEA_LABEL,
  type ConfigPropinas,
  type LineaReparto,
  type PersonaReparto,
} from "@/lib/domain/propinas";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { useFase2DeClub } from "@/lib/fase2-contexto";
import { useEntradaGerente } from "@/lib/fase2-pagina";
import { cn } from "@/lib/utils";

// Propinas de la noche (bloque 8, sql/post-junta-3/81-propinas.sql): reporte
// por forma de pago, por mesa y por origen, la regla del reparto, el reparto
// de la noche cerrada, anular una propina (también solo la de un cobro) y la
// propina sin mesa. Solo gerente, con la bandera «propinas» del antro. Las
// propinas no entran al consumo, al cuadre de caja ni a las comisiones.

type Reporte = {
  fecha: string;
  noche_id: string | null;
  estado: "abierta" | "cerrada" | null;
  total_centavos: number;
  por_metodo: Record<MetodoPago, number>;
  por_origen: { cobro: number; cobro_n: number; suelta: number; suelta_n: number };
  por_mesa: { sesion_id: string | null; mesa: string | null; total_centavos: number }[];
  propinas: {
    id: string;
    origen: "cobro" | "suelta";
    mesa: string | null;
    cuenta: string | null;
    rp: string | null;
    rp_de_baja: string | null;
    metodo: MetodoPago;
    monto_centavos: number;
    nota: string | null;
    registrado_por: string | null;
    registrado_en: string;
    anulado: boolean;
    motivo_anulacion: string | null;
  }[];
  rp_de_baja: string[];
  personal: PersonaReparto[];
  reparto: {
    id: string;
    total_centavos: number;
    hecho_en: string;
    hecho_por: string | null;
    pct_personal: number;
    pct_rp: number;
    pct_casa: number;
    lineas: LineaReparto[];
  } | null;
  config: ConfigPropinas & { por_defecto: boolean; actualizado_en: string | null };
};

// La regla que se está viendo: se manda al calcular y al repartir; si otro
// gerente la cambió, la base rechaza en vez de guardar otro reparto.
const reglaVista = (c: ConfigPropinas) => ({
  p_pct_personal: c.pct_personal,
  p_pct_rp: c.pct_rp,
  p_pct_casa: c.pct_casa,
  p_incluye_gerente: c.incluye_gerente,
});

export default function PropinasPage() {
  const entrada = useEntradaGerente();
  const clubEntrada = entrada.tipo === "listo" ? entrada.clubId : null;
  const banderas = useFase2DeClub(clubEntrada);
  const clubId = banderas.propinas ? clubEntrada : null;
  const [fecha, setFecha] = useState<string | null>(null);
  const [rep, setRep] = useState<Reporte | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (entrada.tipo === "listo" && fecha === null) setFecha(entrada.nocheHoy);
  }, [entrada, fecha]);

  const cargar = useCallback(async () => {
    if (!clubId || !fecha) return;
    const { data, error: e } = await createClient().rpc("propinas_reporte_noche", { p_club_id: clubId, p_fecha: fecha });
    if (e) {
      setError(mensajeParaUsuario(e, "No pudimos cargar las propinas. Intenta de nuevo."));
      return;
    }
    setError(null);
    setRep(data as Reporte);
  }, [clubId, fecha]);
  useEffect(() => {
    setRep(null);
    void cargar();
  }, [cargar]);

  const sinBandera = entrada.tipo === "listo" && !banderas.cargando && !banderas.propinas;

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <Link href="/staff/panel" className="-ml-2 flex h-11 w-fit items-center px-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          ← Panel
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Propinas de la noche</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Las del cobro y las que dejan aparte. No entran al consumo, al conteo de caja ni a las comisiones. Se reparten con la noche cerrada.
          </p>
        </div>

        {(entrada.tipo === "apagado" || sinBandera) && <p className="text-sm text-muted-foreground">Las propinas todavía no están activas en tu antro.</p>}
        {(entrada.tipo === "cargando" || (entrada.tipo === "listo" && banderas.cargando)) && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {entrada.tipo === "error" && (
          <p className="text-sm text-destructive" role="alert">
            {entrada.mensaje}
          </p>
        )}

        {clubId && fecha && entrada.tipo === "listo" && (
          <>
            <SelectorNoche fecha={fecha} hoy={entrada.nocheHoy} onCambio={setFecha} />
            {error && (
              <div className="flex flex-col gap-2" role="alert">
                <p className="text-sm text-destructive">{error}</p>
                <Button type="button" variant="outline" className="h-11 w-fit" onClick={() => void cargar()}>
                  Reintentar
                </Button>
              </div>
            )}
            {!rep && !error && <p className="text-sm text-muted-foreground">Cargando…</p>}
            {rep && <Contenido rep={rep} clubId={clubId} onCambio={cargar} />}
          </>
        )}
      </div>
    </div>
  );
}

function Contenido({ rep, clubId, onCambio }: { rep: Reporte; clubId: string; onCambio: () => Promise<void> }) {
  const vigentes = rep.propinas.filter((p) => !p.anulado);
  const anulable = !rep.reparto && rep.noche_id !== null;
  const { error, ejecutar } = useAccion();
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Total de propinas</CardTitle>
          <CardDescription>
            {rep.noche_id === null
              ? "Esa noche no se abrió la caja."
              : rep.estado === "cerrada"
                ? "La noche ya se cerró: ya no entran propinas."
                : "La noche sigue abierta: pueden entrar más propinas."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {METODOS_PAGO.map((m) => (
            <FilaMonto key={m} etiqueta={`En ${METODO_LABEL[m].toLowerCase()}`} valor={formatearCentavos(Number(rep.por_metodo[m]))} />
          ))}
          <FilaMonto etiqueta="Total" valor={formatearCentavos(Number(rep.total_centavos))} fuerte />
          <FilaMonto etiqueta={`Con el cobro (${rep.por_origen.cobro_n})`} valor={formatearCentavos(Number(rep.por_origen.cobro))} />
          <FilaMonto etiqueta={`Aparte (${rep.por_origen.suelta_n})`} valor={formatearCentavos(Number(rep.por_origen.suelta))} />
        </CardContent>
      </Card>

      {rep.estado === "abierta" && rep.noche_id && <PropinaSinMesa nocheId={rep.noche_id} onCambio={onCambio} />}

      {rep.por_mesa.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Por mesa</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {rep.por_mesa.map((m) => (
              <li key={m.sesion_id ?? "sin-mesa"} className="flex min-h-11 items-center justify-between gap-2 px-4">
                <span>{m.mesa ? nombreMesa(m.mesa) : "Sin mesa"}</span>
                <span className="tabular-nums">{formatearCentavos(Number(m.total_centavos))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rep.propinas.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">
            Cada propina <span className="text-sm font-normal text-muted-foreground">{vigentes.length}</span>
          </h2>
          {anulable && (
            <p className="text-xs text-muted-foreground">
              Anular una propina del cobro solo la saca del reparto: el cobro, el saldo y el cuadre no cambian.
            </p>
          )}
          <MensajeError mensaje={error} />
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {rep.propinas.map((p) => (
              <li key={p.id} className="flex flex-col gap-1 px-4 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn("min-w-0", p.anulado && "text-muted-foreground line-through")}>
                    {p.mesa ? nombreMesa(p.mesa) : "Sin mesa"} · {METODO_LABEL[p.metodo]}
                  </span>
                  <span className={cn("tabular-nums", p.anulado && "text-muted-foreground line-through")}>{formatearCentavos(Number(p.monto_centavos))}</span>
                </div>
                <span className="break-words text-xs text-muted-foreground">
                  {horaCorta(p.registrado_en)} · {p.origen === "cobro" ? "con el cobro" : "aparte"}
                  {p.cuenta ? ` · ${p.cuenta}` : ""}
                  {p.rp ? ` · RP ${p.rp}` : ""}
                  {p.rp_de_baja ? ` · RP ${p.rp_de_baja} (dado de baja: su parte va al personal)` : ""}
                  {p.registrado_por ? ` · ${p.registrado_por}` : ""}
                  {p.nota ? ` · ${p.nota}` : ""}
                  {p.anulado ? ` — anulada: ${p.motivo_anulacion ?? ""}` : ""}
                </span>
                {anulable && !p.anulado && (
                  <AccionConMotivo
                    etiqueta="Anular propina"
                    etiquetaConfirmar="Anular propina"
                    placeholder="Motivo (ej. eran $50, no $500)"
                    variante="destructive"
                    onConfirmar={(motivo) =>
                      ejecutar(
                        () =>
                          p.origen === "cobro"
                            ? createClient().rpc("propinas_anular_de_cobro", { p_pago_id: p.id, p_motivo: motivo })
                            : createClient().rpc("caja_anular_propina", { p_propina_id: p.id, p_motivo: motivo }),
                        onCambio,
                      )
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Regla key={`regla-${rep.config.actualizado_en ?? "defecto"}`} clubId={clubId} config={rep.config} onCambio={onCambio} />
      <Reparto key={`reparto-${rep.config.actualizado_en ?? "defecto"}-${rep.total_centavos}`} rep={rep} onCambio={onCambio} />
    </>
  );
}

// Propina sin mesa (la que dejan después de cuadrar, o la de la barra).
function PropinaSinMesa({ nocheId, onCambio }: { nocheId: string; onCambio: () => Promise<void> }) {
  const [abierta, setAbierta] = useState(false);
  const [metodo, setMetodo] = useState<MetodoPago>("efectivo");
  const [monto, setMonto] = useState("");
  const [nota, setNota] = useState("");
  const [clave, setClave] = useState(nuevaClave);
  const { ocupado, error, ejecutar } = useAccion();
  const cent = pesosACentavos(monto);
  const valido = montoValido(cent);
  if (!abierta) {
    return (
      <Button type="button" variant="outline" className="h-11 w-full" onClick={() => setAbierta(true)}>
        Registrar propina sin mesa
      </Button>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Propina sin mesa</CardTitle>
        <CardDescription>La que dejan después de cuadrar la mesa, o la de la barra. Va aparte del cobro.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!valido || cent === null) return;
            const ok = await ejecutar(
              () =>
                createClient().rpc("caja_registrar_propina", {
                  p_noche_id: nocheId,
                  p_sesion_id: null,
                  p_cuenta_id: null,
                  p_metodo: metodo,
                  p_monto_centavos: cent,
                  p_nota: nota.trim() || null,
                  p_clave: clave,
                }),
              onCambio,
            );
            if (ok) {
              setMonto("");
              setNota("");
              setClave(nuevaClave());
              setAbierta(false);
            }
          }}
        >
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Forma de pago">
            {(["efectivo", "tarjeta"] as const).map((m) => (
              <Button key={m} type="button" variant={metodo === m ? "default" : "outline"} className="h-11" aria-pressed={metodo === m} onClick={() => setMetodo(m)}>
                {METODO_LABEL[m]}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sin-mesa-monto">Propina ($)</Label>
            <Input id="sin-mesa-monto" value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" placeholder="0.00" />
            {monto.trim() !== "" && !valido && <span className="text-xs text-destructive">Propina no válida (ej. 150).</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sin-mesa-nota">Nota (opcional)</Label>
            <Input id="sin-mesa-nota" value={nota} onChange={(e) => setNota(e.target.value)} maxLength={200} placeholder="Ej. la dejaron en la mesa 4 ya cuadrada" />
          </div>
          <MensajeError mensaje={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="h-11" disabled={!valido || ocupado}>
              {ocupado ? "Guardando..." : `Registrar ${valido && cent !== null ? formatearCentavos(cent) : ""}`}
            </Button>
            <Button type="button" variant="ghost" className="h-11" disabled={ocupado} onClick={() => setAbierta(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Regla({ clubId, config, onCambio }: { clubId: string; config: Reporte["config"]; onCambio: () => Promise<void> }) {
  const [editando, setEditando] = useState(false);
  const [personal, setPersonal] = useState(String(config.pct_personal));
  const [rp, setRp] = useState(String(config.pct_rp));
  const [casa, setCasa] = useState(String(config.pct_casa));
  const [gerente, setGerente] = useState(config.incluye_gerente);
  const { ocupado, error, ejecutar } = useAccion();
  const valores = { pct_personal: leerPorcentaje(personal) ?? -1, pct_rp: leerPorcentaje(rp) ?? -1, pct_casa: leerPorcentaje(casa) ?? -1 };
  const falta = errorConfig(valores);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Regla del reparto</CardTitle>
        <CardDescription>
          {describirRegla(config)}
          {config.por_defecto ? " (la de siempre: todavía no se configura)" : ""}. Si la cuenta no tiene RP, o el RP está dado de baja, su parte va
          al personal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!editando ? (
          <Button type="button" variant="outline" className="h-11" onClick={() => setEditando(true)}>
            Cambiar la regla
          </Button>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (falta) return;
              const ok = await ejecutar(
                () =>
                  createClient().rpc("propinas_config_guardar", {
                    p_club_id: clubId,
                    p_pct_personal: valores.pct_personal,
                    p_pct_rp: valores.pct_rp,
                    p_pct_casa: valores.pct_casa,
                    p_incluye_gerente: gerente,
                  }),
                onCambio,
              );
              if (ok) setEditando(false);
            }}
          >
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["Personal %", personal, setPersonal, "pct-personal"],
                  ["RP %", rp, setRp, "pct-rp"],
                  ["Casa %", casa, setCasa, "pct-casa"],
                ] as const
              ).map(([etiqueta, valor, poner, id]) => (
                <div key={id} className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={id}>{etiqueta}</Label>
                  <Input id={id} value={valor} onChange={(e) => poner(e.target.value)} inputMode="numeric" />
                </div>
              ))}
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={gerente} onChange={(e) => setGerente(e.target.checked)} className="size-5" />
              El gerente también entra al reparto del personal
            </label>
            {falta && <p className="text-xs text-muted-foreground">{falta}</p>}
            <p className="text-xs text-muted-foreground">Vale para los repartos que se hagan desde ahora; un reparto ya hecho no cambia.</p>
            <MensajeError mensaje={error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="h-11" disabled={!!falta || ocupado}>
                {ocupado ? "Guardando..." : "Guardar regla"}
              </Button>
              <Button type="button" variant="ghost" className="h-11" disabled={ocupado} onClick={() => setEditando(false)}>
                Cancelar
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function Reparto({ rep, onCambio }: { rep: Reporte; onCambio: () => Promise<void> }) {
  const sugeridos = useMemo(() => sugerirParticipantes(rep.personal), [rep.personal]);
  const [elegidos, setElegidos] = useState<string[]>(sugeridos);
  const [vista, setVista] = useState<LineaReparto[] | null>(null);
  const { ocupado, error, ejecutar, correr, limpiarError } = useAccion();
  useEffect(() => {
    setElegidos(sugeridos);
    setVista(null);
  }, [sugeridos]);

  if (rep.reparto) {
    const lineas = ordenarLineas(rep.reparto.lineas);
    return (
      <Card>
        <CardHeader>
          <CardTitle>Reparto de la noche</CardTitle>
          <CardDescription>
            Hecho a las {horaCorta(rep.reparto.hecho_en)}
            {rep.reparto.hecho_por ? ` por ${rep.reparto.hecho_por}` : ""} · {rep.reparto.pct_personal} % personal · {rep.reparto.pct_rp} % RP ·{" "}
            {rep.reparto.pct_casa} % casa
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <ListaLineas lineas={lineas} />
          <FilaMonto etiqueta="Total repartido" valor={formatearCentavos(sumaLineas(lineas))} fuerte />
          <MensajeError mensaje={error} />
          <AccionConMotivo
            etiqueta="Anular el reparto"
            etiquetaConfirmar="Anular el reparto"
            placeholder="Motivo (ej. faltó una persona)"
            variante="destructive"
            onConfirmar={(motivo) => ejecutar(() => createClient().rpc("propinas_anular_reparto", { p_reparto_id: rep.reparto!.id, p_motivo: motivo }), onCambio)}
          />
        </CardContent>
      </Card>
    );
  }

  const total = Number(rep.total_centavos);
  const cerrada = rep.estado === "cerrada";
  // Con 0 % al personal, o sin personal que pueda entrar, lo del personal va a la casa.
  const sinPersonal = rep.config.pct_personal === 0 || rep.personal.length === 0;
  const participantes = sinPersonal ? [] : elegidos;
  const alternar = (id: string) => {
    limpiarError();
    setVista(null);
    setElegidos((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repartir</CardTitle>
        <CardDescription>
          {total === 0
            ? "No hay propinas que repartir esa noche."
            : !cerrada
              ? "Se reparte con la noche cerrada (Caja → Cuadre de la noche), cuando ya no entran propinas."
              : sinPersonal
                ? rep.config.pct_personal === 0
                  ? "La regla da 0 % al personal: lo que no es del RP va a la casa."
                  : "No hay personal activo que pueda entrar: lo del personal va a la casa."
                : "Elige al personal que entra al reparto. Quedan marcados quienes trabajaron en la caja esa noche."}
        </CardDescription>
      </CardHeader>
      {total > 0 && cerrada && (
        <CardContent className="flex flex-col gap-3 text-sm">
          {rep.por_origen.cobro_n > 0 && (
            <p className="rounded-lg border border-status-warn/50 bg-status-warn/10 px-3 py-2 text-xs">
              Incluye {rep.por_origen.cobro_n} {rep.por_origen.cobro_n === 1 ? "propina capturada" : "propinas capturadas"} con el cobro (
              {formatearCentavos(Number(rep.por_origen.cobro))}). Revisa en «Cada propina» que todas sean correctas antes de repartir.
            </p>
          )}
          {rep.rp_de_baja.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {rep.rp_de_baja.join(", ")} {rep.rp_de_baja.length === 1 ? "está dado de baja" : "están dados de baja"}: su parte va al personal.
            </p>
          )}
          {!sinPersonal && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-xs text-muted-foreground">Personal</legend>
              {rep.personal.map((p) => (
                <label key={p.id} className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" className="size-5" checked={elegidos.includes(p.id)} onChange={() => alternar(p.id)} />
                  <span className="min-w-0 flex-1">
                    {p.nombre}
                    <span className="text-xs text-muted-foreground">
                      {p.rol === "gerente" ? " · gerente" : ""}
                      {p.trabajo ? " · trabajó esta noche" : ""}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={ocupado}
            onClick={() =>
              void correr(async (paso) => {
                const r = await paso<LineaReparto[]>(() =>
                  createClient().rpc("propinas_calcular", { p_noche_id: rep.noche_id, p_participantes: participantes, ...reglaVista(rep.config) }),
                );
                if (r.ok) setVista(ordenarLineas(r.data ?? []));
                return r.ok;
              })
            }
          >
            Ver cómo queda
          </Button>
          {vista && (
            <>
              <ListaLineas lineas={vista} />
              <p className="text-xs text-muted-foreground">Con la regla: {describirRegla(rep.config)}.</p>
              <Button
                type="button"
                className="h-11"
                disabled={ocupado}
                onClick={() =>
                  void ejecutar(
                    () =>
                      createClient().rpc("propinas_repartir", {
                        p_noche_id: rep.noche_id,
                        p_participantes: participantes,
                        p_total_visto: total,
                        ...reglaVista(rep.config),
                      }),
                    onCambio,
                  )
                }
              >
                {ocupado ? "Guardando..." : `Repartir ${formatearCentavos(total)}`}
              </Button>
            </>
          )}
          <MensajeError mensaje={error} />
        </CardContent>
      )}
    </Card>
  );
}

function ListaLineas({ lineas }: { lineas: LineaReparto[] }) {
  if (lineas.length === 0) return <p className="text-muted-foreground">Sin líneas.</p>;
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {lineas.map((l) => (
        <li key={`${l.tipo}-${l.profile_id ?? "casa"}`} className="flex min-h-11 items-center justify-between gap-2 px-3">
          <span className="min-w-0">
            {l.nombre}
            <span className="text-xs text-muted-foreground"> · {TIPO_LINEA_LABEL[l.tipo]}</span>
          </span>
          <span className="tabular-nums">{formatearCentavos(Number(l.monto_centavos))}</span>
        </li>
      ))}
    </ul>
  );
}
