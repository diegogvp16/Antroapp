"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Barrido de lo que el escáner de respaldo guarda en el teléfono
// (lib/puerta-respaldo.ts): en CUALQUIER pantalla (también si después usa el
// teléfono un cliente o un RP), al abrir, en cada cambio de pantalla (entrar
// y salir de una cuenta cambian de pantalla sin recargar) y cada 10 min. Si
// nunca se usó el escáner de respaldo aquí, solo pregunta si existe la base
// local. Se carga aparte para no pesar en las páginas del cliente.
const BARRIDO_MS = 10 * 60 * 1000;

async function barrer() {
  try {
    const { barrerDatosLocales, hayDatosPuerta } = await import("@/lib/puerta-respaldo");
    if (!(await hayDatosPuerta())) return;
    const [{ createClient }, { conLimite }] = await Promise.all([
      import("@/lib/supabase/client"),
      import("@/lib/domain/caja-cola"),
    ]);
    // Sin poder leer la sesión (sin red y con el token vencido), null: solo
    // se borra lo vencido, nunca lo de quien quizá sigue con la sesión.
    const id = await conLimite(
      createClient()
        .auth.getSession()
        .then(({ data }) => data.session?.user.id ?? null, () => null),
      3_000,
      null,
    );
    await barrerDatosLocales(id);
  } catch (e) {
    console.error("No se pudo revisar lo guardado del escáner de respaldo:", e);
  }
}

export function ServiceWorkerRegister() {
  const ruta = usePathname();

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("Error registrando service worker:", err);
      });
    }
    const t = window.setInterval(() => void barrer(), BARRIDO_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    void barrer();
  }, [ruta]);

  return null;
}
