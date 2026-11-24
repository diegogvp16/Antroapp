// Tema de las pantallas de negocio: /staff/nomina, /grupo, todo /dueno/* y
// todo /admin/* (paneles, equipo, mensualidad, alta de antros, logins).
// El cliente tiene su propio tema oscuro (.theme-noche); la caja y el panel
// del RP ya son .theme-caja.
//
// ÚNICO punto para elegirlo (bloque 4 de la noche 2, propuesta para Diego):
//   "actual" -> como hoy (.theme-control: claro gris, solo Inter)
//   "oscuro" -> el lenguaje de la caja y del panel del RP (.theme-caja)
//   "claro"  -> la misma estructura en una paleta clara sobria con el mismo
//               dorado como acento (.theme-caja + .theme-caja-claro)
// Capturas para comparar: screenshots-temas/ (scripts/dev/capturas-temas.mjs).
export type TemaReportes = "actual" | "oscuro" | "claro";

export const TEMA_REPORTES: TemaReportes = "oscuro";

export const CLASE_TEMA_REPORTES: Record<TemaReportes, string> = {
  actual: "",
  oscuro: "theme-caja",
  claro: "theme-caja theme-caja-claro",
};

export function esTemaReportes(valor: unknown): valor is TemaReportes {
  return valor === "actual" || valor === "oscuro" || valor === "claro";
}
