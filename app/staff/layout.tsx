import { ThemeControl } from "@/components/theme-control";
import { EnvioColaStaff } from "@/components/caja/envio-cola-staff";
import { EnvioPuerta } from "@/components/puerta/envio-puerta";
import { metadataApp } from "@/lib/app-instalable";

export const metadata = metadataApp("staff", "Antro Staff");

// EnvioColaStaff: la cola de caja también sale fuera de la Caja (la app
// instalada abre en /staff/panel). EnvioPuerta: lo mismo para las entradas
// de la puerta guardadas sin señal (escáner de respaldo); sin nada guardado
// no muestra nada.
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeControl>
      <EnvioColaStaff />
      <EnvioPuerta />
      {children}
    </ThemeControl>
  );
}
