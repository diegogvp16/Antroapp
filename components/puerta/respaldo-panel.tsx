"use client";

// En el panel de staff, debajo de "Escanear QR" (bandera `escaner_respaldo`):
// mantiene al día la copia de esta noche para escanear sin señal y dice de
// cuándo es. Con la bandera apagada no muestra nada (y borra cualquier copia
// que hubiera quedado en el teléfono).

import { useEffect } from "react";
import { CloudOff, ShieldCheck } from "lucide-react";
import { copiaVieja } from "@/lib/domain/puerta-respaldo";
import { EVENTO_ENVIADAS, useCopiaPuerta, useSesionUsuario } from "@/lib/use-puerta-respaldo";
import { useEnLinea } from "@/lib/use-en-linea";

const hora = (iso: string) => new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// onEnviadas: entradas guardadas sin señal llegaron a la base (recargar la lista).
export function RespaldoPuertaPanel({
  clubId,
  activa,
  listo,
  onEnviadas,
}: {
  clubId: string;
  activa: boolean;
  listo: boolean;
  onEnviadas: () => void;
}) {
  const enLinea = useEnLinea();
  const { usuarioId } = useSesionUsuario();
  const { copia, error } = useCopiaPuerta({ usuarioId, clubId, activa, listo });
  useEffect(() => {
    window.addEventListener(EVENTO_ENVIADAS, onEnviadas);
    return () => window.removeEventListener(EVENTO_ENVIADAS, onEnviadas);
  }, [onEnviadas]);
  if (!activa) return null;

  const porEntrar = copia ? copia.reservas.filter((r) => !r.entro).length : 0;
  const vieja = copia ? copiaVieja(copia, new Date()) : false;
  const malo = !copia || copia.truncada || (!enLinea && vieja);
  return (
    <p
      className={`-mt-3 flex items-start gap-2 text-xs ${malo ? "text-status-warn" : "text-muted-foreground"}`}
      data-prueba="copia-puerta"
      role="status"
    >
      {enLinea ? <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <CloudOff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0">
        {copia
          ? `Sin señal se puede escanear: copia de las ${hora(copia.generadaEn)} con ${porEntrar} ${porEntrar === 1 ? "reserva" : "reservas"} por entrar.`
          : enLinea
            ? error ?? "Preparando la copia para escanear sin señal…"
            : "Sin señal y sin copia de la noche: el escáner no puede validar hasta que vuelva la señal."}
        {copia && !enLinea && vieja && " Es vieja: las reservas hechas después no aparecen."}
        {copia?.truncada &&
          ` La noche tiene ${copia.total} reservas y la copia trae ${copia.reservas.length}: algunas no aparecen sin señal.`}
      </span>
    </p>
  );
}
