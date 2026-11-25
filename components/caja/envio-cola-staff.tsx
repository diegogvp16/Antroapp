"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CloudUpload, TriangleAlert } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useColaCaja } from "@/lib/use-cola-caja";
import { useEnLinea } from "@/lib/use-en-linea";
import { textoPorEnviar } from "@/lib/domain/caja-cola";

// La cola de caja fuera de la Caja (panel, nómina, equipo…): la app de staff
// instalada abre en /staff/panel, y lo capturado sin señal tiene que salir
// también ahí al volver la red o al reabrir la app, no solo con la Caja
// abierta. Manda la cola con las mismas reglas (lib/use-cola-caja.ts) y
// avisa cuánto falta, con acceso directo a la Caja. En /staff/caja no hace
// nada: la Caja monta su propia cola.
export function EnvioColaStaff() {
  const ruta = usePathname();
  const enCaja = ruta?.startsWith("/staff/caja") ?? false;
  const [usuarioId, setUsuarioId] = useState<string | null>(null);

  useEffect(() => {
    if (enCaja) return;
    const supabase = createClient();
    let vivo = true;
    // getSession no usa la red salvo para renovar el token.
    void supabase.auth.getSession().then(
      ({ data }) => vivo && setUsuarioId(data.session?.user.id ?? null),
      () => {},
    );
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => {
      if (vivo) setUsuarioId(s?.user.id ?? null);
    });
    return () => {
      vivo = false;
      subscription.unsubscribe();
    };
  }, [enCaja]);

  if (enCaja || !usuarioId) return null;
  return <AvisoColaStaff usuarioId={usuarioId} />;
}

function AvisoColaStaff({ usuarioId }: { usuarioId: string }) {
  const enLinea = useEnLinea();
  const cola = useColaCaja({ usuarioId, enLinea });
  const pendientes = cola.movimientos.filter((x) => x.estado === "pendiente").length;
  const rechazados = cola.movimientos.filter((x) => x.estado === "rechazado").length;
  // Sesión cerrada u otra cuenta: la pantalla de abajo ya lleva al login.
  if (cola.sesion !== "ok" || (pendientes === 0 && rechazados === 0)) return null;

  const detalle =
    pendientes === 0
      ? null
      : !enLinea
        ? "Sin señal: se envían solos cuando vuelva."
        : cola.enviando
          ? "Enviando…"
          : pendientes === 1
            ? "Se reintenta solo. No lo captures otra vez."
            : "Se reintenta solo. No los captures otra vez.";
  return (
    <div className="flex w-full justify-center px-4 pt-3">
      <div className="flex w-full max-w-md flex-col gap-2">
        {pendientes > 0 && (
          <div role="status" className="flex items-center gap-3 rounded-lg border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-sm">
            <CloudUpload className="size-4 shrink-0 text-status-warn" aria-hidden="true" />
            <p className="min-w-0 flex-1">
              <span className="font-medium">{`Caja: ${textoPorEnviar(pendientes)}`}</span>
              {detalle && <span className="block text-xs text-muted-foreground">{detalle}</span>}
            </p>
            <Link
              href="/staff/caja"
              className="flex h-10 shrink-0 items-center rounded-md border border-border bg-background px-3 text-sm font-medium"
            >
              Abrir caja
            </Link>
          </div>
        )}
        {rechazados > 0 && (
          <div role="alert" className="flex items-center gap-3 rounded-lg border border-status-err/40 bg-status-err/10 px-3 py-2 text-sm">
            <TriangleAlert className="size-4 shrink-0 text-status-err" aria-hidden="true" />
            <p className="min-w-0 flex-1 font-medium">
              {rechazados === 1 ? "Caja: 1 movimiento no se guardó" : `Caja: ${rechazados} movimientos no se guardaron`}
            </p>
            <Link
              href="/staff/caja"
              className="flex h-10 shrink-0 items-center rounded-md border border-border bg-background px-3 text-sm font-medium"
            >
              Ver
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
