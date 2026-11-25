import { PantallaExportar } from "@/components/reportes/exportar";

// Descargar reportes CSV desde el panel del gerente (B4). El staff ve el
// aviso "es para gerentes y dueños" y la base lo rechaza igual.
export default function ExportarStaffPage() {
  return <PantallaExportar volver="/staff/panel" />;
}
