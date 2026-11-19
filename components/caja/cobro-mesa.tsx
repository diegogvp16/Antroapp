"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AccionConMotivo,
  MensajeError,
  SELECT_CLASSES,
  useAccion,
} from "@/components/caja/accion";
import { cn } from "@/lib/utils";
import {
  centavosATexto,
  formatearCentavos,
  horaCorta,
  METODO_LABEL,
  METODOS_PAGO,
  montoValido,
  nombreODefault,
  pesosACentavos,
  type CajaPago,
  type MesaCuenta,
  type MetodoPago,
} from "@/lib/domain/caja";

// Lista de pagos de la sesión (con anulación) y captura de un pago nuevo.
// La app no cobra al cliente: aquí solo se registra lo que el antro cobró.
export function CobroMesa({
  sesionId,
  cuentas,
  pagos,
  saldo,
  nombres,
  editable,
  puedeCobrar,
  puedeAnular,
  onCambio,
}: {
  sesionId: string;
  cuentas: MesaCuenta[];
  pagos: CajaPago[];
  saldo: number;
  nombres: Record<string, string>;
  editable: boolean;
  puedeCobrar: boolean;
  puedeAnular: boolean;
  onCambio: () => Promise<void>;
}) {
  const { error, ejecutar } = useAccion();
  const nombreCuenta = (id: string | null) =>
    id ? (cuentas.find((c) => c.id === id)?.cliente_nombre ?? "Cuenta") : "Toda la mesa";

  return (
    <div className="flex flex-col gap-3">
      {pagos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay pagos registrados.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border text-sm">
          {pagos.map((p) => (
            <li key={p.id} className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-2">
                <div className={cn("min-w-0", p.anulado && "text-muted-foreground line-through")}>
                  <p className="break-words">
                    {METODO_LABEL[p.metodo]} · {nombreCuenta(p.cuenta_id)}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 tabular-nums",
                    p.anulado && "text-muted-foreground line-through",
                  )}
                >
                  {formatearCentavos(p.monto_centavos)}
                </span>
              </div>
              <p className="text-xs break-words text-muted-foreground">
                {p.referencia ? `Ref. ${p.referencia} · ` : ""}
                {nombreODefault(nombres, p.registrado_por, "Equipo")} · {horaCorta(p.registrado_en)}
              </p>
              {p.anulado ? (
                <p className="text-xs break-words text-status-err">
                  Anulado por {nombreODefault(nombres, p.anulado_por, "Equipo")}
                  {p.anulado_en ? ` · ${horaCorta(p.anulado_en)}` : ""}: {p.motivo_anulacion}
                </p>
              ) : (
                editable &&
                puedeAnular && (
                  <AccionConMotivo
                    etiqueta="Anular"
                    etiquetaConfirmar="Anular pago"
                    placeholder="Motivo de la anulación"
                    variante="destructive"
                    onConfirmar={(motivo) =>
                      ejecutar(
                        () =>
                          createClient().rpc("caja_anular_pago", {
                            p_pago_id: p.id,
                            p_motivo: motivo,
                          }),
                        onCambio,
                      )
                    }
                  />
                )
              )}
            </li>
          ))}
        </ul>
      )}

      <MensajeError mensaje={error} />

      {editable && puedeCobrar && (
        <RegistrarPago sesionId={sesionId} cuentas={cuentas} saldo={saldo} onCambio={onCambio} />
      )}
    </div>
  );
}

function RegistrarPago({
  sesionId,
  cuentas,
  saldo,
  onCambio,
}: {
  sesionId: string;
  cuentas: MesaCuenta[];
  saldo: number;
  onCambio: () => Promise<void>;
}) {
  const [metodo, setMetodo] = useState<MetodoPago>("efectivo");
  const [monto, setMonto] = useState("");
  const [cuentaId, setCuentaId] = useState("");
  const [referencia, setReferencia] = useState("");
  const { ocupado, error, ejecutar } = useAccion();

  const centavos = pesosACentavos(monto);
  const valido = montoValido(centavos);
  const excede = valido && centavos > saldo;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!montoValido(centavos)) return;
        const ok = await ejecutar(
          () =>
            createClient().rpc("caja_registrar_pago", {
              p_sesion_id: sesionId,
              p_cuenta_id: cuentaId || null,
              p_metodo: metodo,
              p_monto_centavos: centavos,
              p_referencia: referencia.trim() || null,
            }),
          onCambio,
        );
        if (ok) {
          setMonto("");
          setReferencia("");
        }
      }}
    >
      <p className="font-medium">Registrar pago</p>

      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Método">
        {METODOS_PAGO.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={metodo === m}
            onClick={() => setMetodo(m)}
            className={cn(
              "h-7 rounded-md text-sm font-medium text-muted-foreground",
              metodo === m && "bg-background text-foreground shadow-sm",
            )}
          >
            {METODO_LABEL[m]}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`pago-monto-${sesionId}`}>Monto ($)</Label>
        <div className="flex gap-2">
          <Input
            id={`pago-monto-${sesionId}`}
            inputMode="decimal"
            placeholder="0.00"
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            aria-invalid={monto.length > 0 && !valido}
          />
          {saldo > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setMonto(centavosATexto(saldo))}
            >
              Saldo
            </Button>
          )}
        </div>
        {monto.length > 0 && !valido && (
          <p className="text-xs text-muted-foreground">
            Escribe un monto entre $0.01 y $1,000,000 (ej. 1250.50).
          </p>
        )}
        {excede && (
          <p className="text-xs text-status-warn">
            Es más que el saldo ({formatearCentavos(saldo)}): la mesa quedaría cobrada de más.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`pago-cuenta-${sesionId}`}>Cuenta</Label>
        <select
          id={`pago-cuenta-${sesionId}`}
          className={SELECT_CLASSES}
          value={cuentaId}
          onChange={(e) => setCuentaId(e.target.value)}
        >
          <option value="">Toda la mesa</option>
          {cuentas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.cliente_nombre}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`pago-ref-${sesionId}`}>Referencia</Label>
        <Input
          id={`pago-ref-${sesionId}`}
          placeholder="Opcional (ej. últimos 4 dígitos)"
          maxLength={120}
          value={referencia}
          onChange={(e) => setReferencia(e.target.value)}
        />
      </div>

      <MensajeError mensaje={error} />

      <Button type="submit" disabled={!valido || ocupado}>
        {ocupado ? "Guardando..." : "Registrar pago"}
      </Button>
    </form>
  );
}
