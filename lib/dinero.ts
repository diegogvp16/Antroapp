// Formato de montos en pesos mexicanos para mostrar en pantalla.
const formatoPesos = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
});

export function formatearPesos(monto: number): string {
  return formatoPesos.format(monto);
}
