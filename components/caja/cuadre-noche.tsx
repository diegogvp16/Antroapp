"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FilaMonto, MensajeError, useAccion } from "@/components/caja/accion";
import { cn } from "@/lib/utils";
import {
  diferenciaConteo,
  ESTADO_MESA_BADGE,
  ESTADO_MESA_LABEL,
  formatearCentavos,
  horaCorta,
  METODO_LABEL,
  METODOS_PAGO,
  nombreODefault,
  pesosACentavos,
  resumen,
  sumaMetodos,
  type CajaCuadre,
  type DatosCaja,
  type MetodoPago,
  type TotalesPorMetodo,
} from "@/lib/domain/caja";

// Cuadre general de la noche: totales registrados y cobrados por método,
// mesas pendientes de cuadrar, conteo físico y cierre. Los totales que se
// guardan los calcula la base al cerrar; aquí solo se muestran en vivo.
export function CuadreNoche({
  datos,
  onCambio,
}: {
  datos: DatosCaja;
  onCambio: () => Promise<void>;
}) {
  const { noche } = datos;

  if (!noche) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Todavía no se abre ninguna mesa esta noche: no hay nada que cuadrar.
      </p>
    );
  }

  if (noche.estado === "cerrada") {
    const cuadre = datos.cuadres.find((c) => c.tipo === "noche");
    return <CuadreGuardado cuadre={cuadre ?? null} nombres={datos.nombres} />;
  }

  return <CuadreEnVivo nocheId={noche.id} datos={datos} onCambio={onCambio} />;
}

function CuadreEnVivo({
  nocheId,
  datos,
  onCambio,
}: {
  nocheId: string;
  datos: DatosCaja;
  onCambio: () => Promise<void>;
}) {
  const [conteo, setConteo] = useState<Record<MetodoPago, string>>({
    efectivo: "",
    tarjeta: "",
    otro: "",
  });
  const [notas, setNotas] = useState("");
  const { ocupado, error, ejecutar } = useAccion();

  const totales = resumen(datos.consumos, datos.pagos);
  const pendientes = datos.sesiones.filter((s) => s.estado !== "cuadrada");
  const numeroMesa = (mesaId: string) =>
    datos.mesas.find((m) => m.id === mesaId)?.numero ?? "?";

  const contado: Partial<TotalesPorMetodo> = {};
  for (const m of METODOS_PAGO) {
    const c = pesosACentavos(conteo[m]);
    if (c !== null) contado[m] = c;
  }
  const conteoCompleto = METODOS_PAGO.every((m) => contado[m] !== undefined);
  const contadoTotal: TotalesPorMetodo = {
    efectivo: contado.efectivo ?? 0,
    tarjeta: contado.tarjeta ?? 0,
    otro: contado.otro ?? 0,
  };
  const diferencia = diferenciaConteo(contadoTotal, totales.porMetodo);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Registrado y cobrado</CardTitle>
          <CardDescription>Consumos y pagos vigentes de toda la noche.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <FilaMonto etiqueta="Registrado" valor={formatearCentavos(totales.consumido)} fuerte />
          {METODOS_PAGO.map((m) => (
            <FilaMonto
              key={m}
              etiqueta={`Cobrado en ${METODO_LABEL[m].toLowerCase()}`}
              valor={formatearCentavos(totales.porMetodo[m])}
            />
          ))}
          <FilaMonto etiqueta="Total cobrado" valor={formatearCentavos(totales.cobrado)} fuerte />
          <FilaMonto
            etiqueta="Sin cobrar"
            valor={formatearCentavos(totales.saldo)}
            className={cn(totales.saldo !== 0 && "text-status-warn")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mesas pendientes de cuadrar</CardTitle>
        </CardHeader>
        <CardContent>
          {pendientes.length === 0 ? (
            <p className="text-sm text-status-ok">Todas las mesas de la noche están cuadradas.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {pendientes.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm"
                >
                  <span className="font-medium">Mesa {numeroMesa(s.mesa_id)}</span>
                  <Badge variant={ESTADO_MESA_BADGE[s.estado]}>{ESTADO_MESA_LABEL[s.estado]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conteo físico</CardTitle>
          <CardDescription>
            Lo que hay en caja y en los cortes de terminal. Escribe 0 si no hubo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!conteoCompleto || pendientes.length > 0) return;
              await ejecutar(
                () =>
                  createClient().rpc("caja_cerrar_noche", {
                    p_noche_id: nocheId,
                    p_contado_efectivo_centavos: contadoTotal.efectivo,
                    p_contado_tarjeta_centavos: contadoTotal.tarjeta,
                    p_contado_otro_centavos: contadoTotal.otro,
                    p_notas: notas.trim() || null,
                  }),
                onCambio,
              );
            }}
          >
            {METODOS_PAGO.map((m) => {
              const invalido = conteo[m].length > 0 && contado[m] === undefined;
              const dif = (contado[m] ?? 0) - totales.porMetodo[m];
              return (
                <div key={m} className="flex flex-col gap-1.5">
                  <Label htmlFor={`conteo-${m}`}>{METODO_LABEL[m]} ($)</Label>
                  <Input
                    id={`conteo-${m}`}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={conteo[m]}
                    onChange={(e) => setConteo((prev) => ({ ...prev, [m]: e.target.value }))}
                    aria-invalid={invalido}
                    className="h-11"
                  />
                  {invalido ? (
                    <p className="text-xs text-muted-foreground">Monto no válido (ej. 1250.50).</p>
                  ) : (
                    contado[m] !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        Cobrado {formatearCentavos(totales.porMetodo[m])} ·{" "}
                        <TextoDiferencia centavos={dif} />
                      </p>
                    )
                  )}
                </div>
              );
            })}

            <div className="rounded-md border border-border px-3 py-2 text-sm">
              <FilaMonto etiqueta="Total contado" valor={formatearCentavos(sumaMetodos(contadoTotal))} />
              <div className="flex items-baseline justify-between gap-3 font-semibold">
                <span>Diferencia</span>
                {conteoCompleto ? (
                  <TextoDiferencia centavos={diferencia} />
                ) : (
                  <span className="text-muted-foreground">Captura los tres montos</span>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="notas-noche">Notas</Label>
              <Input
                id="notas-noche"
                placeholder="Opcional (ej. explica un faltante)"
                maxLength={500}
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                className="h-11"
              />
            </div>

            {pendientes.length > 0 && (
              <p className="text-sm text-status-warn">
                {pendientes.length === 1
                  ? "Para cerrar la noche, primero cuadra la mesa pendiente."
                  : `Para cerrar la noche, primero cuadra las ${pendientes.length} mesas pendientes.`}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Cerrar la noche es definitivo: después ya no se abren mesas ni se registra nada en
              esta fecha.
            </p>
            <MensajeError mensaje={error} />
            <Button
              type="submit"
              size="lg"
              className="h-12 text-base"
              disabled={!conteoCompleto || pendientes.length > 0 || ocupado}
            >
              {ocupado ? "Cerrando..." : "Cerrar la noche"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function CuadreGuardado({
  cuadre,
  nombres,
}: {
  cuadre: CajaCuadre | null;
  nombres: Record<string, string>;
}) {
  if (!cuadre) {
    return (
      <p className="text-sm text-muted-foreground">
        La noche está cerrada, pero no se pudo leer su cuadre.
      </p>
    );
  }
  const filas: { metodo: MetodoPago; cobrado: number; contado: number | null }[] = [
    { metodo: "efectivo", cobrado: cuadre.cobrado_efectivo_centavos, contado: cuadre.contado_efectivo_centavos },
    { metodo: "tarjeta", cobrado: cuadre.cobrado_tarjeta_centavos, contado: cuadre.contado_tarjeta_centavos },
    { metodo: "otro", cobrado: cuadre.cobrado_otro_centavos, contado: cuadre.contado_otro_centavos },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Noche cerrada</CardTitle>
        <CardDescription>
          Por {nombreODefault(nombres, cuadre.hecho_por, "Equipo")} a las {horaCorta(cuadre.hecho_en)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <FilaMonto etiqueta="Registrado" valor={formatearCentavos(cuadre.registrado_centavos)} fuerte />
          <FilaMonto etiqueta="Sin cobrar" valor={formatearCentavos(cuadre.saldo_sin_cobrar_centavos)} />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">Método</span>
          <span className="text-right text-xs text-muted-foreground">Cobrado</span>
          <span className="text-right text-xs text-muted-foreground">Contado</span>
          {filas.map((f) => (
            <FilaCuadre key={f.metodo} {...f} />
          ))}
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 font-semibold">
          <span>Diferencia</span>
          <TextoDiferencia centavos={cuadre.diferencia_centavos ?? 0} />
        </div>
        {cuadre.notas && <p className="break-words text-muted-foreground">Notas: {cuadre.notas}</p>}
      </CardContent>
    </Card>
  );
}

function FilaCuadre({
  metodo,
  cobrado,
  contado,
}: {
  metodo: MetodoPago;
  cobrado: number;
  contado: number | null;
}) {
  return (
    <>
      <span>{METODO_LABEL[metodo]}</span>
      <span className="text-right tabular-nums">{formatearCentavos(cobrado)}</span>
      <span className="text-right tabular-nums">
        {contado === null ? "—" : formatearCentavos(contado)}
      </span>
    </>
  );
}

// "Cuadra" / "Sobran $X" / "Faltan $X".
function TextoDiferencia({ centavos }: { centavos: number }) {
  if (centavos === 0) return <span className="text-status-ok">Cuadra</span>;
  if (centavos > 0) {
    return <span className="tabular-nums text-status-warn">Sobran {formatearCentavos(centavos)}</span>;
  }
  return <span className="tabular-nums text-status-err">Faltan {formatearCentavos(-centavos)}</span>;
}
