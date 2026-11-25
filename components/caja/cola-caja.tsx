"use client";

import Link from "next/link";
import { CloudUpload, LogIn, TriangleAlert, Users } from "lucide-react";
import { formatearCentavos, horaCorta } from "@/lib/domain/caja";
import { textoDeOtraCuenta, textoPorEnviar, type MovimientoPendiente } from "@/lib/domain/caja-cola";

// Lo capturado sin señal, a la vista: cuánto falta por enviar (en la lista
// de mesas) y lo que la base no aceptó al mandarlo, con su motivo. Lo
// rechazado no se reintenta solo: se queda aquí hasta que alguien lo revise
// y toque "Entendido".

const BOTON = "h-11 rounded-md border border-caja-control px-3 text-sm";

export function etiquetaMovimiento(x: MovimientoPendiente): string {
  return x.tipo === "pago" ? x.descripcion : `Consumo · ${x.descripcion}`;
}

export function AvisoCola({
  movimientos,
  persistente,
  enviando,
  sinConexion,
  nombreDeMesa,
  onVerMesa,
  onDescartar,
  onEnviarAhora,
  deOtraCuenta = 0,
}: {
  movimientos: MovimientoPendiente[];
  persistente: boolean;
  enviando: boolean;
  sinConexion: boolean;
  nombreDeMesa: (mesaId: string) => string;
  onVerMesa: (mesaId: string) => void;
  onDescartar: (claves: string[]) => void;
  onEnviarAhora: () => void;
  // Pendientes que dejó otra cuenta en este teléfono (solo el número).
  deOtraCuenta?: number;
}) {
  const pendientes = movimientos.filter((x) => x.estado === "pendiente");
  const rechazados = movimientos.filter((x) => x.estado === "rechazado");
  if (pendientes.length === 0 && rechazados.length === 0 && deOtraCuenta === 0) return null;
  const mesas = new Set(pendientes.map((x) => x.mesaId)).size;
  return (
    <div className="flex flex-col gap-2">
      {deOtraCuenta > 0 && (
        <p role="status" className="rounded-lg border border-caja-borde bg-caja-superficie px-3 py-2 text-xs text-caja-secundario">
          {textoDeOtraCuenta(deOtraCuenta)}
        </p>
      )}
      {pendientes.length > 0 && (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-caja-aviso/60 bg-caja-superficie px-3 py-2 text-sm">
          <div className="flex items-start gap-2">
            <CloudUpload className="mt-0.5 size-4 shrink-0 text-caja-aviso" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              <span className="font-medium">
                {textoPorEnviar(pendientes.length)}
                {mesas > 1 ? ` · ${mesas} mesas` : ""}
              </span>
              <span className="block text-xs text-caja-secundario">
                {sinConexion
                  ? "Guardados en este teléfono. Se envían solos al volver la señal."
                  : enviando
                    ? "Enviando…"
                    : "La señal sigue fallando. Se reintenta solo."}
              </span>
            </p>
            {!sinConexion && !enviando && (
              <button type="button" onClick={onEnviarAhora} className={BOTON}>
                Enviar ahora
              </button>
            )}
          </div>
          {!persistente && (
            <p className="text-xs text-caja-aviso">
              Este teléfono no deja guardar datos de la app: no la cierres ni la recargues hasta que se envíen.
            </p>
          )}
        </div>
      )}
      {rechazados.length > 0 && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-caja-rojo/70 bg-caja-superficie px-3 py-2 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0 text-caja-rojo" aria-hidden="true" />
            {rechazados.length === 1 ? "1 movimiento no se guardó" : `${rechazados.length} movimientos no se guardaron`}
          </p>
          <p className="text-xs text-caja-secundario">
            No quedó en la cuenta de la mesa. Avísale a tu gerente antes de volver a capturarlo o de cobrarlo.
          </p>
          <ul className="flex flex-col divide-y divide-caja-borde">
            {rechazados.map((x) => (
              <li key={x.clave} className="flex flex-col gap-1.5 py-2">
                <p className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {nombreDeMesa(x.mesaId)} · {etiquetaMovimiento(x)}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatearCentavos(x.montoCentavos)}</span>
                </p>
                <p className="text-xs text-caja-secundario">
                  Capturado a las {horaCorta(x.capturadoEn)} · {x.motivo}
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => onVerMesa(x.mesaId)} className={BOTON}>
                    Ver mesa
                  </button>
                  <button type="button" onClick={() => onDescartar([x.clave])} className={BOTON}>
                    Entendido
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// En el detalle de la mesa: lo rechazado de esta mesa y lo pendiente de un
// grupo que ya no es el actual (se va a rechazar al enviarlo).
export function AvisoColaMesa({
  movimientos,
  sesionActual,
  onDescartar,
}: {
  movimientos: MovimientoPendiente[];
  sesionActual: string | null;
  onDescartar: (claves: string[]) => void;
}) {
  const rechazados = movimientos.filter((x) => x.estado === "rechazado");
  const deOtroGrupo = movimientos.filter((x) => x.estado === "pendiente" && x.sesionId !== sesionActual);
  if (rechazados.length === 0 && deOtroGrupo.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {deOtroGrupo.length > 0 && (
        <p role="status" className="rounded-lg border border-caja-aviso/60 px-3 py-2 text-sm">
          {textoPorEnviar(deOtroGrupo.length)} de un grupo anterior de esta mesa. Al volver la señal la base decide si los acepta.
        </p>
      )}
      {rechazados.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-caja-rojo/70 px-3 py-2 text-sm">
          <p className="font-medium">No se guardó al enviarlo</p>
          <ul className="flex flex-col divide-y divide-caja-borde">
            {rechazados.map((x) => (
              <li key={x.clave} className="flex flex-col gap-1 py-2">
                <p className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">{etiquetaMovimiento(x)}</span>
                  <span className="shrink-0 tabular-nums">{formatearCentavos(x.montoCentavos)}</span>
                </p>
                <p className="text-xs text-caja-secundario">{x.motivo}</p>
                <button type="button" onClick={() => onDescartar([x.clave])} className={`${BOTON} w-fit`}>
                  Entendido
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// La sesión del teléfono ya no es la de quien abrió la caja: se tapa la caja
// (sus lecturas y botones irían con otra sesión o con ninguna). Lo pendiente
// sigue guardado a nombre de quien lo capturó y se envía cuando vuelva a
// entrar.
export function AvisoSesionCaja({
  estado,
  pendientes,
  onReabrir,
}: {
  estado: "vencida" | "otra_cuenta";
  pendientes: number;
  onReabrir: () => void;
}) {
  const guardado =
    pendientes === 0
      ? null
      : pendientes === 1
        ? "Tienes 1 movimiento de caja guardado en este teléfono: no se pierde y se envía cuando vuelvas a entrar con tu cuenta."
        : `Tienes ${pendientes} movimientos de caja guardados en este teléfono: no se pierden y se envían cuando vuelvas a entrar con tu cuenta.`;
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-caja-aviso/60 bg-caja-superficie px-4 py-4 text-sm">
      <p className="flex items-start gap-2 font-medium">
        {estado === "otra_cuenta" ? (
          <Users className="mt-0.5 size-4 shrink-0 text-caja-aviso" aria-hidden="true" />
        ) : (
          <LogIn className="mt-0.5 size-4 shrink-0 text-caja-aviso" aria-hidden="true" />
        )}
        {estado === "otra_cuenta" ? "Entró otra cuenta en este teléfono" : "Tu sesión se cerró"}
      </p>
      <p className="text-caja-secundario">
        {estado === "otra_cuenta"
          ? "La caja se abrió con otra cuenta en otra pestaña. Para no registrar nada a nombre de otra persona, esta pantalla se detuvo."
          : "Vuelve a entrar con tu cuenta para seguir usando la caja."}
      </p>
      {guardado && <p className="font-medium text-caja-aviso">{guardado}</p>}
      {estado === "otra_cuenta" ? (
        <button type="button" onClick={onReabrir} className={`${BOTON} w-full`}>
          Abrir la caja con la cuenta de ahora
        </button>
      ) : (
        <Link href="/cliente/login" className={`${BOTON} flex w-full items-center justify-center`}>
          Entrar otra vez
        </Link>
      )}
    </div>
  );
}
