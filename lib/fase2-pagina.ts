"use client";

// Entrada a las pantallas de gerente de la fase 2 (bloque 8: reporte de
// inventario y propinas). Como /staff/catalogo: solo un gerente activo con
// antro; cualquier otro vuelve al panel. Trae también la zona horaria del
// antro para proponer la noche operativa de hoy. La base revisa permisos y
// bandera en cada llamada.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { FASE2_ACTIVA } from "@/lib/fase2";
import { nocheOperativaEn } from "@/lib/fechas";

export type EntradaGerente =
  | { tipo: "cargando" }
  | { tipo: "apagado" }
  | { tipo: "error"; mensaje: string }
  | { tipo: "listo"; clubId: string; nocheHoy: string };

export function useEntradaGerente(): EntradaGerente {
  const router = useRouter();
  const [estado, setEstado] = useState<EntradaGerente>(FASE2_ACTIVA ? { tipo: "cargando" } : { tipo: "apagado" });
  useEffect(() => {
    if (!FASE2_ACTIVA) return;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return router.replace("/cliente/login");
      const { data: perfil, error } = await supabase.from("profiles").select("role, club_id, activo").eq("id", user.id).maybeSingle();
      if (error) return setEstado({ tipo: "error", mensaje: mensajeParaUsuario(error, "No pudimos cargar tu cuenta. Intenta de nuevo.") });
      if (!perfil || perfil.role !== "gerente" || !perfil.club_id || perfil.activo === false) return router.replace("/staff/panel");
      const { data: club } = await supabase.from("clubs").select("zona_horaria").eq("id", perfil.club_id).maybeSingle();
      setEstado({ tipo: "listo", clubId: perfil.club_id as string, nocheHoy: nocheOperativaEn(club?.zona_horaria as string | null) });
    })();
  }, [router]);
  return estado;
}
