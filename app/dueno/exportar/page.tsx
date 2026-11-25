import { PantallaExportar } from "@/components/reportes/exportar";

// Descargar reportes CSV desde el panel del dueño (B4).
export default function ExportarDuenoPage() {
  return <PantallaExportar volver="/dueno/panel" />;
}
