import { ThemeControl } from "@/components/theme-control";
import { EnvioColaStaff } from "@/components/caja/envio-cola-staff";
import { metadataApp } from "@/lib/app-instalable";

export const metadata = metadataApp("staff", "Antro Staff");

// EnvioColaStaff: la cola de caja también sale fuera de la Caja (la app
// instalada abre en /staff/panel).
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeControl>
      <EnvioColaStaff />
      {children}
    </ThemeControl>
  );
}
