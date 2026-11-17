// Cover informativo del antro. La app NO cobra nada al cliente: el cover es
// lo que el antro cobra por su cuenta en la puerta y aquí solo se informa.
//
// Las columnas cover_modo / cover_monto todavía no existen en la base
// (sql/2026-11-borrador-cover.sql sin aplicar). Mientras no existan, el club
// llega sin ellas y textoCover devuelve null: no se muestra nada.

import type { Club } from "@/types";

const formatoPesos = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
});

// Texto a mostrar, o null si no hay que mostrar nada.
export function textoCover(club: Pick<Club, "cover_modo" | "cover_monto">): string | null {
  switch (club.cover_modo) {
    case "monto":
      return club.cover_monto != null && club.cover_monto > 0
        ? `Cover ${formatoPesos.format(club.cover_monto)}`
        : null;
    case "libre":
      return "Entrada libre";
    case "consultar":
      return "Cover: consultar con el antro";
    default:
      return null;
  }
}
