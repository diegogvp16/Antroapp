// Estado del asistente de alta (lo que el admin va escribiendo, como texto) y
// su conversión a lo que validan los esquemas de lib/domain/alta-club.ts.

import { z } from "zod";
import { parsearPesosACentavos } from "@/lib/cover";
import {
  erroresPorCampo,
  esquemaAltaClub,
  esquemaCuenta,
  esquemaDatos,
  esquemaGrupo,
  esquemaMesas,
  esquemaPersonal,
  esquemaPoliticas,
  type EntradaAltaClub,
  type Mesa,
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
  conDueno: true,
  dueno: { nombre: "", correo: "" },
  personal: [],
  grupo: { modo: "ninguno", nombre: "", grupo_id: "", dueno_grupo: "dueno_antro", cuenta: { nombre: "", correo: "" } },
  publicar: false,
};

export const PASOS = ["Datos", "Cover y políticas", "Mesas", "Equipo", "Grupo", "Resumen"] as const;

let contador = 0;
export const nuevaClave = () => `f${Date.now().toString(36)}${(contador++).toString(36)}`;

// Pesos escritos ("350", "1,250.50") → número en pesos; NaN si no es válido.
function pesosDeTexto(texto: string): number {
  const centavos = parsearPesosACentavos(texto);
  return centavos == null ? Number.NaN : centavos / 100;
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
    dueno: b.conDueno ? b.dueno : null,
    personal: b.personal.map(({ nombre, correo, rol }) => ({ nombre, correo, rol })),
    grupo,
    publicar: b.publicar,
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
    case 0:
      return conPrefijo("datos", esquemaDatos.safeParse(e.datos));
    case 1:
      return conPrefijo("politicas", esquemaPoliticas.safeParse(e.politicas));
    case 2:
      return conPrefijo("mesas", esquemaMesas.safeParse(e.mesas));
    case 3: {
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
    case 4: {
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
  if (ruta.startsWith("datos")) return 0;
  if (ruta.startsWith("politicas")) return 1;
  if (ruta.startsWith("mesas")) return 2;
  if (ruta.startsWith("dueno") || ruta.startsWith("personal")) return 3;
  if (ruta.startsWith("grupo")) return 4;
  return 5;
}
