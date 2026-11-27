"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { FuncionesPrueba } from "@/components/admin/funciones-prueba";
import { BanderaParaClubes } from "@/components/admin/bandera-para-clubes";

// Admin: funciones en prueba por antro y por grupo. Todas apagadas por defecto.
export default function FuncionesAdminPage() {
  const router = useRouter();
  const [listo, setListo] = useState(false);

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
    })();
  }, [router]);

  if (!listo) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-8 sm:px-6">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <Link href="/admin" className="inline-flex min-h-10 w-fit items-center text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Panel admin
        </Link>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Funciones en prueba</h1>
          <p className="text-sm text-muted-foreground">
            Todas nacen apagadas. Enciéndelas por antro o por grupo para probarlas antes de darlas a todos.
          </p>
        </div>
        <BanderaParaClubes />
        <FuncionesPrueba />
      </div>
    </div>
  );
}
