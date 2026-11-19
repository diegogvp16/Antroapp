"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { motivoValido, MIN_MOTIVO } from "@/lib/domain/caja";

// Resultado mínimo de una llamada a Supabase (rpc o select).
type Resultado = { error: { message: string } | null };

// Ejecuta una acción de caja contra la base y guarda su estado: ocupado
// mientras corre y el mensaje de error de la base, tal cual (las funciones
// de caja responden en español). Devuelve true si salió bien.
export function useAccion() {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ejecutar = useCallback(
    async (accion: () => PromiseLike<Resultado>, despues?: () => Promise<void> | void) => {
      setOcupado(true);
      setError(null);
      try {
        const { error: errorBase } = await accion();
        if (errorBase) {
          setError(errorBase.message);
          return false;
        }
        if (despues) await despues();
        return true;
      } catch (err) {
        console.error("Error en acción de caja:", err);
        setError("No se pudo completar. Revisa tu conexión e intenta de nuevo.");
        return false;
      } finally {
        setOcupado(false);
      }
    },
    [],
  );

  const limpiarError = useCallback(() => setError(null), []);

  return { ocupado, error, ejecutar, limpiarError };
}

export function MensajeError({ mensaje }: { mensaje: string | null }) {
  if (!mensaje) return null;
  return (
    <p className="text-sm break-words text-destructive" role="alert">
      {mensaje}
    </p>
  );
}

// Botón que se convierte en una captura de motivo obligatorio (anular un
// cargo o un pago, reabrir una mesa). Nada se borra: todo queda con motivo.
export function AccionConMotivo({
  etiqueta,
  etiquetaConfirmar,
  placeholder,
  onConfirmar,
  variante = "outline",
}: {
  etiqueta: string;
  etiquetaConfirmar: string;
  placeholder: string;
  // Devuelve true si salió bien (para cerrar la captura).
  onConfirmar: (motivo: string) => Promise<boolean>;
  variante?: "outline" | "destructive";
}) {
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [ocupado, setOcupado] = useState(false);

  if (!abierto) {
    return (
      <Button type="button" size="sm" variant={variante} onClick={() => setAbierto(true)}>
        {etiqueta}
      </Button>
    );
  }

  const valido = motivoValido(motivo);

  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valido) return;
        setOcupado(true);
        const ok = await onConfirmar(motivo.trim());
        setOcupado(false);
        if (ok) {
          setMotivo("");
          setAbierto(false);
        }
      }}
    >
      <Input
        autoFocus
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder={placeholder}
        maxLength={300}
        aria-label="Motivo"
      />
      {!valido && motivo.length > 0 && (
        <p className="text-xs text-muted-foreground">
          El motivo debe tener al menos {MIN_MOTIVO} caracteres.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant={variante} disabled={!valido || ocupado}>
          {ocupado ? "Guardando..." : etiquetaConfirmar}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={ocupado}
          onClick={() => {
            setAbierto(false);
            setMotivo("");
          }}
        >
          Cancelar
        </Button>
      </div>
    </form>
  );
}

// Fila "etiqueta ........ monto" de los resúmenes.
export function FilaMonto({
  etiqueta,
  valor,
  fuerte = false,
  className,
}: {
  etiqueta: string;
  valor: string;
  fuerte?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", fuerte && "font-semibold")}>
      <span className={cn(!fuerte && "text-muted-foreground")}>{etiqueta}</span>
      <span className={cn("tabular-nums", className)}>{valor}</span>
    </div>
  );
}

export const SELECT_CLASSES =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";
