"use client";

import { useEffect, useState, type RefObject } from "react";
import type { Html5Qrcode } from "html5-qrcode";
import { Flashlight, FlashlightOff } from "lucide-react";
import { Button } from "@/components/ui/button";

// Linterna del escáner de QR. Solo aparece si el navegador y la cámara la
// soportan (Chrome en Android, casi siempre; Safari en iPhone, no). Si no se
// puede, el botón no se muestra y el escáner sigue igual. Cualquier error al
// prenderla o apagarla se avisa sin detener la cámara.
export function BotonLinterna({ escaner, listo }: { escaner: RefObject<Html5Qrcode | null>; listo: boolean }) {
  const [soportada, setSoportada] = useState(false);
  const [encendida, setEncendida] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    let si = false;
    if (listo) {
      try {
        si = escaner.current?.getRunningTrackCameraCapabilities().torchFeature().isSupported() ?? false;
      } catch {
        si = false;
      }
    }
    setSoportada(si);
    setEncendida(false);
    setAviso(null);
  }, [listo, escaner]);

  if (!soportada) return null;

  async function alternar() {
    const nuevo = !encendida;
    try {
      await escaner.current?.getRunningTrackCameraCapabilities().torchFeature().apply(nuevo);
      setEncendida(nuevo);
      setAviso(null);
    } catch {
      setAviso("No se pudo cambiar la linterna. El escáner sigue funcionando.");
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" variant="outline" className="h-11 gap-2 px-4" aria-pressed={encendida} onClick={alternar}>
        {encendida ? <FlashlightOff /> : <Flashlight />}
        {encendida ? "Apagar linterna" : "Prender linterna"}
      </Button>
      {aviso && (
        <p role="status" className="text-xs text-muted-foreground">
          {aviso}
        </p>
      )}
    </div>
  );
}
