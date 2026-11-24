"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RendimientoPorRp } from "@/components/grupo/rendimiento-rp";
import { formatearCentavos } from "@/lib/domain/caja";
import {
  conversion,
  nombreZona,
  porcentajeEntrada,
  reservasOcurridas,
  textoPorcentaje,
  type ResumenAntro,
  type TotalesGrupo,
} from "@/lib/domain/grupo";
import type { RangoNoches } from "@/lib/fechas";
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
      <span className={cn("font-semibold break-words tabular-nums", grande ? "text-xl" : "text-base")}>{valor}</span>
      {detalle && <span className="text-xs text-muted-foreground tabular-nums">{detalle}</span>}
    </div>
  );
}

// Las mismas cifras para el total y para cada antro. Los porcentajes se
// sacan sobre las reservas que ya podían llegar (sin las de noches que
// todavía no empiezan).
type Numeros = Pick<
  TotalesGrupo,
  | "reservas"
  | "entraron"
  | "cuentas_con_consumo"
  | "consumo_centavos"
  | "ticket_promedio_centavos"
  | "comisiones_centavos"
  | "noches_cerradas"
  | "reservas_por_venir"
  | "reservas_con_consumo"
  | "consumo_con_reserva_centavos"
  | "reservas_noches_cerradas"
  | "consumieron_noches_cerradas"
>;

function Cifras({ n, grande }: { n: Numeros; grande: boolean }) {
  const ocurridas = reservasOcurridas(n.reservas, n.reservas_por_venir);
  const pctEntrada = porcentajeEntrada(n.entraron, ocurridas);
  const pctConversion = conversion(n.consumieron_noches_cerradas, n.reservas_noches_cerradas);
  return (
    <>
      <Cifra
        etiqueta="Reservas"
        valor={String(n.reservas)}
        detalle={n.reservas_por_venir ? `${n.reservas_por_venir} por venir` : undefined}
        grande={grande}
      />
      <Cifra etiqueta="Entraron" valor={String(n.entraron)} detalle={`${textoPorcentaje(pctEntrada)} de entrada`} grande={grande} />
      {n.reservas_con_consumo !== null && (
        <Cifra
          etiqueta="Consumieron"
          valor={String(n.reservas_con_consumo)}
          detalle={`${textoPorcentaje(pctConversion)} de conversión (noches cerradas)`}
          grande={grande}
        />
      )}
      <Cifra
        etiqueta="Consumo en caja"
        valor={formatearCentavos(n.consumo_centavos)}
        detalle={n.consumo_con_reserva_centavos !== null ? `${formatearCentavos(n.consumo_con_reserva_centavos)} con reserva` : undefined}
        grande={grande}
      />
      <Cifra
        etiqueta="Ticket promedio por cuenta"
        valor={formatearCentavos(n.ticket_promedio_centavos)}
        detalle={`${n.cuentas_con_consumo} ${n.cuentas_con_consumo === 1 ? "cuenta" : "cuentas"} con consumo`}
      />
      <Cifra etiqueta="Comisiones y pagos a RPs" valor={formatearCentavos(n.comisiones_centavos)} />
      <Cifra etiqueta="Noches cerradas" valor={String(n.noches_cerradas)} />
    </>
  );
}

// Totales de todo el rango para los antros que ve la persona.
export function TotalesDelGrupo({ totales }: { totales: TotalesGrupo }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Total{totales.antros > 1 ? ` de ${totales.antros} antros` : ""}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
        <Cifras n={totales} grande />
      </CardContent>
    </Card>
  );
}

// Tarjeta de un antro con sus cifras del rango y su rendimiento por RP.
export function TarjetaAntro({
  antro,
  rango,
  rendimientoAbierto = false,
}: {
  antro: ResumenAntro;
  rango: RangoNoches;
  rendimientoAbierto?: boolean;
}) {
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
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Cifras n={antro} grande={false} />
        </div>
        <RendimientoPorRp clubId={antro.club_id} rango={rango} abiertoAlInicio={rendimientoAbierto} />
      </CardContent>
    </Card>
  );
}
