"use client";

// Código corto del boleto, debajo del QR: si la cámara de la puerta no lo lee
// (pantalla rota, poca batería, QR dañado), el staff lo escribe a mano.
// Solo aparece si el antro tiene encendido el escáner de respaldo
// (boleto_muestra_codigo, sql/post-junta-3/20-escaner-respaldo.sql). Son los
// 6 últimos caracteres del mismo código del QR: no dice nada que quien tiene
// el boleto no tenga ya, y la base solo lo acepta al staff de ese antro, para
// esa noche.

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatearCodigo, sufijoDe } from "@/lib/domain/puerta-respaldo";

export function CodigoRespaldo({ qr }: { qr: string }) {
  const [mostrar, setMostrar] = useState(false);
  useEffect(() => {
    let vivo = true;
    void Promise.resolve(createClient().rpc("boleto_muestra_codigo", { p_qr: qr })).then(
      ({ data, error }) => vivo && setMostrar(!error && data === true),
      () => {},
    );
    return () => {
      vivo = false;
    };
  }, [qr]);
  if (!mostrar) return null;
  return (
    <p className="-mt-3 flex flex-col items-center gap-0.5 text-center" data-prueba="codigo-respaldo">
      <span className="text-xs text-muted-foreground">Si no lee el QR, dicta este código en la puerta</span>
      <span className="font-mono text-xl font-semibold tracking-[0.2em]">{formatearCodigo(sufijoDe(qr))}</span>
    </p>
  );
}
