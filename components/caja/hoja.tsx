"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

const ENFOCABLES = "button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])";

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
  const panel = useRef<HTMLDivElement>(null);
  const teclado = useTeclado(abierta);

  useEffect(() => {
    if (!abierta) return;
    // Foco: entra a la hoja (al campo marcado con data-autofocus o, si no
    // hay, al panel: en el celular enfocar un campo abre el teclado y tapa la
    // mitad de la hoja, así que solo se hace donde hay que escribir sí o sí),
    // no se sale con Tab y regresa al elemento que la abrió al cerrar.
    const previoFoco = document.activeElement as HTMLElement | null;
    const enfocables = () =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>(ENFOCABLES) ?? []).filter((el) => !el.hasAttribute("disabled"));
    const primerCampo = panel.current?.querySelector<HTMLElement>("[data-autofocus]");
    (primerCampo ?? panel.current)?.focus();

    const alTeclado = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
      if (e.key !== "Tab") return;
      const lista = enfocables();
      if (lista.length === 0) return;
      const primero = lista[0], ultimo = lista[lista.length - 1];
      if (e.shiftKey && document.activeElement === primero) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    };
    window.addEventListener("keydown", alTeclado);
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", alTeclado);
      document.body.style.overflow = previo;
      previoFoco?.focus?.();
    };
  }, [abierta, onCerrar]);

  if (!abierta) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      // iPhone: el teclado no encoge la página; se sube la hoja lo que mide.
      style={teclado.alto > 0 ? { paddingBottom: teclado.alto } : undefined}
    >
      <button type="button" aria-hidden="true" tabIndex={-1} className="absolute inset-0 bg-black/60" onClick={onCerrar} />
      <div
        ref={panel}
        tabIndex={-1}
        className="relative flex max-h-[88dvh] w-full max-w-md flex-col rounded-t-xl border border-caja-borde bg-caja-superficie outline-none"
        style={teclado.alto > 0 ? { maxHeight: teclado.visible * 0.92 } : undefined}
      >
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

// Cuánto tapa el teclado en pantallas donde no encoge la página (Safari en
// iPhone). En Chrome Android la página ya se encoge (interactive-widget en
// app/layout.tsx) y esto da 0.
function useTeclado(activo: boolean) {
  const [medida, setMedida] = useState({ alto: 0, visible: 0 });
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!activo || !vv) return;
    const medir = () => {
      const alto = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setMedida({ alto: alto > 80 ? alto : 0, visible: vv.height });
    };
    medir();
    vv.addEventListener("resize", medir);
    vv.addEventListener("scroll", medir);
    return () => {
      vv.removeEventListener("resize", medir);
      vv.removeEventListener("scroll", medir);
      setMedida({ alto: 0, visible: 0 });
    };
  }, [activo]);
  return medida;
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
        className="flex size-11 items-center justify-center rounded-md border border-caja-control text-lg disabled:opacity-30"
      >
        −
      </button>
      <span className="w-6 text-center tabular-nums">{valor}</span>
      <button
        type="button"
        onClick={() => onCambio(Math.min(99, valor + 1))}
        aria-label={`Agregar uno: ${etiqueta}`}
        className="flex size-11 items-center justify-center rounded-md border border-caja-control text-lg"
      >
        +
      </button>
    </div>
  );
}
