"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { motivoValido, MIN_MOTIVO } from "@/lib/domain/caja";
import { esErrorDeRed, mensajeParaUsuario } from "@/lib/errores-base";

// Resultado mínimo de una llamada a Supabase (rpc o select).
type ErrorLlamada = { message: string; code?: string } | null;
type Resultado<T = unknown> = { data?: T | null; error: ErrorLlamada };

// Un paso de un flujo: corre una llamada y, si falla, deja el mensaje para
// la persona. Devuelve si salió bien, el dato de la base y el error.
export type Paso = <T>(accion: () => PromiseLike<Resultado<T>>) => Promise<{ ok: boolean; data: T | null; error: ErrorLlamada }>;

const SIN_RESPUESTA =
  "No hubo respuesta por la señal. Tu captura sigue aquí: vuelve a intentar; si ya se había guardado, no se duplica.";

// Ejecuta acciones de caja contra la base y guarda su estado: ocupado
// mientras corre y el mensaje de error: el de las funciones de caja (en
// español) tal cual; uno claro si falló la red; cualquier otro, genérico
// (lib/errores-base.ts).
//
// Doble toque: el candado es un ref (síncrono), no solo el estado: un
// segundo toque antes de que React vuelva a pintar el botón desactivado
// no entra. Un flujo de varios pasos (cerrar y cuadrar, varios renglones)
// conserva el candado de principio a fin.
export function useAccion() {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enCurso = useRef(false);

  const paso: Paso = useCallback(async <T,>(accion: () => PromiseLike<Resultado<T>>) => {
    try {
      const r = await accion();
      if (r.error) {
        setError(esErrorDeRed(r.error) ? SIN_RESPUESTA : mensajeParaUsuario(r.error));
        return { ok: false, data: null, error: r.error };
      }
      return { ok: true, data: r.data ?? null, error: null };
    } catch (err) {
      console.error("Error en acción de caja:", err);
      setError(SIN_RESPUESTA);
      return { ok: false, data: null, error: { message: "sin respuesta" } };
    }
  }, []);

  // Corre un flujo completo con el candado puesto. Devuelve true si salió bien.
  const correr = useCallback(
    async (flujo: (p: Paso) => Promise<boolean>) => {
      if (enCurso.current) return false;
      enCurso.current = true;
      setOcupado(true);
      setError(null);
      try {
        return await flujo(paso);
      } catch (err) {
        console.error("Error en acción de caja:", err);
        setError(SIN_RESPUESTA);
        return false;
      } finally {
        enCurso.current = false;
        setOcupado(false);
      }
    },
    [paso],
  );

  // Una sola llamada y, si salió bien, lo que siga (recargar, cerrar la hoja).
  const ejecutar = useCallback(
    (accion: () => PromiseLike<Resultado>, despues?: () => Promise<void> | void) =>
      correr(async (p) => {
        const r = await p(accion);
        if (!r.ok) return false;
        if (despues) await despues();
        return true;
      }),
    [correr],
  );

  const limpiarError = useCallback(() => setError(null), []);

  return { ocupado, error, ejecutar, correr, limpiarError };
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
