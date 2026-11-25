"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import type { EstadoReglasAntro, SaludPlataforma } from "@/lib/domain/salud";
import { Button } from "@/components/ui/button";
import { EstadoServicio } from "@/components/admin/salud/estado-servicio";
import { ResumenAccesos } from "@/components/admin/salud/resumen-accesos";
import { ErroresAgrupados } from "@/components/admin/salud/errores-agrupados";
import { ReglasComisionEstado } from "@/components/admin/salud/reglas-comision-estado";

const horaMx = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// Salud de la plataforma (solo admin): servicio, inicios de sesión,
// registros, reservas sin cuenta, errores y reglas de pago por antro. Todo
// sale de admin_salud() y admin_salud_reglas() (sql/post-junta-2/32-salud.sql),
// que revisan en la base que quien llama sea admin; aquí solo se redirige.
export default function SaludAdminPage() {
  const router = useRouter();
  const [listo, setListo] = useState(false);
  const [salud, setSalud] = useState<SaludPlataforma | null>(null);
  const [reglas, setReglas] = useState<EstadoReglasAntro[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    const supabase = createClient();
    const [s, r] = await Promise.all([supabase.rpc("admin_salud"), supabase.rpc("admin_salud_reglas")]);
    if (s.error || r.error) {
      setError(mensajeParaUsuario(s.error ?? r.error, "No pudimos cargar la salud de la plataforma."));
    } else {
      setSalud(s.data as SaludPlataforma);
      setReglas((r.data ?? []) as EstadoReglasAntro[]);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return router.replace("/admin/login");
      const { data: perfil } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (perfil?.role !== "admin") return router.replace("/admin/login");
      setListo(true);
      void cargar();
    })();
  }, [cargar, router]);

  if (!listo) {
    return (
      <div className="flex flex-1 flex-col items-center px-4 py-8 sm:px-6">
        <div className="flex w-full max-w-3xl flex-col gap-6">
          <p className="text-sm text-muted-foreground" role="status">
            Cargando…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-8 sm:px-6">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <Link href="/admin" className="inline-flex min-h-10 w-fit items-center text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Panel admin
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col">
            <h1 className="text-2xl font-semibold tracking-tight">Salud de la plataforma</h1>
            {salud && <span className="text-xs text-muted-foreground">Actualizado a las {horaMx.format(new Date(salud.generado_en))}</span>}
          </div>
          <Button type="button" variant="outline" className="h-10" onClick={() => void cargar()} disabled={cargando}>
            {cargando ? "Actualizando…" : "Actualizar"}
          </Button>
        </div>

        <EstadoServicio />

        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-status-err">
            <span>{error}</span>
            <Button type="button" variant="outline" className="h-10" onClick={() => void cargar()} disabled={cargando}>
              Reintentar
            </Button>
          </div>
        )}

        {!salud && !error ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : (
          salud && (
            <>
              <ResumenAccesos s={salud} />
              <ErroresAgrupados errores={salud.errores} />
            </>
          )
        )}

        {reglas && <ReglasComisionEstado filas={reglas} />}
      </div>
    </div>
  );
}
