"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cerrarSesionDadoDeBaja } from "@/lib/cuenta-dada-de-baja";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TemaReportesContenedor } from "@/components/tema-reportes";
import { RevisionRps } from "@/components/fraude/revision-rps";

type Estado = { tipo: "cargando" } | { tipo: "solo_gerente" } | { tipo: "listo" };

// Revisión de RPs (antifraude) del gerente. El staff puro no la ve (no ve
// sueldos ni consumos de RPs) y el RP nunca; la base también lo impide.
export default function StaffRevisionPage() {
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
        .select("role, activo")
        .eq("id", user.id)
        .maybeSingle();
      if (perfil?.activo === false) {
        await cerrarSesionDadoDeBaja(supabase, router, { colaCaja: true });
        return;
      }
      if (error || !perfil || (perfil.role !== "staff" && perfil.role !== "gerente")) {
        router.replace("/cliente/login");
        return;
      }
      setEstado({ tipo: perfil.role === "gerente" ? "listo" : "solo_gerente" });
    }
    cargarSesion();
  }, [router]);

  return (
    <TemaReportesContenedor className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      {estado.tipo === "cargando" && (
        <p className="w-full max-w-2xl text-sm text-muted-foreground">Cargando...</p>
      )}
      {estado.tipo === "solo_gerente" && (
        <div className="flex w-full max-w-2xl flex-col gap-5">
          <h1 className="text-2xl font-semibold tracking-tight">Revisión de RPs</h1>
          <Card size="sm">
            <CardContent className="flex flex-col gap-3 px-4">
              <p className="text-sm">Solo el gerente revisa a los RPs.</p>
              <Link href="/staff/panel" className={buttonVariants({ variant: "outline", className: "h-10 w-fit" })}>
                Volver al panel
              </Link>
            </CardContent>
          </Card>
        </div>
      )}
      {estado.tipo === "listo" && <RevisionRps volverHref="/staff/panel" />}
    </TemaReportesContenedor>
  );
}
