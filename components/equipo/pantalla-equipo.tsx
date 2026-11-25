"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cerrarSesionDadoDeBaja } from "@/lib/cuenta-dada-de-baja";
import { EquipoPersonal } from "@/components/equipo/equipo-personal";
import { RegistroActividad } from "@/components/equipo/registro-actividad";

// "Equipo y actividad": para el gerente (/staff/equipo) y el dueño
// (/dueno/equipo). La pantalla solo decide qué mostrar; quién puede qué lo
// hacen cumplir personal_cambiar_estado y actividad_club en la base.

type Sesion = { miId: string; clubId: string; nombreClub: string; esDueno: boolean };

export function PantallaEquipo({ para }: { para: "gerente" | "dueno" }) {
  const router = useRouter();
  const [s, setS] = useState<Sesion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const volver = para === "dueno" ? "/dueno/panel" : "/staff/panel";

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return router.replace(para === "dueno" ? "/dueno/login" : "/cliente/login");
      const { data: perfil } = await supabase.from("profiles").select("role, club_id, activo").eq("id", user.id).maybeSingle();
      if (perfil?.activo === false) return cerrarSesionDadoDeBaja(supabase, router, { colaCaja: para === "gerente" });
      if (para === "gerente") {
        if (perfil?.role !== "gerente" || !perfil.club_id) return router.replace("/staff/panel");
        const { data: club } = await supabase.from("clubs").select("nombre").eq("id", perfil.club_id).maybeSingle();
        setS({ miId: user.id, clubId: perfil.club_id, nombreClub: club?.nombre ?? "", esDueno: false });
      } else {
        if (perfil?.role !== "dueno") return router.replace("/cliente/login");
        const { data: clubs } = await supabase.from("clubs").select("id, nombre").eq("dueno_id", user.id).limit(1);
        if (!clubs?.length) {
          setError("No encontramos tu antro.");
          return;
        }
        setS({ miId: user.id, clubId: clubs[0].id, nombreClub: clubs[0].nombre, esDueno: true });
      }
    })();
  }, [para, router]);

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-8 sm:px-6">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <Link href={volver} className="inline-flex min-h-10 w-fit items-center text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Volver al panel
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Equipo y actividad</h1>
          {s?.nombreClub && <p className="text-sm text-muted-foreground">{s.nombreClub}</p>}
        </header>
        {error && (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        )}
        {s && (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">{s.esDueno ? "Staff y gerentes" : "Staff"}</h2>
              <p className="text-xs text-muted-foreground">
                {s.esDueno
                  ? "Dar de baja quita el acceso al momento, aunque tenga la app abierta. Siempre pide motivo y queda registrado."
                  : "Puedes dar de baja o reactivar al staff. A otros gerentes solo los cambia el dueño."}
              </p>
              <EquipoPersonal clubId={s.clubId} miId={s.miId} puedeGerentes={s.esDueno} />
            </section>
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">Actividad</h2>
              <p className="text-xs text-muted-foreground">Quién cuadró, anuló, reabrió o cerró, con hora y motivo. Nada de esto se puede borrar.</p>
              <RegistroActividad clubId={s.clubId} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
