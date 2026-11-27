"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RevisionRps } from "@/components/fraude/revision-rps";

// Revisión de RPs (antifraude) del admin: todos los antros que tengan la
// bandera encendida (fraude_mis_antros). El tema lo pone el layout.
export default function AdminRevisionPage() {
  const router = useRouter();
  const [listo, setListo] = useState(false);

  useEffect(() => {
    async function cargarSesion() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/admin/login");
        return;
      }
      const { data: perfil, error } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (error || !perfil || perfil.role !== "admin") {
        router.replace("/admin/login");
        return;
      }
      setListo(true);
    }
    cargarSesion();
  }, [router]);

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      {listo ? (
        <RevisionRps volverHref="/admin" />
      ) : (
        <p className="w-full max-w-2xl text-sm text-muted-foreground">Cargando...</p>
      )}
    </div>
  );
}
