// Bandera de la fase 2 (inventario y propinas). Apagada por defecto: con
// NEXT_PUBLIC_FASE2 distinto de "1" la app se comporta exactamente como
// antes (no lee ni escribe nada de inventario ni propinas). Rama fase2,
// docs/fase2.md.
export const FASE2_ACTIVA = process.env.NEXT_PUBLIC_FASE2 === "1";
