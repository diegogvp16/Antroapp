import { cn } from "@/lib/utils";

// Envuelve una ruta operativa (paneles, logins de negocio) con el tema
// "control" (tokens en app/globals.css bajo .theme-control): fondo claro,
// texto de alto contraste, color solo para estados.
export function ThemeControl({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("theme-control flex flex-1 flex-col", className)}>
      {children}
    </div>
  );
}
