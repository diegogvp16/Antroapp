import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

export const SELECT_CLASES =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

export const TEXTAREA_CLASES =
  "min-h-24 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

// Etiqueta + control + ayuda o error. El error se anuncia (role="alert").
export function Campo({
  id,
  etiqueta,
  ayuda,
  error,
  opcional = false,
  children,
}: {
  id: string;
  etiqueta: string;
  ayuda?: string;
  error?: string;
  opcional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>
        {etiqueta}
        {opcional && <span className="font-normal text-muted-foreground"> (opcional)</span>}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-status-err">
          {error}
        </p>
      ) : ayuda ? (
        <p id={`${id}-ayuda`} className="text-xs text-muted-foreground">
          {ayuda}
        </p>
      ) : null}
    </div>
  );
}

export const describir = (id: string, error?: string, ayuda?: string) =>
  error ? `${id}-error` : ayuda ? `${id}-ayuda` : undefined;
