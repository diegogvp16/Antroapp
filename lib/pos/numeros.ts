// Montos y cantidades como los escriben los POS. Puro (sin "@/").
//
// Dos formatos de número:
//   - «punto» (México): 1,234.50 — coma de miles, punto decimal.
//   - «coma» (configuración regional de España y otros): 1.234,50.
// Cada valor se lee con el formato de SU COLUMNA: el mapeo lo puede fijar
// (formato_montos) y, si no, se decide con todos los valores de la columna
// (detectarFormatoNumeros). Un valor con un solo separador seguido de
// exactamente 3 dígitos («1.500», «1,234») es AMBIGUO si no se conoce el
// formato: no se adivina, se marca error para que se elija en el mapeo.
//
// También: «$», «MXN», «M.N.», espacios, negativos con «-», paréntesis o
// «-» al final. Todo con texto (sin flotantes); se redondea a centavos (o a
// milésimas en cantidades) con la mitad hacia afuera del cero.

export type FormatoNumeros = "punto" | "coma";
export type Lectura = { ok: true; valor: number; redondeado: boolean } | { ok: false; error: string };

function limpiar(texto: string): { negativo: boolean; t: string } | null {
  let t = (texto ?? "").replace(/[\s  ]/g, "").replace(/^(MXN|MN|M\.N\.)|(MXN|MN|M\.N\.)$/gi, "").replace(/\$/g, "");
  let negativo = false;
  if (/^\(.*\)$/.test(t)) {
    negativo = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith("-")) {
    negativo = !negativo;
    t = t.slice(1);
  } else if (t.endsWith("-")) {
    negativo = !negativo;
    t = t.slice(0, -1);
  } else if (t.startsWith("+")) t = t.slice(1);
  t = t.replace(/\$/g, "");
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
  return { negativo, t };
}

/** Qué dice un valor sobre el formato de su columna. */
export function clasificarNumero(texto: string): FormatoNumeros | "ambiguo" | null {
  const l = limpiar(texto);
  if (!l) return null;
  const { t } = l;
  const comas = (t.match(/,/g) ?? []).length;
  const puntos = (t.match(/\./g) ?? []).length;
  if (comas && puntos) return t.lastIndexOf(",") > t.lastIndexOf(".") ? "coma" : "punto";
  if (comas) {
    if (comas > 1) return /^\d{1,3}(,\d{3})+$/.test(t) ? "punto" : null;
    if (/^\d{1,3},\d{3}$/.test(t)) return "ambiguo";
    return /^\d*,\d+$/.test(t) ? "coma" : null;
  }
  if (puntos) {
    if (puntos > 1) return /^\d{1,3}(\.\d{3})+$/.test(t) ? "coma" : null;
    if (/^\d{1,3}\.\d{3}$/.test(t)) return "ambiguo";
    return /^\d*\.\d+$/.test(t) ? "punto" : null;
  }
  return null;
}

/** Formato de una columna según todos sus valores: el único que aparece;
 *  «mixto» si aparecen los dos; nulo si ningún valor lo dice. */
export function detectarFormatoNumeros(valores: readonly string[]): FormatoNumeros | "mixto" | null {
  let punto = false;
  let coma = false;
  for (const v of valores) {
    const c = clasificarNumero(v);
    if (c === "punto") punto = true;
    else if (c === "coma") coma = true;
  }
  if (punto && coma) return "mixto";
  return punto ? "punto" : coma ? "coma" : null;
}

export const mensajeAmbiguo = (texto: string) =>
  `«${texto}» es ambiguo: elige en el mapeo si los montos usan punto decimal (1,234.50) o coma decimal (1.234,50)`;

type Partes = { negativo: boolean; entero: string; fraccion: string } | { error: string };

/** Separa entero y fracción con el formato dado (o sin él, si no hay duda). */
function partes(texto: string, formato?: FormatoNumeros): Partes {
  const l = limpiar(texto);
  const malo = { error: `«${texto}» no es un número` };
  if (!l) return malo;
  const { t, negativo } = l;
  let dec: "," | "." | null = null;
  if (formato) dec = formato === "punto" ? "." : ",";
  else if (/[.,]/.test(t)) {
    const c = clasificarNumero(texto);
    if (c === "ambiguo") return { error: mensajeAmbiguo(texto) };
    if (c === null) return malo;
    dec = c === "punto" ? "." : ",";
  }
  const miles = dec === "." ? "," : dec === "," ? "." : null;
  let entero = t;
  let fraccion = "";
  if (dec) {
    const trozos = t.split(dec);
    if (trozos.length > 2) return malo;
    entero = trozos[0];
    fraccion = trozos[1] ?? "";
  }
  if (miles && entero.includes(miles)) {
    const grupos = entero.split(miles);
    if (!/^\d{1,3}$/.test(grupos[0]) || grupos.slice(1).some((g) => !/^\d{3}$/.test(g))) return malo;
    entero = grupos.join("");
  }
  if (!/^\d*$/.test(entero) || !/^\d*$/.test(fraccion) || (!entero && !fraccion)) return malo;
  return { negativo, entero: entero || "0", fraccion };
}

/** Redondea «entero.fraccion» a `dec` decimales y lo da como entero escalado. */
function escalar(entero: string, fraccion: string, dec: number): { n: number; redondeado: boolean } {
  const f = fraccion.padEnd(dec + 1, "0");
  let n = Number(entero) * 10 ** dec + Number(f.slice(0, dec) || "0");
  if (Number(f[dec]) >= 5) n += 1;
  return { n, redondeado: /[1-9]/.test(fraccion.slice(dec)) };
}

/** Monto → centavos enteros. */
export function leerMonto(texto: string, maxCentavos = 100_000_000, formato?: FormatoNumeros): Lectura {
  const p = partes(texto ?? "", formato);
  if ("error" in p) return { ok: false, error: p.error.replace("no es un número", "no es un monto") };
  const { n, redondeado } = escalar(p.entero, p.fraccion, 2);
  if (!Number.isSafeInteger(n) || n > maxCentavos) return { ok: false, error: `«${texto}» es demasiado grande` };
  return { ok: true, valor: p.negativo && n !== 0 ? -n : n, redondeado };
}

/** Cantidad → número con hasta 3 decimales. */
export function leerCantidad(texto: string, max = 10_000, formato?: FormatoNumeros): Lectura {
  const p = partes(texto ?? "", formato);
  if ("error" in p) return { ok: false, error: p.error.replace("no es un número", "no es una cantidad") };
  const { n, redondeado } = escalar(p.entero, p.fraccion, 3);
  if (!Number.isSafeInteger(n) || n > max * 1000) return { ok: false, error: `«${texto}» es demasiado grande` };
  const v = n / 1000;
  return { ok: true, valor: p.negativo && v !== 0 ? -v : v, redondeado };
}

/** cantidad × precio, redondeado a centavos (mitad hacia afuera). */
export function multiplicarCentavos(cantidad: number, precioCentavos: number): number {
  const milesimas = Math.round(cantidad * 1000);
  const producto = milesimas * precioCentavos; // en milésimas de centavo
  const signo = producto < 0 ? -1 : 1;
  return signo * Math.floor((Math.abs(producto) + 500) / 1000);
}
