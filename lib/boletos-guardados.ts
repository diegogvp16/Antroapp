// Boletos guardados en ESTE teléfono (localStorage), para que quien reserva
// sin cuenta y recarga la página no pierda su QR. Es una comodidad del
// dispositivo, no la fuente de verdad: el boleto real siempre se lee de la
// base en /r/<codigo>. Todo va en try/catch: en modo privado, con datos
// bloqueados o en una vista previa, el almacenamiento puede fallar y la
// página sigue funcionando igual (solo no recuerda el boleto).
//
// Qué se guarda y qué no: lib/domain/boleto.ts (código, antro, fecha y
// personas; nunca teléfono ni nombre).

import { nocheOperativaMexico } from "@/lib/fechas";
import {
  CLAVE_BOLETOS,
  agregarBoleto,
  leerBoletos,
  type BoletoGuardado,
} from "@/lib/domain/boleto";

export function boletosGuardados(): BoletoGuardado[] {
  try {
    return leerBoletos(window.localStorage.getItem(CLAVE_BOLETOS), nocheOperativaMexico());
  } catch {
    return [];
  }
}

// Devuelve true si quedó guardado.
export function guardarBoleto(boleto: Omit<BoletoGuardado, "guardadoEn">): boolean {
  try {
    const noche = nocheOperativaMexico();
    const lista = agregarBoleto(
      leerBoletos(window.localStorage.getItem(CLAVE_BOLETOS), noche),
      { ...boleto, guardadoEn: Date.now() },
      noche,
    );
    window.localStorage.setItem(CLAVE_BOLETOS, JSON.stringify(lista));
    return lista.some((b) => b.qr === boleto.qr);
  } catch {
    return false;
  }
}
