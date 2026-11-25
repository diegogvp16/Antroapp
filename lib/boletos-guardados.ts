// Boletos guardados en ESTE teléfono (localStorage), para que quien reserva
// SIN cuenta y recarga la página no pierda su QR. Quien tiene sesión no
// guarda nada aquí (sus boletos están en Mi perfil), y al cerrar sesión en
// /cliente/perfil se borra la lista, para que en un teléfono compartido el
// siguiente no vea el boleto de otro. Es una comodidad del dispositivo, no
// la fuente de verdad: el boleto real siempre se lee de la base en
// /r/<codigo>. Todo va en try/catch: en modo privado, con datos bloqueados o
// en una vista previa, el almacenamiento puede fallar y la página sigue
// funcionando igual (solo no recuerda el boleto).
//
// Qué se guarda y qué no: lib/domain/boleto.ts (código, antro, su zona,
// fecha y personas; nunca teléfono ni nombre). Cada boleto se purga con la
// noche operativa de la zona de su antro (corte 08:00 locales).

import { nocheOperativaEn } from "@/lib/fechas";
import {
  CLAVE_BOLETOS,
  agregarBoleto,
  esZonaGuardable,
  leerBoletos,
  type BoletoGuardado,
} from "@/lib/domain/boleto";

const nochePara = (zona: string | undefined) => nocheOperativaEn(zona);

export function boletosGuardados(): BoletoGuardado[] {
  try {
    return leerBoletos(window.localStorage.getItem(CLAVE_BOLETOS), nochePara);
  } catch {
    return [];
  }
}

// Devuelve true si quedó guardado. `zona` es clubs.zona_horaria; si no es
// una zona con forma válida se guarda sin ella (se purga con la de CDMX).
export function guardarBoleto(
  boleto: Omit<BoletoGuardado, "guardadoEn" | "zona"> & { zona?: string | null },
): boolean {
  try {
    const { zona, ...resto } = boleto;
    const nuevo: BoletoGuardado = {
      ...resto,
      guardadoEn: Date.now(),
      ...(esZonaGuardable(zona) ? { zona } : {}),
    };
    const lista = agregarBoleto(leerBoletos(window.localStorage.getItem(CLAVE_BOLETOS), nochePara), nuevo, nochePara);
    window.localStorage.setItem(CLAVE_BOLETOS, JSON.stringify(lista));
    return lista.some((b) => b.qr === boleto.qr);
  } catch {
    return false;
  }
}

// Borra todos los boletos guardados en este teléfono (al cerrar sesión).
export function olvidarBoletos(): void {
  try {
    window.localStorage.removeItem(CLAVE_BOLETOS);
  } catch {
    // Sin almacenamiento no hay nada que borrar.
  }
}
