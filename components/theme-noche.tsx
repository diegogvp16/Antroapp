import { cn } from "@/lib/utils";

// Envuelve una ruta de marketing/cliente con el tema "noche" (tokens en
// app/globals.css bajo .theme-noche).
export function ThemeNoche({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("theme-noche flex flex-1 flex-col", className)}>
      {children}
    </div>
  );
}
