// Matriz de permisos de caja para la pantalla de Equipo (B12).
//
// La base es la que decide y hace cumplir: caja_tiene_permiso (persona →
// rol → valor por defecto) y caja_configurar_permiso (solo dueño o admin).
// Aquí solo se muestra lo mismo que calcularía la base, para que el dueño
// vea qué puede hacer cada rol. Puro: sin "@/", lo cargan las pruebas.

export const PERMISOS_MATRIZ = [
  "puerta",
  "abrir_mesa",
  "registrar_consumo",
  "cobrar",
  "cerrar_mesa",
  "reabrir_mesa",
  "anular",
  "cuadrar_mesa",
  "cerrar_noche",
] as const;
export type PermisoMatriz = (typeof PERMISOS_MATRIZ)[number];
export type RolCaja = "staff" | "gerente";
export const ROLES_CAJA: readonly RolCaja[] = ["staff", "gerente"];

export const ETIQUETA_PERMISO: Record<PermisoMatriz, string> = {
  puerta: "Recibir en la puerta",
  abrir_mesa: "Abrir mesa",
  registrar_consumo: "Registrar consumo",
  cobrar: "Cobrar",
  cerrar_mesa: "Cerrar mesa",
  reabrir_mesa: "Reabrir mesa",
  anular: "Anular consumos y pagos",
  cuadrar_mesa: "Cuadrar mesa",
  cerrar_noche: "Cerrar la noche",
};

// Igual que el paso 3 de caja_tiene_permiso.
export function porDefecto(rol: RolCaja, permiso: PermisoMatriz): boolean {
  if (rol === "gerente") return true;
  return ["puerta", "abrir_mesa", "registrar_consumo", "cobrar", "cerrar_mesa"].includes(permiso);
}

export interface FilaPermiso {
  permiso: string;
  rol: string | null;
  profile_id: string | null;
  permitido: boolean;
}

// Valor efectivo de un rol (sin excepciones por persona) y si viene de una
// casilla guardada o del valor por defecto.
export function valorRol(filas: readonly FilaPermiso[], rol: RolCaja, permiso: PermisoMatriz): { permitido: boolean; propio: boolean } {
  const f = filas.find((x) => x.rol === rol && x.permiso === permiso && !x.profile_id);
  return f ? { permitido: f.permitido, propio: true } : { permitido: porDefecto(rol, permiso), propio: false };
}

export const esPermisoMatriz = (p: string): p is PermisoMatriz => (PERMISOS_MATRIZ as readonly string[]).includes(p);
