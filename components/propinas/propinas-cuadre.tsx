"use client";

// Propinas de la noche en el cuadre general (bloque 8): las del cobro y las
// sueltas. Solo con la fase 2 y la bandera «propinas» del antro. Van aparte:
// no entran al conteo de caja ni a las comisiones (caja_cerrar_noche no las
// suma). El reparto se hace con la noche cerrada, en /staff/propinas.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilaMonto } from "@/components/caja/accion";
import { useFase2 } from "@/lib/fase2-contexto";
import { formatearCentavos, METODO_LABEL, METODOS_PAGO, type CajaPago } from "@/lib/domain/caja";
import { totalPropinas } from "@/lib/domain/propinas";
import { usePropinasSueltas } from "@/components/propinas/propinas-mesa";

export function PropinasCuadre({ nocheId, pagos }: { nocheId: string; pagos: CajaPago[] }) {
  const { propinas: activa } = useFase2();
  const sueltas = usePropinasSueltas({ nocheId }, activa);
  const t = totalPropinas(pagos, sueltas.lista, sueltas.cobrosAnulados);
  if (!activa || t.total === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Propinas de la noche</CardTitle>
        <CardDescription>Se entregan aparte: no van en el conteo de caja de abajo ni en las comisiones.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">
        {METODOS_PAGO.filter((m) => t.porMetodo[m] > 0).map((m) => (
          <FilaMonto key={m} etiqueta={`En ${METODO_LABEL[m].toLowerCase()}`} valor={formatearCentavos(t.porMetodo[m])} />
        ))}
        <FilaMonto etiqueta="Total de propinas" valor={formatearCentavos(t.total)} fuerte />
      </CardContent>
    </Card>
  );
}
