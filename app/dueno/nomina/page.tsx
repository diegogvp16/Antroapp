"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Label } from "@/components/ui/label";
import { SELECT_CLASSES } from "@/components/caja/accion";
import { ReporteNomina } from "@/components/nomina/reporte-nomina";

interface AntroDueno {
  id: string;
  nombre: string;
}

type Estado =
  | { tipo: "cargando" }
  | { tipo: "error"; mensaje: string }
  | { tipo: "sin_antro" }
  | { tipo: "listo"; antros: AntroDueno[] };

// Nómina semanal de los RPs para el dueño. Un dueño puede tener varios
// antros: si hay más de uno, elige cuál ver (no se usa maybeSingle).
export default function DuenoNominaPage() {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });
  const [clubId, setClubId] = useState<string | null>(null);

  useEffect(() => {
    async function cargarSesion() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/dueno/login");
        return;
      }
      const { data: perfil, error } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (error || !perfil || perfil.role !== "dueno") {
        router.replace("/dueno/login");
        return;
      }
      const clubsRes = await supabase
        .from("clubs")
        .select("id, nombre")
        .eq("dueno_id", user.id)
        .order("nombre", { ascending: true });
      if (clubsRes.error) {
        setEstado({ tipo: "error", mensaje: clubsRes.error.message });
        return;
      }
      const antros = (clubsRes.data ?? []) as AntroDueno[];
      if (antros.length === 0) {
        setEstado({ tipo: "sin_antro" });
        return;
      }
      setClubId(antros[0].id);
      setEstado({ tipo: "listo", antros });
    }
    cargarSesion();
  }, [router]);

  const antros = estado.tipo === "listo" ? estado.antros : [];
  const antro = antros.find((a) => a.id === clubId) ?? null;

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <Link
          href="/dueno/panel"
          className="w-fit text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          ← Panel
        </Link>

        <h1 className="break-words text-2xl font-semibold tracking-tight">
          Nómina de RPs{antro && antros.length === 1 ? ` · ${antro.nombre}` : ""}
        </h1>

        {estado.tipo === "cargando" && (
          <p className="text-sm text-muted-foreground">Cargando...</p>
        )}

        {estado.tipo === "error" && (
          <p className="text-sm break-words text-destructive" role="alert">
            {estado.mensaje}
          </p>
        )}

        {estado.tipo === "sin_antro" && (
          <p className="text-sm text-muted-foreground">
            No encontramos ningún antro a tu nombre.
          </p>
        )}

        {antros.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nomina_antro">Antro</Label>
            <select
              id="nomina_antro"
              className={SELECT_CLASSES}
              value={clubId ?? ""}
              onChange={(e) => setClubId(e.target.value)}
            >
              {antros.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nombre}
                </option>
              ))}
            </select>
          </div>
        )}

        {antro && (
          // key: al cambiar de antro se reinicia el reporte (no se mezclan datos).
          <ReporteNomina key={antro.id} clubId={antro.id} clubNombre={antro.nombre} />
        )}
      </div>
    </div>
  );
}
