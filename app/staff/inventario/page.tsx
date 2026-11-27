"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilaMonto } from "@/components/caja/accion";
import { SelectorNoche } from "@/components/inventario/selector-noche";
import { formatearCentavos } from "@/lib/domain/caja";
import { bajoStock, conMovimiento, textoExistencias, totalesReporteInventario, type FilaReporteInventario } from "@/lib/domain/inventario";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { useFase2DeClub } from "@/lib/fase2-contexto";
import { useEntradaGerente } from "@/lib/fase2-pagina";
import { cn } from "@/lib/utils";

// Reporte de inventario por noche (bloque 8, inventario_reporte_noche): qué
// se vendió de cada producto, qué se anuló, entradas, mermas y diferencias de
// conteo, con las existencias de ahora. Solo gerente, con la bandera
// «inventario» del antro.
export default function InventarioPage() {
  const entrada = useEntradaGerente();
  const clubEntrada = entrada.tipo === "listo" ? entrada.clubId : null;
  const banderas = useFase2DeClub(clubEntrada);
  const clubId = banderas.inventario ? clubEntrada : null;
  const [fecha, setFecha] = useState<string | null>(null);
  const [filas, setFilas] = useState<FilaReporteInventario[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [todo, setTodo] = useState(false);

  useEffect(() => {
    if (entrada.tipo === "listo" && fecha === null) setFecha(entrada.nocheHoy);
  }, [entrada, fecha]);

  const cargar = useCallback(async () => {
    if (!clubId || !fecha) return;
    setFilas(null);
    const { data, error: e } = await createClient().rpc("inventario_reporte_noche", { p_club_id: clubId, p_fecha: fecha });
    if (e) {
      setError(mensajeParaUsuario(e, "No pudimos cargar el reporte. Intenta de nuevo."));
      return;
    }
    setError(null);
    setFilas((data ?? []) as FilaReporteInventario[]);
  }, [clubId, fecha]);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const t = totalesReporteInventario(filas ?? []);
  const visibles = (filas ?? []).filter((f) => todo || conMovimiento(f));
  const sinBandera = entrada.tipo === "listo" && !banderas.cargando && !banderas.inventario;

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <Link href="/staff/panel" className="-ml-2 flex h-11 w-fit items-center px-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          ← Panel
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reporte de inventario</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Lo que se movió de cada producto en una noche: ventas de la caja, cargos anulados, entradas, mermas y diferencias de conteo.
          </p>
        </div>

        {(entrada.tipo === "apagado" || sinBandera) && <p className="text-sm text-muted-foreground">El inventario todavía no está activo en tu antro.</p>}
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
            {filas === null && !error && <p className="text-sm text-muted-foreground">Cargando…</p>}
            {filas && (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>Resumen de la noche</CardTitle>
                    <CardDescription>Solo productos del catálogo. Lo capturado como «otro concepto» no descuenta inventario.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-1 text-sm">
                    <FilaMonto etiqueta="Vendido (catálogo)" valor={formatearCentavos(t.vendido_centavos)} fuerte />
                    <FilaMonto etiqueta="Piezas vendidas" valor={String(t.vendidos)} />
                    <FilaMonto etiqueta="Piezas anuladas (regresaron)" valor={String(t.anulados)} />
                    <FilaMonto etiqueta="Entradas" valor={String(t.entradas)} />
                    <FilaMonto etiqueta="Mermas" valor={String(t.mermas)} className={cn(t.mermas > 0 && "text-status-warn")} />
                    <FilaMonto etiqueta="Productos con existencias bajas (hoy)" valor={String(t.bajos)} className={cn(t.bajos > 0 && "text-status-warn")} />
                  </CardContent>
                </Card>

                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" checked={todo} onChange={(e) => setTodo(e.target.checked)} className="size-5" />
                  Ver todo el catálogo (no solo lo que se movió)
                </label>

                {visibles.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    Esa noche no se movió ningún producto del catálogo.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {visibles.map((f) => (
                      <li key={f.producto_id} className="flex flex-col gap-1 px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className={cn("min-w-0 font-medium", !f.activo && "text-muted-foreground line-through")}>{f.nombre}</span>
                          <span className="tabular-nums">{formatearCentavos(Number(f.vendido_centavos))}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{f.categoria}</span>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
                          <span>Vendidas {f.vendidos}</span>
                          {f.anulados > 0 && <span>Anuladas {f.anulados}</span>}
                          {f.entradas > 0 && <span className="text-status-ok">Entradas +{f.entradas}</span>}
                          {f.mermas > 0 && <span className="text-status-warn">Mermas −{f.mermas}</span>}
                          {f.diferencias !== 0 && (
                            <span className="text-status-warn">
                              Conteo {f.diferencias > 0 ? "+" : ""}
                              {f.diferencias}
                            </span>
                          )}
                          <span className={cn("ml-auto", f.activo && bajoStock(f) ? "font-medium text-status-warn" : "text-muted-foreground")}>
                            Hoy: {textoExistencias(f).toLowerCase()}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <Button render={<Link href="/staff/catalogo" />} nativeButton={false} variant="outline" className="h-11 w-full">
                  Ir al catálogo (entradas, mermas y conteos)
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
