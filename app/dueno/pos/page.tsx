import { PantallaPos } from "@/components/pos/pantalla-pos";

// Ventas del POS desde el panel del dueño (y para el admin, que entra por
// esta misma ruta). Qué antros ve cada quien lo decide la base.
export default function PosDuenoPage() {
  return <PantallaPos volver="/dueno/panel" />;
}
