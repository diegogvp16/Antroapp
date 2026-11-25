"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { BandejaCorreos } from "@/components/admin/bandeja-correos";

// Admin: bandeja de salida de los correos de la app (lib/correo.ts). Solo
// para revisar lo archivado, enviado o fallido; aquí no se manda nada.
export default function CorreosAdminPage() {
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
          <h1 className="text-2xl font-semibold tracking-tight">Correos</h1>
          <p className="text-sm text-muted-foreground">Lo que la app mandó o habría mandado en los últimos 30 días.</p>
        </div>
        <BandejaCorreos />
      </div>
    </div>
  );
}
