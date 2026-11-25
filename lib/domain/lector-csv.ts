// Lector CSV compartido por los importadores (catálogo de la fase 2, mesas y
// personal). Puro: sin React, sin Supabase y sin imports con "@/" (las
// pruebas lo cargan con Node).
//
// Reglas (las mismas que tenía el importador del catálogo):
// - Separador: tabulador si la línea trae alguno (copiado de una hoja de
//   cálculo); si no, punto y coma cuando hay más que comas; si no, coma. Se
//   decide con la PRIMERA línea no vacía y vale para todo el archivo.
// - Un campo con el separador va entre comillas: "Whisky, 750 ml". Dentro de
//   comillas, "" es una comilla.
// - Se quita la marca BOM del principio y los espacios de cada campo.
// - Las líneas vacías no cuentan, pero sí conservan su número (los errores
//   dicen "Línea N" con el número que ve la persona en su archivo).

export function separadorDe(linea: string): string {
  const cuenta = (c: string) => linea.split(c).length - 1;
  if (cuenta("\t") > 0) return "\t";
  return cuenta(";") > cuenta(",") ? ";" : ",";
}

// Divide una línea respetando comillas dobles ("" dentro de comillas = ").
export function partirLinea(linea: string, sep: string): string[] {
  const campos: string[] = [];
  let actual = "";
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (comillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (c === '"') comillas = false;
      else actual += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) {
      campos.push(actual.trim());
      actual = "";
    } else actual += c;
  }
  campos.push(actual.trim());
  return campos;
}

// Minúsculas y sin acentos, para reconocer encabezados ("Teléfono" = "telefono").
export const quitarAcentos = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export interface LineaCsv {
  // Número de línea en el archivo (desde 1).
  n: number;
  campos: string[];
}

// Las líneas no vacías del texto, ya partidas en campos.
export function lineasCsv(texto: string): LineaCsv[] {
  const salida: LineaCsv[] = [];
  let sep: string | null = null;
  texto
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((linea, i) => {
      if (!linea.trim()) return;
      sep ??= separadorDe(linea);
      salida.push({ n: i + 1, campos: partirLinea(linea, sep) });
    });
  return salida;
}

// Tope de tamaño para un archivo pegado o subido (lo revisa la pantalla).
export const MAX_BYTES_CSV = 500_000;
