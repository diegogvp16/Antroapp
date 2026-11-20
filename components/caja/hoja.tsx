"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

// Hoja inferior de la caja: se abre sobre la mesa, con su contenido
// desplazable y una acción fija abajo (pie). Cierra con la X, tocando fuera
// o con Escape.
export function Hoja({
  titulo,
  abierta,
  onCerrar,
  children,
  pie,
}: {
  titulo: string;
  abierta: boolean;
  onCerrar: () => void;
  children: ReactNode;
  pie?: ReactNode;
}) {
  useEffect(() => {
    if (!abierta) return;
    const alTeclado = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    window.addEventListener("keydown", alTeclado);
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", alTeclado);
      document.body.style.overflow = previo;
    };
  }, [abierta, onCerrar]);

  if (!abierta) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={titulo}>
      <button type="button" aria-label="Cerrar" className="absolute inset-0 bg-black/60" onClick={onCerrar} />
      <div className="relative flex max-h-[88dvh] w-full max-w-md flex-col rounded-t-xl border border-caja-borde bg-caja-superficie">
        <div className="flex items-center justify-between gap-3 border-b border-caja-borde px-4 py-2">
          <h2 className="text-base font-semibold">{titulo}</h2>
          <button
            type="button"
            onClick={onCerrar}
            aria-label="Cerrar"
            className="-mr-2 flex size-11 items-center justify-center rounded-md text-caja-secundario hover:text-caja-texto"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {pie && (
          <div className="border-t border-caja-borde px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">{pie}</div>
        )}
      </div>
    </div>
  );
}

// Botón principal de la caja: alto de 48 px, dorado, ancho completo.
export function BotonPrincipal({
  children,
  onClick,
  disabled,
  tono = "dorado",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tono?: "dorado" | "aviso";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "h-12 w-full rounded-lg text-base font-semibold text-primary-foreground tabular-nums transition-opacity disabled:opacity-40 " +
        (tono === "aviso" ? "bg-caja-aviso" : "bg-caja-dorado")
      }
    >
      {children}
    </button>
  );
}

// Contador −/+ de 44 px por botón.
export function Contador({
  valor,
  onCambio,
  minimo = 0,
  etiqueta,
}: {
  valor: number;
  onCambio: (n: number) => void;
  minimo?: number;
  etiqueta: string;
}) {
  return (
    <div className="flex items-center gap-1" aria-label={etiqueta}>
      <button
        type="button"
        onClick={() => onCambio(Math.max(minimo, valor - 1))}
        disabled={valor <= minimo}
        aria-label={`Quitar uno: ${etiqueta}`}
        className="flex size-11 items-center justify-center rounded-md border border-caja-borde text-lg disabled:opacity-30"
      >
        −
      </button>
      <span className="w-6 text-center tabular-nums">{valor}</span>
      <button
        type="button"
        onClick={() => onCambio(Math.min(99, valor + 1))}
        aria-label={`Agregar uno: ${etiqueta}`}
        className="flex size-11 items-center justify-center rounded-md border border-caja-borde text-lg"
      >
        +
      </button>
    </div>
  );
}
