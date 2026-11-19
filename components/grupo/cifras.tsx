"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatearCentavos } from "@/lib/domain/caja";
import {
  nombreZona,
  porcentajeEntrada,
  textoPorcentaje,
  type ResumenAntro,
  type TotalesGrupo,
} from "@/lib/domain/grupo";
import { cn } from "@/lib/utils";

// Una cifra con su etiqueta arriba.
function Cifra({
  etiqueta,
  valor,
  detalle,
  grande = false,
}: {
  etiqueta: string;
  valor: string;
  detalle?: string;
  grande?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{etiqueta}</span>
      <span
        className={cn(
          "font-semibold break-words tabular-nums",
          grande ? "text-xl" : "text-base",
        )}
      >
        {valor}
      </span>
      {detalle && <span className="text-xs text-muted-foreground tabular-nums">{detalle}</span>}
    </div>
  );
}

// Totales de todo el rango para los antros que ve la persona.
export function TotalesDelGrupo({ totales }: { totales: TotalesGrupo }) {
  const pct = porcentajeEntrada(totales.entraron, totales.reservas);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Total{totales.antros > 1 ? ` de ${totales.antros} antros` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
        <Cifra etiqueta="Reservas" valor={String(totales.reservas)} grande />
        <Cifra
          etiqueta="Entraron"
          valor={String(totales.entraron)}
          detalle={`${textoPorcentaje(pct)} de entrada`}
          grande
        />
        <Cifra etiqueta="Consumo" valor={formatearCentavos(totales.consumo_centavos)} grande />
        <Cifra
          etiqueta="Ticket promedio"
          valor={formatearCentavos(totales.ticket_promedio_centavos)}
          detalle={`${totales.cuentas_con_consumo} ${totales.cuentas_con_consumo === 1 ? "cuenta" : "cuentas"} con consumo`}
        />
        <Cifra etiqueta="Comisiones" valor={formatearCentavos(totales.comisiones_centavos)} />
        <Cifra etiqueta="Noches cerradas" valor={String(totales.noches_cerradas)} />
      </CardContent>
    </Card>
  );
}

// Tarjeta de un antro con sus cifras del rango.
export function TarjetaAntro({ antro }: { antro: ResumenAntro }) {
  const pct = porcentajeEntrada(antro.entraron, antro.reservas);
  const zona = nombreZona(antro.zona_horaria);
  return (
    <Card size="sm">
      <CardHeader className="px-4">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="min-w-0 break-words">{antro.nombre}</CardTitle>
          {!antro.publicado && <Badge variant="warn">No publicado</Badge>}
        </div>
        {zona && <p className="text-xs text-muted-foreground">{zona}</p>}
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 sm:grid-cols-3">
        <Cifra etiqueta="Reservas" valor={String(antro.reservas)} />
        <Cifra
          etiqueta="Entraron"
          valor={String(antro.entraron)}
          detalle={`${textoPorcentaje(pct)} de entrada`}
        />
        <Cifra etiqueta="Consumo" valor={formatearCentavos(antro.consumo_centavos)} />
        <Cifra
          etiqueta="Ticket promedio"
          valor={formatearCentavos(antro.ticket_promedio_centavos)}
          detalle={`${antro.cuentas_con_consumo} ${antro.cuentas_con_consumo === 1 ? "cuenta" : "cuentas"}`}
        />
        <Cifra etiqueta="Comisiones" valor={formatearCentavos(antro.comisiones_centavos)} />
        <Cifra etiqueta="Noches cerradas" valor={String(antro.noches_cerradas)} />
      </CardContent>
    </Card>
  );
}
