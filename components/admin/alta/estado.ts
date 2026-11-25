// Estado del asistente de alta (lo que el admin va escribiendo, como texto) y
// su conversión a lo que validan los esquemas de lib/domain/alta-club.ts.

import { z } from "zod";
import { parsearPesosACentavos } from "@/lib/cover";
import { porcentajeABp, type NivelVisibilidad, type TipoRegla } from "@/lib/domain/config-rp";
import {
  cambiosDePermisos,
  erroresPorCampo,
  esquemaAltaClub,
  esquemaCuenta,
  esquemaDatos,
  esquemaGrupo,
  esquemaMesas,
  esquemaPermisosCaja,
  esquemaPersonal,
  esquemaPoliticas,
  esquemaRp,
  matrizPorDefecto,
  type EntradaAltaClub,
  type MatrizPermisos,
  type Mesa,
  type ModoPagoRp,
  type PrecargaClon,
  type RolPersonal,
} from "@/lib/domain/alta-club";
import type { CoverModo } from "@/types";

export type FilaPersonal = { clave: string; nombre: string; correo: string; rol: RolPersonal };
export type FilaMesa = Mesa & { clave: string };

export interface Borrador {
  datos: { nombre: string; direccion: string; ciudad: string; zona_horaria: string; horario: string };
  politicas: {
    cover_modo: CoverModo;
    cover_texto: string;
    deposito_texto: string;
    edad_texto: string;
    codigo_vestimenta: string;
    tipo_musica: string;
    ambiente: string;
    tolerancia_hora: string;
  };
  mesas: FilaMesa[];
  // Paso «Reglas de comisión y RPs» (texto tal como lo escribe el admin).
  rp: {
    modo_pago: ModoPagoRp;
    tipo: TipoRegla;
    monto_texto: string;
    porcentaje_texto: string;
    cuota_texto: string;
    visibilidad: NivelVisibilidad;
    tarifas: { clave: string; texto: string }[];
  };
  // Permisos de caja: sin personalizar = los de la plataforma.
  permisos: { personalizar: boolean; matriz: MatrizPermisos };
  conDueno: boolean;
  dueno: { nombre: string; correo: string };
  personal: FilaPersonal[];
  grupo: {
    modo: "ninguno" | "nuevo" | "existente";
    nombre: string;
    grupo_id: string;
    dueno_grupo: "ninguno" | "dueno_antro" | "cuenta_nueva";
    cuenta: { nombre: string; correo: string };
  };
  publicar: boolean;
  // Clon (B2): de qué antro sale, qué catálogo copiará la base y qué revisar.
  clon: { origen: PrecargaClon["origen"]; productos: PrecargaClon["productos"]; avisos: string[] } | null;
}

export const BORRADOR_INICIAL: Borrador = {
  datos: { nombre: "", direccion: "", ciudad: "", zona_horaria: "America/Mexico_City", horario: "" },
  politicas: {
    cover_modo: "oculto",
    cover_texto: "",
    deposito_texto: "",
    edad_texto: "18",
    codigo_vestimenta: "",
    tipo_musica: "",
    ambiente: "",
    tolerancia_hora: "",
  },
  mesas: [],
  rp: {
    modo_pago: "reserva",
    tipo: "fijo",
    monto_texto: "",
    porcentaje_texto: "",
    cuota_texto: "4",
    visibilidad: "estado_monto",
    tarifas: [{ clave: "t0", texto: "" }],
  },
  permisos: { personalizar: false, matriz: matrizPorDefecto() },
  conDueno: true,
  dueno: { nombre: "", correo: "" },
  personal: [],
  grupo: { modo: "ninguno", nombre: "", grupo_id: "", dueno_grupo: "dueno_antro", cuenta: { nombre: "", correo: "" } },
  publicar: false,
  clon: null,
};

// Borrador de un clon: la configuración del origen ya precargada; nombre,
// dirección y equipo vacíos (el antro nuevo es otro lugar con otra gente).
// Si el origen está en un grupo, se propone el mismo grupo, sin tocar a su
// dueño. Nace en borrador como cualquier alta.
export function borradorDesdeClon(pre: PrecargaClon): Borrador {
  return {
    ...BORRADOR_INICIAL,
    datos: { ...BORRADOR_INICIAL.datos, ...pre.datos, nombre: "", direccion: "" },
    politicas: { ...pre.politicas },
    mesas: pre.mesas.map((m) => ({ ...m, clave: nuevaClave() })),
    rp: { ...pre.rp, tarifas: pre.rp.tarifas.map((texto) => ({ clave: nuevaClave(), texto })) },
    permisos: pre.permisos,
    grupo: pre.grupo_id
      ? { ...BORRADOR_INICIAL.grupo, modo: "existente", grupo_id: pre.grupo_id, dueno_grupo: "ninguno" }
      : BORRADOR_INICIAL.grupo,
    clon: { origen: pre.origen, productos: pre.productos, avisos: pre.avisos },
  };
}

export const PASOS = ["Datos", "Cover y políticas", "Mesas", "Reglas de comisión y RPs", "Equipo", "Grupo", "Resumen"] as const;
// Índices con nombre (el orden de PASOS manda).
export const PASO = { datos: 0, politicas: 1, mesas: 2, reglas: 3, equipo: 4, grupo: 5, resumen: 6 } as const;

let contador = 0;
export const nuevaClave = () => `f${Date.now().toString(36)}${(contador++).toString(36)}`;

// Pesos escritos ("350", "1,250.50") → número en pesos; NaN si no es válido.
function pesosDeTexto(texto: string): number {
  const centavos = parsearPesosACentavos(texto);
  return centavos == null ? Number.NaN : centavos / 100;
}

// Texto → centavos; NaN si no es válido (para que zod lo marque).
const centavosDeTexto = (texto: string) => parsearPesosACentavos(texto.trim()) ?? Number.NaN;

export function aEntradaRp(r: Borrador["rp"]): EntradaAltaClub["rp"] {
  return {
    modo_pago: r.modo_pago,
    regla:
      r.modo_pago === "reserva"
        ? {
            tipo: r.tipo,
            cuota: r.tipo === "cuota" ? (r.cuota_texto.trim() ? Number(r.cuota_texto) : Number.NaN) : 0,
            porcentaje_bp: r.tipo === "porcentaje" ? porcentajeABp(r.porcentaje_texto) : null,
            monto_centavos: r.tipo === "porcentaje" ? null : r.monto_texto.trim() ? centavosDeTexto(r.monto_texto) : null,
          }
        : null,
    visibilidad: r.visibilidad,
    tarifas_dia: r.modo_pago === "dia" ? r.tarifas.map((t) => (t.texto.trim() ? centavosDeTexto(t.texto) : Number.NaN)) : [],
  };
}

export function aEntrada(b: Borrador): EntradaAltaClub {
  const p = b.politicas;
  const grupo: EntradaAltaClub["grupo"] =
    b.grupo.modo === "ninguno"
      ? { modo: "ninguno" }
      : b.grupo.modo === "nuevo"
        ? {
            modo: "nuevo",
            nombre: b.grupo.nombre,
            dueno_grupo: b.grupo.dueno_grupo === "cuenta_nueva" ? "cuenta_nueva" : "dueno_antro",
            cuenta: b.grupo.dueno_grupo === "cuenta_nueva" ? b.grupo.cuenta : null,
          }
        : {
            modo: "existente",
            grupo_id: b.grupo.grupo_id,
            dueno_grupo: b.grupo.dueno_grupo,
            cuenta: b.grupo.dueno_grupo === "cuenta_nueva" ? b.grupo.cuenta : null,
          };
  return {
    datos: b.datos,
    politicas: {
      cover_modo: p.cover_modo,
      cover_monto: p.cover_modo === "monto" ? (p.cover_texto.trim() ? pesosDeTexto(p.cover_texto) : null) : null,
      deposito_monto: p.deposito_texto.trim() ? pesosDeTexto(p.deposito_texto) : 0,
      edad_minima: p.edad_texto.trim() ? Number(p.edad_texto) : null,
      codigo_vestimenta: p.codigo_vestimenta,
      tipo_musica: p.tipo_musica,
      ambiente: p.ambiente,
      tolerancia_hora: p.tolerancia_hora || null,
    },
    mesas: b.mesas.map(({ numero, capacidad }) => ({ numero, capacidad })),
    rp: aEntradaRp(b.rp),
    caja_permisos: b.permisos.personalizar ? cambiosDePermisos(b.permisos.matriz) : [],
    dueno: b.conDueno ? b.dueno : null,
    personal: b.personal.map(({ nombre, correo, rol }) => ({ nombre, correo, rol })),
    grupo,
    publicar: b.publicar,
    clonar_de: b.clon?.origen.id ?? null,
  };
}

const esquemaEquipo = z.object({ dueno: esquemaCuenta.nullable(), personal: z.array(esquemaPersonal) });

// Errores del paso i (vacío = se puede seguir). Las claves son rutas
// ("datos.nombre", "mesas.3.numero", "personal.0.correo").
export function erroresDelPaso(i: number, b: Borrador): Record<string, string> {
  const e = aEntrada(b);
  const conPrefijo = (prefijo: string, r: { success: true } | { success: false; error: z.ZodError }) => {
    if (r.success) return {};
    const salida: Record<string, string> = {};
    for (const [k, v] of Object.entries(erroresPorCampo(r.error))) salida[k ? `${prefijo}.${k}` : prefijo] = v;
    return salida;
  };
  switch (i) {
    case PASO.datos:
      return conPrefijo("datos", esquemaDatos.safeParse(e.datos));
    case PASO.politicas:
      return conPrefijo("politicas", esquemaPoliticas.safeParse(e.politicas));
    case PASO.mesas:
      return conPrefijo("mesas", esquemaMesas.safeParse(e.mesas));
    case PASO.reglas:
      return {
        ...conPrefijo("rp", esquemaRp.safeParse(e.rp)),
        ...conPrefijo("caja_permisos", esquemaPermisosCaja.safeParse(e.caja_permisos)),
      };
    case PASO.equipo: {
      const r = esquemaEquipo.safeParse({ dueno: e.dueno, personal: e.personal });
      if (!r.success) return erroresPorCampo(r.error);
      // Correos repetidos (la regla completa vive en esquemaAltaClub).
      const total = esquemaAltaClub.safeParse(e);
      if (!total.success) {
        const rep = total.error.issues.find((x) => x.path[0] === "personal" && x.message.includes("dos veces"));
        if (rep) return { personal: rep.message };
      }
      return {};
    }
    case PASO.grupo: {
      const r = conPrefijo("grupo", esquemaGrupo.safeParse(e.grupo));
      if (Object.keys(r).length) return r;
      const total = esquemaAltaClub.safeParse(e);
      if (!total.success) {
        const g = total.error.issues.find((x) => x.path[0] === "grupo" || x.message.includes("dos veces"));
        if (g) return { [g.path.map(String).join(".")]: g.message };
      }
      return {};
    }
    default: {
      const r = esquemaAltaClub.safeParse(e);
      return r.success ? {} : erroresPorCampo(r.error);
    }
  }
}

// Paso donde está el primer error de una ruta (para regresar al admin ahí).
export function pasoDeRuta(ruta: string): number {
  if (ruta.startsWith("datos")) return PASO.datos;
  if (ruta.startsWith("politicas")) return PASO.politicas;
  if (ruta.startsWith("mesas")) return PASO.mesas;
  if (ruta.startsWith("rp") || ruta.startsWith("caja_permisos")) return PASO.reglas;
  if (ruta.startsWith("dueno") || ruta.startsWith("personal")) return PASO.equipo;
  if (ruta.startsWith("grupo")) return PASO.grupo;
  return PASO.resumen;
}
