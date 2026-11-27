import { PantallaPos } from "@/components/pos/pantalla-pos";

// Ventas del POS desde el panel del gerente (noche 4, bloque 1). El staff
// puro ve el aviso y la base lo rechaza igual.
export default function PosStaffPage() {
  return <PantallaPos volver="/staff/panel" />;
}
