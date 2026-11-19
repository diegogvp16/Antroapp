"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ReporteNomina } from "@/components/nomina/reporte-nomina";

type Estado =
  | { tipo: "cargando" }
  | { tipo: "solo_gerente" }
  | { tipo: "error"; mensaje: string }
  | { tipo: "listo"; clubId: string; clubNombre: string };

// Nómina semanal de los RPs. Solo el gerente: el staff no ve sueldos (la
// base también lo impide en nomina_semana).
export default function StaffNominaPage() {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });

  useEffect(() => {
    async function cargarSesion() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/cliente/login");
        return;
      }
      const { data: perfil, error } = await supabase
        .from("profiles")
        .select("role, club_id")
        .eq("id", user.id)
        .maybeSingle();
      if (error || !perfil || (perfil.role !== "staff" && perfil.role !== "gerente")) {
        router.replace("/cliente/login");
        return;
      }
      if (perfil.role === "staff") {
        setEstado({ tipo: "solo_gerente" });
        return;
      }
      const clubId = perfil.club_id as string | null;
      if (!clubId) {
        setEstado({ tipo: "error", mensaje: "Tu cuenta no está ligada a ningún antro." });
        return;
      }
      const clubRes = await supabase.from("clubs").select("nombre").eq("id", clubId).maybeSingle();
      if (clubRes.error) {
        setEstado({ tipo: "error", mensaje: clubRes.error.message });
        return;
      }
      setEstado({
        tipo: "listo",
        clubId,
        clubNombre: (clubRes.data?.nombre as string | undefined) ?? "",
      });
    }
    cargarSesion();
  }, [router]);

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <Link
          href="/staff/panel"
          className="w-fit text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          ← Panel
        </Link>

        <h1 className="break-words text-2xl font-semibold tracking-tight">
          Nómina de RPs
          {estado.tipo === "listo" && estado.clubNombre ? ` · ${estado.clubNombre}` : ""}
        </h1>

        {estado.tipo === "cargando" && (
          <p className="text-sm text-muted-foreground">Cargando...</p>
        )}

        {estado.tipo === "solo_gerente" && (
          <Card size="sm">
            <CardContent className="flex flex-col gap-3 px-4">
              <p className="text-sm">Solo el gerente ve la nómina.</p>
              <Link
                href="/staff/panel"
                className={buttonVariants({ variant: "outline", size: "sm", className: "w-fit" })}
              >
                Volver al panel
              </Link>
            </CardContent>
          </Card>
        )}

        {estado.tipo === "error" && (
          <p className="text-sm break-words text-destructive" role="alert">
            {estado.mensaje}
          </p>
        )}

        {estado.tipo === "listo" && (
          <ReporteNomina clubId={estado.clubId} clubNombre={estado.clubNombre} />
        )}
      </div>
    </div>
  );
}
