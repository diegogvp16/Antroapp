// Importar mesas desde un CSV a un antro que ya existe (B1a). Puro: sin React
// ni Supabase y sin imports con "@/" (las pruebas lo cargan con Node).
//
// Una línea por mesa: nombre, capacidad
//   1,8
//   VIP 1;15
//   "Terraza, 2"	6
// Encabezado opcional (primera línea con «mesa», «nombre» o «número» y
// «capacidad» o «personas»). Separador y comillas: lib/domain/lector-csv.ts.
//
// La pantalla revisa con estas reglas y la base (mesas_importar, sql/
// post-junta-2/22-importar-mesas.sql) las vuelve a aplicar todas: si una
// fila no pasa, no entra ninguna. Si la mesa ya existe (mismo nombre, sin
// importar mayúsculas ni espacios de las orillas) solo se actualiza su
// capacidad. Nunca se borra ni se renombra una mesa: las reservas y la caja
// apuntan a ellas.

import { lineasCsv, quitarAcentos } from "./lector-csv";

export const MAX_MESAS_CSV = 300;
export const MAX_NOMBRE_MESA = 30;
export const MAX_CAPACIDAD_MESA = 100;

export interface FilaMesa {
  // Número de línea en el archivo; solo sirve para el mensaje de error.
  linea: number;
  numero: string;
  capacidad: number;
}

// La misma llave que el índice único de la base: lower(btrim(numero)).
export const claveMesa = (numero: string) => numero.trim().toLowerCase();

const esEncabezado = (c: string[]) =>
  /^(mesa|nombre|numero|no\.?|#)/.test(quitarAcentos(c[0] ?? "")) && /(capacidad|personas|lugares)/.test(quitarAcentos(c[1] ?? ""));

export function leerMesasCsv(texto: string): { filas: FilaMesa[]; errores: string[] } {
  const filas: FilaMesa[] = [];
  const errores: string[] = [];
  const vistos = new Map<string, number>();
  lineasCsv(texto).forEach(({ n, campos }, i) => {
    if (i === 0 && esEncabezado(campos)) return;
    const [numero = "", capacidad = "", ...resto] = campos;
    if (resto.some((x) => x !== "")) return errores.push(`Línea ${n}: van solo dos columnas, «mesa, capacidad».`);
    if (!numero || numero.length > MAX_NOMBRE_MESA) return errores.push(`Línea ${n}: el nombre de la mesa va de 1 a ${MAX_NOMBRE_MESA} caracteres.`);
    if (/[\r\n\t]/.test(numero)) return errores.push(`Línea ${n}: el nombre de la mesa no puede tener saltos de línea.`);
    if (!/^\d{1,3}$/.test(capacidad) || Number(capacidad) < 1 || Number(capacidad) > MAX_CAPACIDAD_MESA) {
      return errores.push(`Línea ${n}: la capacidad es un número entero de 1 a ${MAX_CAPACIDAD_MESA} («${capacidad}»).`);
    }
    const clave = claveMesa(numero);
    if (vistos.has(clave)) return errores.push(`Línea ${n}: la mesa «${numero}» ya viene en la línea ${vistos.get(clave)}.`);
    vistos.set(clave, n);
    filas.push({ linea: n, numero, capacidad: Number(capacidad) });
  });
  if (filas.length > MAX_MESAS_CSV) errores.push(`Máximo ${MAX_MESAS_CSV} mesas por importación (vienen ${filas.length}).`);
  return { filas, errores };
}

export type CambioMesa =
  | { tipo: "nueva"; fila: FilaMesa }
  | { tipo: "capacidad"; fila: FilaMesa; antes: number }
  | { tipo: "igual"; fila: FilaMesa };

// Vista previa contra las mesas que ya tiene el antro.
export function compararMesas(
  filas: readonly FilaMesa[],
  existentes: readonly { numero: string; capacidad: number }[],
): { cambios: CambioMesa[]; nuevas: number; actualizadas: number; iguales: number; totalDespues: number } {
  const porClave = new Map(existentes.map((m) => [claveMesa(m.numero), Number(m.capacidad)]));
  const cambios: CambioMesa[] = filas.map((fila) => {
    const antes = porClave.get(claveMesa(fila.numero));
    if (antes === undefined) return { tipo: "nueva", fila };
    return antes === fila.capacidad ? { tipo: "igual", fila } : { tipo: "capacidad", fila, antes };
  });
  const nuevas = cambios.filter((c) => c.tipo === "nueva").length;
  const actualizadas = cambios.filter((c) => c.tipo === "capacidad").length;
  return { cambios, nuevas, actualizadas, iguales: cambios.length - nuevas - actualizadas, totalDespues: existentes.length + nuevas };
}

// Tope de mesas por antro (el mismo del alta de un antro nuevo).
export const MAX_MESAS_ANTRO = 300;

// Lo que se manda a la base: sin campos de más.
export const filasParaBase = (filas: readonly FilaMesa[]) => filas.map((f) => ({ linea: f.linea, numero: f.numero.trim(), capacidad: f.capacidad }));
