"use client";

import { useSyncExternalStore } from "react";

// Si el navegador cree que hay red (navigator.onLine). No basta para saber
// que hay internet (puede haber wifi sin salida): la caja además marca
// "reconectando" cuando falla una recarga.
function suscribir(aviso: () => void) {
  window.addEventListener("online", aviso);
  window.addEventListener("offline", aviso);
  return () => {
    window.removeEventListener("online", aviso);
    window.removeEventListener("offline", aviso);
  };
}

export function useEnLinea(): boolean {
  return useSyncExternalStore(
    suscribir,
    () => navigator.onLine,
    () => true,
  );
}
