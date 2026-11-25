"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Aviso = { tipo: "ok" | "manual"; texto: string } | null;

// Compartir o guardar el enlace del boleto (/r/<codigo>). Con la hoja de
// compartir del teléfono si existe; si no, copia el enlace; y si tampoco se
// puede copiar, lo muestra para copiarlo a mano. Más el botón de WhatsApp.
export function CompartirBoleto({
  enlace,
  titulo,
  mensajeWhatsApp,
}: {
  enlace: string;
  titulo: string;
  mensajeWhatsApp: string;
}) {
  const [aviso, setAviso] = useState<Aviso>(null);

  async function copiar(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(enlace);
      return true;
    } catch {
      return false;
    }
  }

  async function compartir() {
    setAviso(null);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: titulo, url: enlace });
        return;
      } catch (err) {
        // La persona cerró la hoja de compartir: no es un error.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    if (await copiar()) {
      setAviso({ tipo: "ok", texto: "Enlace copiado. Guárdalo: con él vuelves a ver tu QR." });
    } else {
      setAviso({ tipo: "manual", texto: "Copia este enlace y guárdalo:" });
    }
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <Button type="button" size="lg" variant="outline" className="h-12 w-full text-base" onClick={compartir}>
        Guardar o compartir enlace
      </Button>
      <Button
        render={<a href={mensajeWhatsApp} target="_blank" rel="noopener noreferrer" />}
        nativeButton={false}
        size="lg"
        variant="outline"
        className="h-12 w-full text-base"
      >
        Mandar por WhatsApp
      </Button>
      {aviso && (
        <div role="status" className="flex flex-col gap-2 text-xs text-muted-foreground">
          <p>{aviso.texto}</p>
          {aviso.tipo === "manual" && (
            <input
              readOnly
              value={enlace}
              aria-label="Enlace del boleto"
              onFocus={(e) => e.currentTarget.select()}
              className="h-11 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
            />
          )}
        </div>
      )}
    </div>
  );
}
