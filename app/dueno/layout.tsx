import { ThemeControl } from "@/components/theme-control";
import { TemaReportesContenedor } from "@/components/tema-reportes";
import { metadataApp } from "@/lib/app-instalable";

export const metadata = metadataApp("dueno", "Antro Dueño");

export default function DuenoLayout({ children }: { children: React.ReactNode }) {
  // Tema de las pantallas de negocio: un solo punto, lib/tema-reportes.ts.
  return (
    <ThemeControl>
      <TemaReportesContenedor className="flex flex-1 flex-col">{children}</TemaReportesContenedor>
    </ThemeControl>
  );
}
