"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { formatearCentavos, horaCorta } from "@/lib/domain/caja";
import { etiquetaNoche } from "@/lib/fechas";
import {
  agruparPorMesa,
  ESTADO_CONCILIACION,
  MOTIVO_SIN_LIGAR,
  normalizarFila,
  resumirNoche,
  type EstadoConciliacion,
  type FilaConciliacion,
} from "@/lib/pos/conciliacion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CLASE_SELECT } from "@/components/pos/importar-ventas";
import { cn } from "@/lib/utils";

// Conciliación de una noche: por mesa y cuenta, consumo registrado en caja
// contra lo que dice el POS. Los tickets del POS se pueden asignar a una
// cuenta, reasignar o dejar sin cuenta. Solo lectura de la caja: nada de
// esto la cambia.

interface TicketPos {
  ticket: string;
  mesa_texto: string | null;
  mesa_id: string | null;
  mesa_numero: string | null;
  sesion_id: string | null;
  cuenta_id: string | null;
  cliente_nombre: string | null;
  liga: string;
  estado_liga: string;
  total_centavos: number;
  lineas: number;
  venta_ids: string[];
  primera: string;
}
interface CuentaNoche {
  cuenta_id: string;
  cliente_nombre: string;
  mesa_id: string;
  mesa_numero: string;
  abierta_en: string;
}

const TONO: Record<string, "ok" | "warn" | "err" | "neutral"> = { ok: "ok", warn: "warn", err: "err", neutral: "neutral" };
const claveDe = (t: TicketPos) => `${t.ticket}|${t.mesa_texto ?? ""}|${t.cuenta_id ?? ""}|${t.estado_liga}|${t.venta_ids[0]}`;

export function ConciliacionNoche({ clubId, noche, onNoche }: { clubId: string; noche: string; onNoche: (n: string) => void }) {
  const [filas, setFilas] = useState<FilaConciliacion[] | null>(null);
  const [tickets, setTickets] = useState<TicketPos[]>([]);
  const [cuentas, setCuentas] = useState<CuentaNoche[]>([]);
  const [soloDiferencias, setSoloDiferencias] = useState(false);
  const [verTodos, setVerTodos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [eleccion, setEleccion] = useState<Record<string, string>>({});

  // Solo la respuesta de la última consulta cuenta: si se cambia de noche
  // mientras otra carga sigue en camino, la vieja no pisa a la nueva.
  const ultima = useRef(0);
  const cargar = useCallback(async () => {
    const turno = ++ultima.current;
    setError(null);
    const supabase = createClient();
    const [c, p, k] = await Promise.all([
      supabase.rpc("pos_conciliacion", { p_club_id: clubId, p_fecha: noche }),
      supabase.rpc("pos_tickets", { p_club_id: clubId, p_fecha: noche }),
      supabase.rpc("pos_cuentas_noche", { p_club_id: clubId, p_fecha: noche }),
    ]);
    if (turno !== ultima.current) return;
    const e = c.error ?? p.error ?? k.error;
    if (e) {
      setFilas([]);
      return setError(mensajeParaUsuario(e, "No pudimos cargar la conciliación. Intenta de nuevo."));
    }
    setFilas(((c.data ?? []) as Record<string, unknown>[]).map(normalizarFila));
    setTickets(((p.data ?? []) as TicketPos[]).map((x) => ({ ...x, total_centavos: Number(x.total_centavos) })));
    setCuentas((k.data ?? []) as CuentaNoche[]);
  }, [clubId, noche]);

  useEffect(() => {
    setFilas(null);
    setEleccion({});
    setAviso(null);
    void cargar();
  }, [cargar]);

  const mesas = useMemo(() => agruparPorMesa(filas ?? []), [filas]);
  const resumen = useMemo(() => resumirNoche(mesas), [mesas]);
  const visibles = soloDiferencias ? mesas.filter((m) => m.estado !== "coincide") : mesas;
  const sinCuenta = tickets.filter((t) => !t.cuenta_id);
  const listados = verTodos ? tickets : sinCuenta;

  async function asignar(t: TicketPos, cuenta: string | null) {
    setOcupado(true);
    setError(null);
    const { error: e } = await createClient().rpc("pos_asignar", { p_club_id: clubId, p_venta_ids: t.venta_ids, p_cuenta_id: cuenta });
    setOcupado(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo cambiar la cuenta."));
    setAviso(cuenta ? `Ticket ${t.ticket} ${t.cuenta_id ? "reasignado" : "asignado"}.` : `Ticket ${t.ticket}: se le quitó la cuenta.`);
    await cargar();
  }

  async function religar() {
    setOcupado(true);
    setError(null);
    const { data, error: e } = await createClient().rpc("pos_religar", { p_club_id: clubId, p_fecha: noche });
    setOcupado(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo volver a ligar."));
    setAviso(Number(data) ? `Se volvieron a ligar ${data} ventas.` : "No cambió nada: la caja no tiene cambios que afecten a las ventas.");
    await cargar();
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Conciliación de la noche</CardTitle>
          <CardDescription>Consumo registrado en caja (sin anulados) contra el total del POS, por mesa y cuenta.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pos-noche">Noche</Label>
            <Input id="pos-noche" type="date" value={noche} onChange={(e) => e.target.value && onNoche(e.target.value)} className="h-10" />
          </div>
          {filas === null ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : (
            <dl className="grid grid-cols-3 gap-2 text-sm" data-testid="pos-totales">
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">Caja</dt>
                <dd className="font-semibold tabular-nums">{formatearCentavos(resumen.caja)}</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">POS</dt>
                <dd className="font-semibold tabular-nums">{formatearCentavos(resumen.pos)}</dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs text-muted-foreground">POS − caja</dt>
                <dd className={cn("font-semibold tabular-nums", resumen.diferencia !== 0 && "text-status-err")}>{formatearCentavos(resumen.diferencia)}</dd>
              </div>
            </dl>
          )}
          {filas && mesas.length > 0 && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {(Object.keys(ESTADO_CONCILIACION) as EstadoConciliacion[]).map((k) => (
                <Badge key={k} variant={TONO[ESTADO_CONCILIACION[k].tono]}>
                  {ESTADO_CONCILIACION[k].etiqueta}: {resumen.porEstado[k]}
                </Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={soloDiferencias ? "default" : "outline"} className="h-10" aria-pressed={soloDiferencias} onClick={() => setSoloDiferencias((v) => !v)}>
              Solo lo que no coincide
            </Button>
            <Button type="button" variant="outline" className="h-10" disabled={ocupado} onClick={religar}>
              Volver a ligar con la caja
            </Button>
          </div>
          {aviso && <p className="text-sm text-status-ok">{aviso}</p>}
          {error && (
            <p role="alert" className="text-sm text-status-err">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {filas && mesas.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">Ni caja ni ventas del POS para el {etiquetaNoche(noche)}.</p>
      )}

      <ul className="flex flex-col gap-3" data-testid="pos-mesas">
        {visibles.map((m) => (
          <li key={m.clave}>
            <Card size="sm">
              <CardContent className="flex flex-col gap-2 px-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold break-all">{m.fueraDeCaja ? `POS: ${m.mesa === "Sin mesa" ? "sin mesa" : `mesa «${m.mesa}»`}` : `Mesa ${m.mesa}`}</span>
                  <Badge variant={TONO[ESTADO_CONCILIACION[m.estado].tono]}>{ESTADO_CONCILIACION[m.estado].etiqueta}</Badge>
                </div>
                <ul className="flex flex-col divide-y divide-border text-sm">
                  {m.filas.map((f, i) => (
                    <li key={`${f.cuenta_id ?? f.sesion_id ?? "x"}-${i}`} className="flex flex-col gap-0.5 py-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate">
                          {f.nivel === "cuenta" ? f.cliente_nombre : f.nivel === "mesa_sin_cuenta" ? "POS sin cuenta elegida" : "POS sin mesa abierta en caja"}
                        </span>
                        <Badge variant={TONO[ESTADO_CONCILIACION[f.estado].tono]}>{ESTADO_CONCILIACION[f.estado].etiqueta}</Badge>
                      </div>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        Caja {formatearCentavos(f.caja_centavos)} · POS {formatearCentavos(f.pos_centavos)}
                        {f.caja_centavos !== f.pos_centavos && f.caja_centavos > 0 && f.pos_lineas > 0 && (
                          <span className="font-semibold text-status-err"> · {formatearCentavos(f.pos_centavos - f.caja_centavos)}</span>
                        )}
                        {f.sesion_abierta_en && ` · grupo de las ${horaCorta(f.sesion_abierta_en)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {tickets.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Tickets del POS</CardTitle>
            <CardDescription>
              Asigna, cambia o quita la cuenta de caja de cada ticket. Solo cambia la conciliación, no la caja. Una cuenta quitada a mano no se vuelve a
              ligar sola.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div role="tablist" aria-label="Qué tickets ver" className="grid grid-cols-2 gap-2">
              <Button type="button" role="tab" aria-selected={!verTodos} variant={!verTodos ? "default" : "outline"} className="h-10 px-1" onClick={() => setVerTodos(false)}>
                Sin cuenta ({sinCuenta.length})
              </Button>
              <Button type="button" role="tab" aria-selected={verTodos} variant={verTodos ? "default" : "outline"} className="h-10 px-1" onClick={() => setVerTodos(true)}>
                Todos ({tickets.length})
              </Button>
            </div>
            {listados.length === 0 && <p className="text-sm text-muted-foreground">Todos los tickets tienen cuenta.</p>}
            <ul className="flex flex-col gap-3" data-testid="pos-tickets">
              {listados.map((t) => {
                const k = claveDe(t);
                const deLaMesa = cuentas.filter((c) => t.mesa_id && c.mesa_id === t.mesa_id && c.cuenta_id !== t.cuenta_id);
                const otras = cuentas.filter((c) => !(t.mesa_id && c.mesa_id === t.mesa_id) && c.cuenta_id !== t.cuenta_id);
                return (
                  <li key={k} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium break-all">
                        Ticket {t.ticket} · {t.mesa_numero ? `Mesa ${t.mesa_numero}` : t.mesa_texto ? `«${t.mesa_texto}»` : "sin mesa"} · {horaCorta(t.primera)}
                      </span>
                      <span className="tabular-nums">{formatearCentavos(t.total_centavos)}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {t.cuenta_id
                        ? `Cuenta: ${t.cliente_nombre ?? "—"}${t.liga === "manual" ? " (elegida a mano)" : ""}`
                        : (MOTIVO_SIN_LIGAR[t.estado_liga] ?? t.estado_liga)}
                    </span>
                    {cuentas.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        <select
                          aria-label={`Cuenta para el ticket ${t.ticket}`}
                          className={CLASE_SELECT}
                          value={eleccion[k] ?? ""}
                          onChange={(e) => setEleccion((x) => ({ ...x, [k]: e.target.value }))}
                        >
                          <option value="">{t.cuenta_id ? "Cambiar a…" : "Elige la cuenta…"}</option>
                          {deLaMesa.length > 0 && (
                            <optgroup label="De esa mesa">
                              {deLaMesa.map((c) => (
                                <option key={c.cuenta_id} value={c.cuenta_id}>
                                  {c.cliente_nombre} · {horaCorta(c.abierta_en)}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          <optgroup label={deLaMesa.length ? "Otras mesas" : "Cuentas de la noche"}>
                            {otras.map((c) => (
                              <option key={c.cuenta_id} value={c.cuenta_id}>
                                Mesa {c.mesa_numero} · {c.cliente_nombre}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" className="h-10" disabled={ocupado || !eleccion[k]} onClick={() => asignar(t, eleccion[k])}>
                            {t.cuenta_id ? "Reasignar" : "Asignar"}
                          </Button>
                          {t.cuenta_id && (
                            <Button type="button" variant="outline" className="h-10" disabled={ocupado} onClick={() => asignar(t, null)}>
                              Quitar cuenta
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Esa noche no tiene cuentas en caja.</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
