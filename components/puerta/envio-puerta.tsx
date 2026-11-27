"use client";

// Entradas de la puerta guardadas sin señal (escáner de respaldo), en todas
// las pantallas de staff (va en app/staff/layout.tsx, como la cola de caja):
//  - las manda solas al volver la señal, al volver a la app y cada 20 s
//    mientras haya pendientes (con espera creciente si la red sigue mal);
//  - dice cuántas faltan por enviar y cómo quedaron las enviadas: una que
//    ya había registrado otro teléfono o persona se muestra como "ya había
//    entrado" (no se contó dos veces), no como error;
//  - con pendientes, avisa antes de cerrar la pestaña o la app.
// Si nunca se usó el escáner de respaldo en este teléfono, no hace nada.

import { useEffect, useRef, useState } from "react";
import { CircleCheck, CloudUpload, Copy, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { textoPendientes } from "@/lib/domain/puerta-respaldo";
import { quitarEntradas } from "@/lib/puerta-respaldo";
import { enviarPendientesPuerta, useEntradasPuerta, useSesionUsuario } from "@/lib/use-puerta-respaldo";
import { useEnLinea } from "@/lib/use-en-linea";
import { esperaMs } from "@/lib/domain/caja-cola";

const hora = (iso: string) => new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function EnvioPuerta() {
  const { usuarioId } = useSesionUsuario();
  const enLinea = useEnLinea();
  const { entradas, pendientes, persistente } = useEntradasPuerta(usuarioId);
  const [enviando, setEnviando] = useState(false);
  const fallos = useRef(0);

  // Enviar: al volver la red, al volver a la pantalla y cada cierto tiempo.
  useEffect(() => {
    if (!usuarioId || !enLinea || pendientes === 0) return;
    let vivo = true;
    let t: number | undefined;
    const intentar = async () => {
      if (!vivo || !navigator.onLine) return;
      setEnviando(true);
      const r = await enviarPendientesPuerta(usuarioId).catch(() => null);
      if (!vivo) return;
      setEnviando(false);
      fallos.current = r?.falloRed ? fallos.current + 1 : 0;
      t = window.setTimeout(intentar, r?.falloRed ? esperaMs(fallos.current, Math.random()) : 20_000);
    };
    void intentar();
    const alVolver = () => document.visibilityState === "visible" && void intentar();
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      vivo = false;
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [usuarioId, enLinea, pendientes]);

  // Cerrar la pestaña o la app con entradas sin enviar: el navegador pregunta.
  useEffect(() => {
    if (pendientes === 0) return;
    const aviso = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", aviso);
    return () => window.removeEventListener("beforeunload", aviso);
  }, [pendientes]);

  const enviadas = entradas.filter((x) => x.estado === "enviada");
  const duplicadas = entradas.filter((x) => x.estado === "duplicada");
  const rechazadas = entradas.filter((x) => x.estado === "rechazada");
  if (!usuarioId || (pendientes === 0 && !enviadas.length && !duplicadas.length && !rechazadas.length)) return null;

  const entendido = (xs: typeof entradas) => void quitarEntradas(xs.map((x) => x.clave)).catch(() => {});

  return (
    <div className="flex w-full justify-center px-4 pt-3" data-prueba="envio-puerta">
      <div className="flex w-full max-w-md flex-col gap-2">
        {pendientes > 0 && (
          <div role="status" className="flex items-start gap-3 rounded-lg border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-sm">
            <CloudUpload className="mt-0.5 size-4 shrink-0 text-status-warn" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              <span className="font-medium" data-prueba="puerta-pendientes">{`Puerta: ${textoPendientes(pendientes)}`}</span>
              <span className="block text-xs text-muted-foreground">
                {!enLinea
                  ? "Sin señal: se envían solas cuando vuelva. No las confirmes otra vez."
                  : enviando
                    ? "Enviando…"
                    : "Se reintenta solo. No las confirmes otra vez."}
                {!persistente && " Este navegador no deja guardar: no cierres la app."}
              </span>
            </p>
          </div>
        )}
        {enviadas.length > 0 && (
          <div role="status" className="flex items-center gap-3 rounded-lg border border-status-ok/40 bg-status-ok/10 px-3 py-2 text-sm">
            <CircleCheck className="size-4 shrink-0 text-status-ok" aria-hidden="true" />
            <p className="min-w-0 flex-1 font-medium">
              {enviadas.length === 1 ? "Puerta: se envió 1 entrada guardada sin señal" : `Puerta: se enviaron ${enviadas.length} entradas guardadas sin señal`}
            </p>
            <Button type="button" variant="outline" className="h-11 shrink-0" onClick={() => entendido(enviadas)}>
              Entendido
            </Button>
          </div>
        )}
        {duplicadas.length > 0 && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-sm" data-prueba="puerta-duplicadas">
            <p className="flex items-center gap-2 font-medium">
              <Copy className="size-4 shrink-0 text-status-warn" aria-hidden="true" />
              {duplicadas.length === 1 ? "Puerta: 1 entrada ya estaba registrada" : `Puerta: ${duplicadas.length} entradas ya estaban registradas`}
            </p>
            <ul className="flex flex-col gap-1">
              {duplicadas.map((x) => (
                <li key={x.clave} className="break-words text-xs">
                  <span className="font-medium">{x.clienteNombre}</span> (la confirmaste a las {hora(x.escaneadoEn)}): {x.motivo}
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" className="h-11 self-end" onClick={() => entendido(duplicadas)}>
              Entendido
            </Button>
          </div>
        )}
        {rechazadas.length > 0 && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-status-err/40 bg-status-err/10 px-3 py-2 text-sm" data-prueba="puerta-rechazadas">
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlert className="size-4 shrink-0 text-status-err" aria-hidden="true" />
              {rechazadas.length === 1 ? "Puerta: 1 entrada no se guardó" : `Puerta: ${rechazadas.length} entradas no se guardaron`}
            </p>
            <ul className="flex flex-col gap-1">
              {rechazadas.map((x) => (
                <li key={x.clave} className="break-words text-xs">
                  <span className="font-medium">{x.clienteNombre}</span> (la confirmaste a las {hora(x.escaneadoEn)}): {x.motivo}
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" className="h-11 self-end" onClick={() => entendido(rechazadas)}>
              Entendido
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
