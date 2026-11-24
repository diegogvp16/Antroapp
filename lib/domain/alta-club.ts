// Alta de un antro nuevo desde /admin (asistente en pasos).
//
// Reglas puras, sin React ni Supabase: el asistente las usa para avisar en
// cada paso y POST /api/admin/alta-club las vuelve a aplicar en el servidor
// (nunca confía en lo que validó el navegador). La función de la base
// admin_alta_club (sql/post-junta/01-alta-club.sql) es la última línea.
//
// Este archivo no importa nada con "@/": así lo pueden cargar las pruebas
// con Node directamente (scripts/dev/probar-alta-club-dominio.mjs).

import { z } from "zod";

export const MAX_MESAS = 300;
export const MAX_PERSONAL = 400;
export const COVER_MAXIMO = 100000;
export const DEPOSITO_MAXIMO = 100000;

// Zonas horarias de México (nombres de la base de datos de zonas de IANA).
export const ZONAS_MEXICO: ReadonlyArray<{ valor: string; etiqueta: string }> = [
  { valor: "America/Mexico_City", etiqueta: "Centro (CDMX, Guadalajara, Puebla)" },
  { valor: "America/Monterrey", etiqueta: "Centro (Monterrey)" },
  { valor: "America/Merida", etiqueta: "Centro (Mérida)" },
  { valor: "America/Cancun", etiqueta: "Sureste (Cancún, Quintana Roo)" },
  { valor: "America/Chihuahua", etiqueta: "Chihuahua" },
  { valor: "America/Ciudad_Juarez", etiqueta: "Ciudad Juárez" },
  { valor: "America/Mazatlan", etiqueta: "Pacífico (Mazatlán, La Paz)" },
  { valor: "America/Hermosillo", etiqueta: "Sonora (Hermosillo)" },
  { valor: "America/Tijuana", etiqueta: "Noroeste (Tijuana, Mexicali)" },
];
const VALORES_ZONA = ZONAS_MEXICO.map((z) => z.valor) as [string, ...string[]];

export const ROLES_PERSONAL = ["gerente", "staff", "rp"] as const;
export type RolPersonal = (typeof ROLES_PERSONAL)[number];
export const ETIQUETA_ROL: Record<RolPersonal | "dueno" | "dueno_grupo", string> = {
  gerente: "Gerente",
  staff: "Staff",
  rp: "RP",
  dueno: "Dueño del antro",
  dueno_grupo: "Dueño del grupo",
};

const textoOpcional = (max: number) =>
  z.string().trim().max(max, `Máximo ${max} caracteres.`).optional().default("");

const nombrePersona = z
  .string()
  .trim()
  .min(2, "Escribe el nombre (mínimo 2 letras).")
  .max(120, "El nombre es muy largo.");

const correo = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "El correo es muy largo.")
  .pipe(z.email("Revisa el correo: no parece válido."));

export const esquemaCuenta = z.object({ nombre: nombrePersona, correo });
export type Cuenta = z.infer<typeof esquemaCuenta>;

// ---------- Paso 1: datos del antro ----------
export const esquemaDatos = z.object({
  nombre: z.string().trim().min(2, "Escribe el nombre del antro.").max(120, "El nombre es muy largo."),
  direccion: z.string().trim().min(3, "Escribe la dirección.").max(300, "La dirección es muy larga."),
  ciudad: z.string().trim().min(2, "Escribe la ciudad.").max(80, "La ciudad es muy larga."),
  zona_horaria: z.enum(VALORES_ZONA, "Elige la zona horaria."),
  horario: z.string().trim().min(3, "Escribe el horario, por ejemplo: Jue a Sáb 10pm a 3am.").max(120, "El horario es muy largo."),
});

// ---------- Paso 2: cover y políticas ----------
// Montos en pesos con a lo más dos decimales (la base guarda numeric en pesos).
const pesos = (max: number, campo: string) =>
  z
    .number(`${campo}: escribe un número.`)
    .min(0, `${campo} no puede ser negativo.`)
    .max(max, `${campo} no puede pasar de $${max.toLocaleString("es-MX")}.`)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, `${campo}: máximo dos decimales.`);

export const esquemaPoliticas = z
  .object({
    cover_modo: z.enum(["oculto", "monto", "libre", "consultar"]),
    cover_monto: pesos(COVER_MAXIMO, "El cover").nullable(),
    deposito_monto: pesos(DEPOSITO_MAXIMO, "El depósito"),
    edad_minima: z.number("La edad mínima es un número.").int("La edad mínima es un número entero.").min(18, "La edad mínima no puede ser menor a 18.").max(99, "Revisa la edad mínima.").nullable(),
    codigo_vestimenta: textoOpcional(200),
    tipo_musica: textoOpcional(200),
    ambiente: textoOpcional(500),
    // Hora límite de llegada para la reserva ("HH:MM"), opcional.
    tolerancia_hora: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "La tolerancia es una hora, por ejemplo 23:30.")
      .nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.cover_modo === "monto" && !(p.cover_monto != null && p.cover_monto > 0)) {
      ctx.addIssue({ code: "custom", path: ["cover_monto"], message: "Escribe el monto del cover o elige otra opción." });
    }
    if (p.cover_modo !== "monto" && p.cover_monto != null) {
      ctx.addIssue({ code: "custom", path: ["cover_monto"], message: "El monto solo va con el modo «Monto»." });
    }
  });

// ---------- Paso 3: mesas ----------
export const esquemaMesa = z.object({
  numero: z.string().trim().min(1, "Cada mesa necesita nombre.").max(30, "El nombre de la mesa es muy largo."),
  capacidad: z.number("Escribe cuántas personas caben.").int("La capacidad es un número entero.").min(1, "La capacidad mínima es 1.").max(100, "La capacidad máxima es 100."),
});
export type Mesa = z.infer<typeof esquemaMesa>;

export const esquemaMesas = z
  .array(esquemaMesa)
  .max(MAX_MESAS, `Máximo ${MAX_MESAS} mesas.`)
  .superRefine((mesas, ctx) => {
    const vistas = new Map<string, number>();
    mesas.forEach((m, i) => {
      const clave = m.numero.trim().toLowerCase();
      if (vistas.has(clave)) {
        ctx.addIssue({ code: "custom", path: [i, "numero"], message: `La mesa «${m.numero.trim()}» está repetida.` });
      }
      vistas.set(clave, i);
    });
  });

// ---------- Paso 4: equipo ----------
export const esquemaPersonal = z.object({ nombre: nombrePersona, correo, rol: z.enum(ROLES_PERSONAL) });
export type Personal = z.infer<typeof esquemaPersonal>;

// ---------- Paso 5: grupo ----------
export const esquemaGrupo = z.discriminatedUnion("modo", [
  z.object({ modo: z.literal("ninguno") }),
  z.object({
    modo: z.literal("nuevo"),
    nombre: z.string().trim().min(2, "Escribe el nombre del grupo.").max(120, "El nombre del grupo es muy largo."),
    dueno_grupo: z.enum(["dueno_antro", "cuenta_nueva"]),
    cuenta: esquemaCuenta.nullable(),
  }),
  z.object({
    modo: z.literal("existente"),
    grupo_id: z.uuid("Elige el grupo."),
    dueno_grupo: z.enum(["ninguno", "dueno_antro", "cuenta_nueva"]),
    cuenta: esquemaCuenta.nullable(),
  }),
]);
export type Grupo = z.infer<typeof esquemaGrupo>;

// ---------- Todo junto ----------
export const esquemaAltaClub = z
  .object({
    datos: esquemaDatos,
    politicas: esquemaPoliticas,
    mesas: esquemaMesas,
    dueno: esquemaCuenta.nullable(),
    personal: z.array(esquemaPersonal).max(MAX_PERSONAL, `Máximo ${MAX_PERSONAL} personas en el alta.`),
    grupo: esquemaGrupo,
    publicar: z.boolean(),
  })
  .superRefine((a, ctx) => {
    if (a.grupo.modo !== "ninguno") {
      if (a.grupo.dueno_grupo === "dueno_antro" && !a.dueno) {
        ctx.addIssue({ code: "custom", path: ["grupo", "dueno_grupo"], message: "Para que el dueño del antro sea dueño del grupo, primero agrega al dueño en el paso Equipo." });
      }
      if (a.grupo.dueno_grupo === "cuenta_nueva" && !a.grupo.cuenta) {
        ctx.addIssue({ code: "custom", path: ["grupo", "cuenta"], message: "Escribe nombre y correo del dueño del grupo." });
      }
    }
    // Un correo, una cuenta.
    const vistos = new Map<string, string>();
    for (const c of cuentasNuevas(a)) {
      if (vistos.has(c.correo)) {
        ctx.addIssue({ code: "custom", path: ["personal"], message: `El correo ${c.correo} está dos veces.` });
      }
      vistos.set(c.correo, c.rol);
    }
  });
export type AltaClub = z.infer<typeof esquemaAltaClub>;
export type EntradaAltaClub = z.input<typeof esquemaAltaClub>;

export type RolCuentaNueva = RolPersonal | "dueno" | "dueno_grupo";
export type CuentaNueva = { nombre: string; correo: string; rol: RolCuentaNueva };

// Todas las cuentas de Auth que hay que crear, en orden.
export function cuentasNuevas(a: Pick<AltaClub, "dueno" | "personal" | "grupo">): CuentaNueva[] {
  const lista: CuentaNueva[] = [];
  if (a.dueno) lista.push({ ...a.dueno, rol: "dueno" });
  if (a.grupo.modo !== "ninguno" && a.grupo.dueno_grupo === "cuenta_nueva" && a.grupo.cuenta) {
    lista.push({ ...a.grupo.cuenta, rol: "dueno_grupo" });
  }
  for (const p of a.personal) lista.push(p);
  return lista;
}

// Lo que recibe admin_alta_club(p jsonb). ids: correo → id de Auth.
export function payloadSql(a: AltaClub, ids: ReadonlyMap<string, string>) {
  return {
    club: {
      ...a.datos,
      ...a.politicas,
      ambiente: a.politicas.ambiente || null,
      tipo_musica: a.politicas.tipo_musica || null,
      codigo_vestimenta: a.politicas.codigo_vestimenta || null,
    },
    publicar: a.publicar,
    mesas: a.mesas.map((m) => ({ numero: m.numero.trim(), capacidad: m.capacidad })),
    usuarios: cuentasNuevas(a).map((c) => {
      const id = ids.get(c.correo);
      if (!id) throw new Error("Falta la cuenta de " + c.correo);
      return { id, nombre: c.nombre, rol: c.rol };
    }),
    grupo:
      a.grupo.modo === "ninguno"
        ? { modo: "ninguno" }
        : {
            modo: a.grupo.modo,
            nombre: a.grupo.modo === "nuevo" ? a.grupo.nombre : undefined,
            grupo_id: a.grupo.modo === "existente" ? a.grupo.grupo_id : undefined,
            dueno_antro_es_dueno_grupo: a.grupo.dueno_grupo === "dueno_antro",
          },
  };
}

// ---------- Ayudas del asistente ----------

// "Generar 20 mesas": prefijo + número, empezando después de la última que
// ya tenga ese prefijo, sin repetir nombres existentes.
export function generarMesas(existentes: readonly Mesa[], cantidad: number, prefijo: string, capacidad: number): Mesa[] {
  const n = Math.max(0, Math.min(Math.floor(cantidad), MAX_MESAS - existentes.length));
  const pre = prefijo.trim();
  const usados = new Set(existentes.map((m) => m.numero.trim().toLowerCase()));
  const nuevas: Mesa[] = [];
  let i = 1;
  while (nuevas.length < n) {
    const numero = pre ? `${pre} ${i}` : String(i);
    if (!usados.has(numero.toLowerCase())) {
      nuevas.push({ numero, capacidad });
      usados.add(numero.toLowerCase());
    }
    i++;
  }
  return nuevas;
}

// Lista pegada (de una hoja de cálculo o de WhatsApp): una persona por línea,
// "Nombre, correo" (también con punto y coma o tabulador). Devuelve las filas
// válidas y los errores por línea, sin adivinar.
export function leerListaPersonal(texto: string, rol: RolPersonal): { filas: Personal[]; errores: string[] } {
  const filas: Personal[] = [];
  const errores: string[] = [];
  texto.split(/\r?\n/).forEach((linea, i) => {
    if (!linea.trim()) return;
    const partes = linea.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean);
    const iCorreo = partes.findIndex((p) => p.includes("@"));
    if (iCorreo === -1 || partes.length < 2) {
      errores.push(`Línea ${i + 1}: escribe «Nombre, correo».`);
      return;
    }
    const nombre = partes.filter((_, j) => j !== iCorreo).join(" ");
    const r = esquemaPersonal.safeParse({ nombre, correo: partes[iCorreo], rol });
    if (r.success) filas.push(r.data);
    else errores.push(`Línea ${i + 1}: ${r.error.issues[0]?.message ?? "no es válida"}`);
  });
  return { filas, errores };
}

// Primer mensaje de error por ruta ("datos.nombre" → "Escribe el nombre…").
export function erroresPorCampo(error: z.ZodError): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const issue of error.issues) {
    const clave = issue.path.map(String).join(".");
    if (!(clave in salida)) salida[clave] = issue.message;
  }
  return salida;
}
