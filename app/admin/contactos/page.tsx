"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ContactosClubes } from "@/components/admin/contactos-clubes";

// Admin: contactos que dejan los antros en /para-clubes. La base solo se los
// da al admin (contactos_clubes_admin); esta revisión de rol solo evita
// mostrarle la pantalla vacía a otro.
export default function ContactosAdminPage() {
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
          <h1 className="text-2xl font-semibold tracking-tight">Contactos de antros</h1>
          <p className="text-sm text-muted-foreground">
            Lo que dejan los dueños en /para-clubes. No se manda ningún correo: escríbeles tú. Si alguien pide que se
            borren sus datos, usa «Borrar datos». La página se enciende y apaga en{" "}
            <Link href="/admin/funciones" className="underline underline-offset-4">
              Funciones en prueba
            </Link>
            .
          </p>
        </div>
        <ContactosClubes />
      </div>
    </div>
  );
}
