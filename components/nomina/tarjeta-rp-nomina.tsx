"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AccionConMotivo, FilaMonto, MensajeError, useAccion } from "@/components/caja/accion";
import { formatearCentavos } from "@/lib/domain/caja";
import {
  ESTADO_NOMINA_BADGE,
  ESTADO_NOMINA_LABEL,
  estadosConMonto,
  montoPorEstado,
  nombreRp,
  transicionesDesde,
  type EstadoNomina,
  type FilaNomina,
  type SemanaIso,
  type TransicionNomina,
} from "@/lib/domain/nomina";

// Respuesta de nomina_cambiar_estado: cuántas filas movió de cada tipo.
interface Movidas {
  comisiones: number;
  pagos_dia: number;
}

function esMovidas(x: unknown): x is Movidas {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Movidas).comisiones === "number" &&
    typeof (x as Movidas).pagos_dia === "number"
  );
}

// Tarjeta de un RP en la nómina de la semana: conteos, montos por estado con
// sus botones de transición y total.
export function TarjetaRpNomina({
  fila,
  clubId,
  semana,
  onCambio,
}: {
  fila: FilaNomina;
  clubId: string;
  semana: SemanaIso;
  onCambio: () => Promise<void>;
}) {
  const { ocupado, error, ejecutar } = useAccion();
  const [aviso, setAviso] = useState<string | null>(null);
  const nombre = nombreRp(fila);
  const estados = estadosConMonto(fila);

  async function mover(t: TransicionNomina, motivo: string | null): Promise<boolean> {
    setAviso(null);
    const resultado: { movidas: Movidas | null } = { movidas: null };
    const ok = await ejecutar(async () => {
      const r = await createClient().rpc("nomina_cambiar_estado", {
        p_club_id: clubId,
        p_rp_id: fila.rp_id,
        p_anio: semana.anio,
        p_semana: semana.semana,
        p_desde: t.desde,
        p_hacia: t.hacia,
        p_motivo: motivo,
      });
      if (!r.error && esMovidas(r.data)) resultado.movidas = r.data;
      return r;
    }, onCambio);
    const m = resultado.movidas;
    if (ok && m && m.comisiones === 0 && m.pagos_dia === 0) {
      setAviso(
        `Ya no había nada en "${ESTADO_NOMINA_LABEL[t.desde]}": quizá alguien más lo cambió. La nómina ya se actualizó.`,
      );
    }
    return ok;
  }

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3 px-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 font-medium break-words">{nombre}</h3>
            {!fila.rp_activo && <Badge variant="neutral">Inactivo</Badge>}
          </div>
          <div className="flex shrink-0 flex-col items-end">
            <span className="text-xs text-muted-foreground">Total</span>
            <span className="font-semibold tabular-nums">{formatearCentavos(fila.total_centavos)}</span>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-2 text-center">
          <Conteo etiqueta="Entraron" valor={fila.reservas_entraron} />
          {/* Una por reserva que consumió y ya se cuadró, aunque sea de $0
              porque aún no llegaba a la cuota. */}
          <Conteo etiqueta="Consumieron" valor={fila.comisiones} />
          <Conteo etiqueta="Días" valor={fila.dias_asistidos} />
        </dl>

        {(fila.comision_centavos > 0 || fila.dia_centavos > 0) && (
          <div className="flex flex-col gap-1 text-sm">
            {fila.comision_centavos > 0 && (
              <FilaMonto etiqueta="Comisión" valor={formatearCentavos(fila.comision_centavos)} />
            )}
            {fila.dia_centavos > 0 && (
              <FilaMonto etiqueta="Pago por día" valor={formatearCentavos(fila.dia_centavos)} />
            )}
          </div>
        )}

        {estados.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin montos esta semana.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {estados.map((estado) => (
              <EstadoRp
                key={estado}
                estado={estado}
                monto={montoPorEstado(fila, estado)}
                nombre={nombre}
                ocupado={ocupado}
                onMover={mover}
              />
            ))}
          </ul>
        )}

        <MensajeError mensaje={error} />
        {aviso && <p className="text-sm text-status-warn">{aviso}</p>}
      </CardContent>
    </Card>
  );
}

function Conteo({ etiqueta, valor }: { etiqueta: string; valor: number }) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg bg-muted px-2 py-1.5">
      <dt className="truncate text-xs text-muted-foreground">{etiqueta}</dt>
      <dd className="text-base font-semibold tabular-nums">{valor}</dd>
    </div>
  );
}

// Un estado del RP con su monto y los botones de las transiciones válidas.
function EstadoRp({
  estado,
  monto,
  nombre,
  ocupado,
  onMover,
}: {
  estado: EstadoNomina;
  monto: number;
  nombre: string;
  ocupado: boolean;
  onMover: (t: TransicionNomina, motivo: string | null) => Promise<boolean>;
}) {
  const transiciones = transicionesDesde(estado);
  // Transición final (marcar pagada) que espera confirmación.
  const [confirmando, setConfirmando] = useState<TransicionNomina | null>(null);
  const textoMonto = formatearCentavos(monto);

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <Badge variant={ESTADO_NOMINA_BADGE[estado]}>{ESTADO_NOMINA_LABEL[estado]}</Badge>
        <span className="tabular-nums">{textoMonto}</span>
      </div>

      {confirmando ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            ¿Marcar pagados {textoMonto} a {nombre}? Ya no se puede regresar.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={ocupado}
              onClick={async () => {
                const ok = await onMover(confirmando, null);
                if (ok) setConfirmando(null);
              }}
            >
              {ocupado ? "Guardando..." : "Sí, marcar pagada"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={ocupado}
              onClick={() => setConfirmando(null)}
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        transiciones.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {transiciones.map((t) =>
              t.requiereMotivo ? (
                <AccionConMotivo
                  key={t.hacia}
                  etiqueta={t.etiqueta}
                  etiquetaConfirmar={`Sí, anular ${textoMonto}`}
                  placeholder="Motivo de la anulación"
                  variante="destructive"
                  onConfirmar={(motivo) => onMover(t, motivo)}
                />
              ) : (
                <Button
                  key={t.hacia}
                  type="button"
                  size="sm"
                  variant={t.final ? "default" : "outline"}
                  disabled={ocupado}
                  onClick={() => (t.final ? setConfirmando(t) : onMover(t, null))}
                >
                  {t.etiqueta}
                </Button>
              ),
            )}
          </div>
        )
      )}
    </li>
  );
}
