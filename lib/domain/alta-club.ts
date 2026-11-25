// Alta de un antro nuevo desde /admin (asistente en pasos).
//
// Reglas puras, sin React ni Supabase: el asistente las usa para avisar en
// cada paso y POST /api/admin/alta-club las vuelve a aplicar en el servidor
// (nunca confía en lo que validó el navegador). La función de la base
// admin_alta_club (sql/post-junta/01-alta-club.sql; con reglas de RPs y permisos
// de caja desde sql/post-junta-2/10-alta-club-reglas.sql) es la última línea.
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

// ---------- Paso 4: reglas de comisión y RPs ----------
// Se guardan con el modelo de sql/post-junta/07-config-rp.sql (reglas_comision,
// club_config_rp) dentro de la transacción del alta (sql/post-junta-2/10):
// el antro NO nace calculando con las columnas viejas de clubs (comision_*).
// Rangos y mensajes iguales a validarRegla (lib/domain/config-rp.ts) y a
// config_rp_cambiar_regla; las pruebas revisan que coincidan.
export const MODOS_PAGO_RP = ["reserva", "dia"] as const;
export type ModoPagoRp = (typeof MODOS_PAGO_RP)[number];
export const NIVELES_VISIBILIDAD = ["estado", "estado_monto", "estado_monto_botellas"] as const;
export const TIPOS_REGLA = ["porcentaje", "fijo", "cuota"] as const;
export const MAX_TARIFAS_DIA = 7;
export const MONTO_MAXIMO_CENTAVOS = 10_000_000; // $100,000

const MSG_PORCENTAJE = "Escribe un porcentaje entre 0.01 y 100.";
const MSG_MONTO = "Escribe un monto entre $0.01 y $100,000.";
const MSG_CUOTA = "La cuota va de 1 a 100 reservas.";
const MSG_TARIFA = "Cada tarifa va de $0 a $100,000.";

const enteroONulo = (mensaje: string) => z.number(mensaje).int(mensaje).nullable();

export const esquemaReglaComision = z
  .object({
    tipo: z.enum(TIPOS_REGLA, "Elige el tipo de regla."),
    cuota: z.number(MSG_CUOTA).int(MSG_CUOTA),
    porcentaje_bp: enteroONulo(MSG_PORCENTAJE),
    monto_centavos: enteroONulo(MSG_MONTO),
  })
  .superRefine((r, ctx) => {
    if (r.tipo === "porcentaje") {
      if (!(r.porcentaje_bp != null && r.porcentaje_bp >= 1 && r.porcentaje_bp <= 10000)) {
        ctx.addIssue({ code: "custom", path: ["porcentaje_bp"], message: MSG_PORCENTAJE });
      }
      return;
    }
    if (!(r.monto_centavos != null && r.monto_centavos >= 1 && r.monto_centavos <= MONTO_MAXIMO_CENTAVOS)) {
      ctx.addIssue({ code: "custom", path: ["monto_centavos"], message: MSG_MONTO });
    }
    if (r.tipo === "cuota" && !(r.cuota >= 1 && r.cuota <= 100)) {
      ctx.addIssue({ code: "custom", path: ["cuota"], message: MSG_CUOTA });
    }
  })
  // Solo viaja lo que usa cada tipo (como la tabla reglas_comision exige).
  .transform((r) => ({
    tipo: r.tipo,
    cuota: r.tipo === "cuota" ? r.cuota : 0,
    porcentaje_bp: r.tipo === "porcentaje" ? r.porcentaje_bp : null,
    monto_centavos: r.tipo === "porcentaje" ? null : r.monto_centavos,
  }));
export type ReglaAlta = z.infer<typeof esquemaReglaComision>;

// tarifas_dia[i] = centavos del día i + 1 trabajado en la semana (1.º, 2.º…).
// Si un RP trabaja más días que los configurados, se repite el último
// (registrar_pago_dia).
export const esquemaRp = z
  .object({
    modo_pago: z.enum(MODOS_PAGO_RP, "Elige cómo se paga a los RPs."),
    regla: esquemaReglaComision.nullable(),
    visibilidad: z.enum(NIVELES_VISIBILIDAD, "Elige qué ven los RPs de sus clientes."),
    tarifas_dia: z
      .array(z.number(MSG_TARIFA).int(MSG_TARIFA).min(0, MSG_TARIFA).max(MONTO_MAXIMO_CENTAVOS, MSG_TARIFA))
      .max(MAX_TARIFAS_DIA, `Máximo ${MAX_TARIFAS_DIA} días con tarifa.`),
  })
  .superRefine((r, ctx) => {
    if (r.modo_pago === "reserva" && !r.regla) {
      ctx.addIssue({ code: "custom", path: ["regla"], message: "Configura la regla de comisión por reserva." });
    }
    if (r.modo_pago === "dia" && r.tarifas_dia.length === 0) {
      ctx.addIssue({ code: "custom", path: ["tarifas_dia"], message: "Escribe al menos la tarifa del día 1." });
    }
  });
export type RpAlta = z.infer<typeof esquemaRp>;

// Lo que el asistente tiene escrito en el paso de reglas (texto) → lo que
// valida esquemaRp. Lo del modo ELEGIDO viaja siempre (y zod marca lo que
// falte). Lo del OTRO modo también se guarda si está completo y es válido:
// la regla por reserva en un antro por día y las tarifas por día en uno por
// reserva (admin_alta_club guarda las dos cosas). Así un clon sale igual a
// su origen y, si el antro cambia de modo después, ya tiene con qué pagar
// (nunca las columnas viejas en $0). Si está incompleto, no viaja (no se
// puede marcar un error en un campo que el paso no muestra).
// conv: conversiones de texto (pesos → centavos, porcentaje → bp; null si
// no es válido), para no depender aquí de lib/cover ni de config-rp.
export interface TextosRp {
  modo_pago: ModoPagoRp;
  tipo: (typeof TIPOS_REGLA)[number];
  monto_texto: string;
  porcentaje_texto: string;
  cuota_texto: string;
  visibilidad: (typeof NIVELES_VISIBILIDAD)[number];
  tarifas: string[];
}
export function entradaRpDeTextos(
  r: TextosRp,
  conv: { centavos: (texto: string) => number | null; bp: (texto: string) => number | null },
): z.input<typeof esquemaRp> {
  const centavos = (t: string) => (t.trim() ? (conv.centavos(t.trim()) ?? Number.NaN) : Number.NaN);
  const regla = {
    tipo: r.tipo,
    cuota: r.tipo === "cuota" ? (r.cuota_texto.trim() ? Number(r.cuota_texto) : Number.NaN) : 0,
    porcentaje_bp: r.tipo === "porcentaje" ? conv.bp(r.porcentaje_texto) : null,
    monto_centavos: r.tipo === "porcentaje" ? null : r.monto_texto.trim() ? centavos(r.monto_texto) : null,
  };
  // Para el modo que no se eligió: sin las casillas vacías del final y solo
  // si todas las demás son válidas.
  const llenas = [...r.tarifas];
  while (llenas.length && !llenas[llenas.length - 1].trim()) llenas.pop();
  const tarifasExtra = llenas.map(centavos);
  const extraValidas =
    tarifasExtra.length <= MAX_TARIFAS_DIA &&
    tarifasExtra.every((c) => Number.isInteger(c) && c >= 0 && c <= MONTO_MAXIMO_CENTAVOS);
  return {
    modo_pago: r.modo_pago,
    regla: r.modo_pago === "reserva" ? regla : esquemaReglaComision.safeParse(regla).success ? regla : null,
    visibilidad: r.visibilidad,
    tarifas_dia: r.modo_pago === "dia" ? r.tarifas.map(centavos) : extraValidas ? tarifasExtra : [],
  };
}

// Permisos de caja por rol. Los valores por defecto son los de la plataforma
// (caja_tiene_permiso): el gerente puede todo; el staff recibe en la puerta,
// abre mesas, registra consumo, cobra y cierra. En el alta solo se guardan
// las casillas que CAMBIAN respecto de eso: si la plataforma cambia sus
// valores, el antro los sigue en lo que no tocó.
export const PERMISOS_CAJA_ALTA = [
  { permiso: "puerta", titulo: "Recibir en la puerta", detalle: "Escanear el QR y dar la entrada." },
  { permiso: "abrir_mesa", titulo: "Abrir mesas", detalle: "Sentar a un grupo en una mesa." },
  { permiso: "registrar_consumo", titulo: "Registrar consumo", detalle: "Agregar lo que se pide." },
  { permiso: "cobrar", titulo: "Cobrar", detalle: "Registrar pagos de la mesa." },
  { permiso: "cerrar_mesa", titulo: "Cerrar mesas", detalle: "Cuando el grupo ya pagó." },
  { permiso: "reabrir_mesa", titulo: "Reabrir mesas", detalle: "Con motivo; queda en la actividad." },
  { permiso: "anular", titulo: "Anular consumos y pagos", detalle: "Con motivo; queda en la actividad." },
  { permiso: "cuadrar_mesa", titulo: "Cuadrar mesas", detalle: "Con el cuadre nace la comisión del RP." },
  { permiso: "cerrar_noche", titulo: "Cerrar la noche", detalle: "Cierra la caja de toda la noche." },
] as const;
export type PermisoCajaAlta = (typeof PERMISOS_CAJA_ALTA)[number]["permiso"];
export const ROLES_CAJA = ["staff", "gerente"] as const;
export type RolCaja = (typeof ROLES_CAJA)[number];
const VALORES_PERMISO = PERMISOS_CAJA_ALTA.map((p) => p.permiso) as [PermisoCajaAlta, ...PermisoCajaAlta[]];
const PERMISOS_STAFF_POR_DEFECTO: ReadonlySet<string> = new Set(["puerta", "abrir_mesa", "registrar_consumo", "cobrar", "cerrar_mesa"]);

export function permisoPorDefecto(rol: RolCaja, permiso: PermisoCajaAlta): boolean {
  return rol === "gerente" || PERMISOS_STAFF_POR_DEFECTO.has(permiso);
}

export type MatrizPermisos = Record<RolCaja, Record<PermisoCajaAlta, boolean>>;
export function matrizPorDefecto(): MatrizPermisos {
  const fila = (rol: RolCaja) =>
    Object.fromEntries(VALORES_PERMISO.map((p) => [p, permisoPorDefecto(rol, p)])) as Record<PermisoCajaAlta, boolean>;
  return { staff: fila("staff"), gerente: fila("gerente") };
}

export const esquemaPermisoCaja = z.object({
  permiso: z.enum(VALORES_PERMISO, "Permiso de caja inválido."),
  rol: z.enum(ROLES_CAJA, "Los permisos de caja son para staff o gerente."),
  permitido: z.boolean(),
});
export type CambioPermisoCaja = z.infer<typeof esquemaPermisoCaja>;

export const esquemaPermisosCaja = z
  .array(esquemaPermisoCaja)
  .max(VALORES_PERMISO.length * ROLES_CAJA.length, "Demasiados permisos de caja.")
  .superRefine((lista, ctx) => {
    const vistos = new Set<string>();
    lista.forEach((x, i) => {
      const clave = `${x.permiso}|${x.rol}`;
      if (vistos.has(clave)) ctx.addIssue({ code: "custom", path: [i], message: "Hay un permiso de caja repetido." });
      vistos.add(clave);
    });
  });

// Solo las casillas distintas de la plataforma (lo que se manda a la base).
export function cambiosDePermisos(m: MatrizPermisos): CambioPermisoCaja[] {
  const salida: CambioPermisoCaja[] = [];
  for (const rol of ROLES_CAJA) {
    for (const permiso of VALORES_PERMISO) {
      const v = m[rol][permiso];
      if (v !== permisoPorDefecto(rol, permiso)) salida.push({ permiso, rol, permitido: v });
    }
  }
  return salida;
}

// ---------- Paso 5: equipo ----------
export const esquemaPersonal = z.object({ nombre: nombrePersona, correo, rol: z.enum(ROLES_PERSONAL) });
export type Personal = z.infer<typeof esquemaPersonal>;

// ---------- Paso 6: grupo ----------
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
    // B3: «grupo» = sigue la configuración del grupo (la base la aplica en
    // la misma transacción); «alta» = se queda con lo de este alta.
    config: z.enum(["grupo", "alta"]).optional().default("grupo"),
  }),
]);
export type Grupo = z.infer<typeof esquemaGrupo>;

// ---------- Todo junto ----------
export const esquemaAltaClub = z
  .object({
    datos: esquemaDatos,
    politicas: esquemaPoliticas,
    mesas: esquemaMesas,
    rp: esquemaRp,
    caja_permisos: esquemaPermisosCaja.optional().default([]),
    dueno: esquemaCuenta.nullable(),
    personal: z.array(esquemaPersonal).max(MAX_PERSONAL, `Máximo ${MAX_PERSONAL} personas en el alta.`),
    grupo: esquemaGrupo,
    publicar: z.boolean(),
    // Clon (B2): id del antro de origen. La base copia de ahí el catálogo de
    // productos (sin existencias); todo lo demás viaja arriba, ya revisado
    // por el admin en el asistente (sql/post-junta-2/11-clonar-club.sql).
    clonar_de: z.uuid("El antro de origen no es válido.").nullable().optional().default(null),
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
    // Un correo, una cuenta; y no más de MAX_PERSONAL cuentas en total
    // (contando dueño y dueño de grupo), igual que la base.
    const todas = cuentasNuevas(a);
    if (todas.length > MAX_PERSONAL) {
      ctx.addIssue({ code: "custom", path: ["personal"], message: `Máximo ${MAX_PERSONAL} cuentas en un alta (contando dueños).` });
    }
    const vistos = new Map<string, string>();
    for (const c of todas) {
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
// altaId: clave de idempotencia (la genera la ruta).
export function payloadSql(a: AltaClub, ids: ReadonlyMap<string, string>, altaId: string) {
  return {
    alta_id: altaId,
    club: {
      ...a.datos,
      ...a.politicas,
      ambiente: a.politicas.ambiente || null,
      tipo_musica: a.politicas.tipo_musica || null,
      codigo_vestimenta: a.politicas.codigo_vestimenta || null,
    },
    publicar: a.publicar,
    mesas: a.mesas.map((m) => ({ numero: m.numero.trim(), capacidad: m.capacidad })),
    rp: {
      modo_pago: a.rp.modo_pago,
      regla: a.rp.regla,
      visibilidad: a.rp.visibilidad,
      tarifas_dia: a.rp.tarifas_dia.map((monto_centavos, i) => ({ posicion: i + 1, monto_centavos })),
    },
    caja_permisos: a.caja_permisos,
    ...(a.clonar_de ? { clonar_de: a.clonar_de } : {}),
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
    // sql/post-junta-2/12-config-grupo.sql: «heredar» aplica los valores del
    // grupo al antro nuevo; «propio» deja los del alta. Sin el 12, se ignora.
    grupo_config: a.grupo.modo === "existente" && a.grupo.config === "alta" ? "propio" : "heredar",
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

// ---------- Clonar un antro (B2) ----------
// admin_club_plantilla(origen) (sql/post-junta-2/11-clonar-club.sql) devuelve
// SOLO configuración. Aquí se lee con zod (lo que no cuadre se ignora con un
// aviso, nunca truena) y se convierte en el texto que precarga el asistente.
// Nombre, dirección, equipo y fotos NO vienen: el antro nuevo es otro lugar
// con otra gente. El catálogo de productos no pasa por el navegador: lo
// copia la base al dar de alta (aquí solo se cuenta para el resumen).

const numeroONulo = z.preprocess(
  (v) => (v === null || v === undefined || v === "" ? null : Number(v)),
  z.number().finite().nullable(),
);
const textoONulo = z
  .string()
  .nullable()
  .optional()
  .transform((v) => v ?? "");

export const esquemaPlantilla = z.object({
  origen: z.object({ id: z.uuid(), nombre: z.string() }),
  club: z.object({
    ciudad: textoONulo,
    zona_horaria: textoONulo,
    horario: textoONulo,
    ambiente: textoONulo,
    tipo_musica: textoONulo,
    codigo_vestimenta: textoONulo,
    edad_minima: numeroONulo,
    deposito_monto: numeroONulo,
    cover_modo: textoONulo,
    cover_monto: numeroONulo,
    tolerancia_hora: textoONulo,
  }),
  mesas: z.array(z.object({ numero: z.string(), capacidad: z.number() })).catch([]),
  modo_pago: z.string().catch("reserva"),
  regla: z
    .object({
      origen: z.enum(["regla", "anterior"]),
      tipo: z.string(),
      cuota: numeroONulo,
      porcentaje_bp: numeroONulo,
      monto_centavos: numeroONulo,
    })
    .nullable()
    .catch(null),
  regla_programada_desde: z.string().nullable().catch(null),
  visibilidad: z.string().catch("estado_monto"),
  tarifas_dia: z.array(z.object({ posicion: z.number(), monto_centavos: z.number() })).catch([]),
  caja_permisos: z.array(z.object({ permiso: z.string(), rol: z.string(), permitido: z.boolean() })).catch([]),
  permisos_por_persona: z.number().catch(0),
  productos: z
    .array(
      z.object({
        nombre: z.string(),
        categoria: z.string(),
        precio_centavos: z.number(),
        existencias_minimas: z.number(),
        activo: z.boolean(),
      }),
    )
    .nullable()
    .catch(null),
  grupo_id: z.uuid().nullable().catch(null),
});
export type PlantillaClub = z.infer<typeof esquemaPlantilla>;

// Lo que precarga el asistente, en texto (como lo escribiría el admin).
export interface PrecargaClon {
  origen: { id: string; nombre: string };
  datos: { ciudad: string; zona_horaria: string; horario: string };
  politicas: {
    cover_modo: (typeof COVER_MODOS)[number];
    cover_texto: string;
    deposito_texto: string;
    edad_texto: string;
    codigo_vestimenta: string;
    tipo_musica: string;
    ambiente: string;
    tolerancia_hora: string;
  };
  mesas: Mesa[];
  rp: {
    modo_pago: ModoPagoRp;
    tipo: (typeof TIPOS_REGLA)[number];
    monto_texto: string;
    porcentaje_texto: string;
    cuota_texto: string;
    visibilidad: (typeof NIVELES_VISIBILIDAD)[number];
    tarifas: string[];
  };
  permisos: { personalizar: boolean; matriz: MatrizPermisos };
  grupo_id: string | null;
  // Catálogo que copiará la base (null = no hay catálogo: fase 2 apagada).
  productos: { total: number; activos: number; nombres: string[] } | null;
  // Lo que el admin debe revisar porque no se copió igual.
  avisos: string[];
}

// Centavos → "150" o "150.50" (lo que acepta parsearPesosACentavos).
export function centavosATexto(c: number): string {
  const n = Math.round(c);
  return n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2);
}
// Puntos base → "12.5".
export function bpATexto(bp: number): string {
  return String(Math.round(bp) / 100);
}
const COVER_MODOS = ["oculto", "monto", "libre", "consultar"] as const;
const enLista = <T extends string>(lista: readonly T[], v: string): v is T => (lista as readonly string[]).includes(v);

export function precargaDesdePlantilla(p: PlantillaClub): PrecargaClon {
  const avisos: string[] = [];
  const c = p.club;

  const zonaValida = enLista(VALORES_ZONA, c.zona_horaria);
  if (c.zona_horaria && !zonaValida) {
    avisos.push(`La zona horaria del origen («${c.zona_horaria}») no está en la lista: se puso la del Centro; revísala.`);
  }

  const cover_modo = enLista(COVER_MODOS, c.cover_modo) ? c.cover_modo : "oculto";
  const tolerancia = /^([01]\d|2[0-3]):[0-5]\d$/.test(c.tolerancia_hora) ? c.tolerancia_hora : "";

  // Mesas: nombre y capacidad, sin repetir y hasta el máximo del alta.
  const vistas = new Set<string>();
  const mesas: Mesa[] = [];
  for (const m of p.mesas) {
    const clave = m.numero.trim().toLowerCase();
    if (!clave || vistas.has(clave)) continue;
    vistas.add(clave);
    mesas.push({ numero: m.numero.trim(), capacidad: m.capacidad });
  }
  if (mesas.length > MAX_MESAS) {
    avisos.push(`El origen tiene ${mesas.length} mesas; el alta acepta ${MAX_MESAS}: se copiaron las primeras ${MAX_MESAS}.`);
    mesas.length = MAX_MESAS;
  }

  // Regla de comisión: la que manda hoy en el origen.
  const modo_pago: ModoPagoRp = p.modo_pago === "dia" ? "dia" : "reserva";
  const r = p.regla;
  let tipo: PrecargaClon["rp"]["tipo"] = "fijo";
  let monto_texto = "";
  let porcentaje_texto = "";
  let cuota_texto = "4";
  if (r && enLista(TIPOS_REGLA, r.tipo)) {
    tipo = r.tipo;
    if (r.monto_centavos != null && r.monto_centavos > 0) monto_texto = centavosATexto(r.monto_centavos);
    if (r.porcentaje_bp != null && r.porcentaje_bp > 0) porcentaje_texto = bpATexto(r.porcentaje_bp);
    if (r.tipo === "cuota" && r.cuota != null && r.cuota > 0) cuota_texto = String(r.cuota);
  }
  const reglaCompleta = esquemaReglaComision.safeParse({
    tipo,
    cuota: tipo === "cuota" ? Number(cuota_texto) : 0,
    porcentaje_bp: tipo === "porcentaje" ? (r?.porcentaje_bp ?? null) : null,
    monto_centavos: tipo === "porcentaje" ? null : (r?.monto_centavos ?? null),
  }).success;
  if (modo_pago === "reserva") {
    if (!r || r.origen === "anterior") {
      avisos.push(
        "El origen todavía calcula la comisión con la regla anterior (sin regla nueva): revisa la regla del paso «Reglas de comisión y RPs».",
      );
    }
    if (!reglaCompleta) avisos.push("La regla del origen no está completa (por ejemplo, $0): escríbela antes de seguir.");
  } else if (r?.origen === "regla" && reglaCompleta) {
    // Se copia igual que en el origen (entradaRpDeTextos la manda aunque el
    // modo sea por día): si el antro nuevo pasa a «por reserva», ya la tiene.
    avisos.push("El origen paga por día y además tiene regla por reserva: se copia igual, guardada por si el antro nuevo pasa a pagar por reserva.");
  } else {
    // Sin regla nueva en el origen (o incompleta): no se inventa una con las
    // columnas viejas; el paso queda vacío y no viaja.
    monto_texto = "";
    porcentaje_texto = "";
    if (r?.origen === "regla") avisos.push("El origen paga por día y su regla por reserva no está completa: no se copia.");
  }
  if (p.regla_programada_desde) {
    avisos.push(`El origen tiene una regla programada desde el ${p.regla_programada_desde}: no se copia; se copia la que vale hoy.`);
  }

  // Tarifas por día, en orden; hasta 7.
  const tarifas = [...p.tarifas_dia]
    .filter((t) => t.posicion >= 1 && t.posicion <= MAX_TARIFAS_DIA)
    .sort((a, b) => a.posicion - b.posicion)
    .map((t) => centavosATexto(t.monto_centavos));
  if (modo_pago === "reserva" && tarifas.length > 0) {
    avisos.push(
      tarifas.length === 1
        ? "El origen paga por reserva y además tiene 1 tarifa por día: se copia igual, guardada por si el antro nuevo pasa a pagar por día."
        : `El origen paga por reserva y además tiene ${tarifas.length} tarifas por día: se copian igual, guardadas por si el antro nuevo pasa a pagar por día.`,
    );
  }

  // Permisos de caja por rol: se parte de la plataforma y se aplica lo del origen.
  const matriz = matrizPorDefecto();
  for (const x of p.caja_permisos) {
    if (enLista(ROLES_CAJA, x.rol) && enLista(VALORES_PERMISO, x.permiso)) matriz[x.rol][x.permiso] = x.permitido;
  }
  const personalizar = cambiosDePermisos(matriz).length > 0;
  if (p.permisos_por_persona > 0) {
    avisos.push(
      p.permisos_por_persona === 1
        ? "1 permiso de caja por persona no se copia (el personal no pasa al antro nuevo)."
        : `${p.permisos_por_persona} permisos de caja por persona no se copian (el personal no pasa al antro nuevo).`,
    );
  }

  const visibilidad = enLista(NIVELES_VISIBILIDAD, p.visibilidad) ? p.visibilidad : "estado_monto";

  return {
    origen: p.origen,
    datos: { ciudad: c.ciudad, zona_horaria: zonaValida ? c.zona_horaria : "America/Mexico_City", horario: c.horario },
    politicas: {
      cover_modo,
      cover_texto: cover_modo === "monto" && c.cover_monto != null && c.cover_monto > 0 ? centavosATexto(c.cover_monto * 100) : "",
      deposito_texto: c.deposito_monto != null && c.deposito_monto > 0 ? centavosATexto(c.deposito_monto * 100) : "",
      edad_texto: c.edad_minima != null ? String(c.edad_minima) : "",
      codigo_vestimenta: c.codigo_vestimenta,
      tipo_musica: c.tipo_musica,
      ambiente: c.ambiente,
      tolerancia_hora: tolerancia,
    },
    mesas,
    rp: { modo_pago, tipo, monto_texto, porcentaje_texto, cuota_texto, visibilidad, tarifas: tarifas.length ? tarifas : [""] },
    permisos: { personalizar, matriz },
    grupo_id: p.grupo_id,
    productos: p.productos
      ? { total: p.productos.length, activos: p.productos.filter((x) => x.activo).length, nombres: p.productos.map((x) => x.nombre) }
      : null,
    avisos,
  };
}

// Qué NO se copia nunca (se muestra en el resumen).
export const NO_SE_COPIA_CLON = [
  "Nombre, dirección y ubicación",
  "Reservas y consumos",
  "Caja: noches, mesas, cuentas, pagos y cuadres",
  "Comisiones y pagos por día",
  "Turnos y asistencias",
  "Fotos y documentos de verificación",
  "Dueño, personal y cuentas",
  "Permisos de caja por persona y sueldos individuales de RPs",
  "Existencias e historial de inventario",
  "Suscripción y verificación (nace en borrador, salvo que lo publiques)",
] as const;
