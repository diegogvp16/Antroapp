"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cerrarSesionDadoDeBaja } from "@/lib/cuenta-dada-de-baja";
import { useFunciones } from "@/lib/funciones";
import { cn } from "@/lib/utils";
import { esTipoPlantilla, type TipoPlantilla } from "@/lib/domain/whatsapp";
import { ReservasNoche } from "@/components/clientes/reservas-noche";
import { ListaBloqueados } from "@/components/clientes/lista-bloqueados";
import { ListaNoShow } from "@/components/clientes/lista-noshow";
import { PoliticaNoShow } from "@/components/clientes/politica-noshow";
import { PlantillasWhatsApp } from "@/components/clientes/plantillas-whatsapp";

// "Clientes y mensajes": /staff/clientes (staff y gerente) y /dueno/clientes.
// Detrás de las banderas 'lista_negra' y 'whatsapp' del antro. La pantalla
// solo decide qué mostrar; quién puede qué lo hace cumplir la base
// (sql/post-junta-3/40-lista-negra.sql y 60-whatsapp-plantillas.sql):
//   - staff: la lista de la noche con avisos de no-show (sin motivo) y los
//     enlaces de WhatsApp;
//   - gerente y dueño: además la lista negra, los no-shows, la política y
//     los textos de los mensajes.

type Sesion = { clubId: string; nombreClub: string; horario: string | null; gestiona: boolean };
type Pestana = "noche" | "noshow" | "bloqueados" | "politica" | "mensajes";

export function PantallaClientes({ para }: { para: "staff" | "dueno" }) {
  const router = useRouter();
  const [s, setS] = useState<Sesion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pestana, setPestana] = useState<Pestana>("noche");
  const [propias, setPropias] = useState<Partial<Record<TipoPlantilla, string>>>({});
  const volver = para === "dueno" ? "/dueno/panel" : "/staff/panel";
  const funciones = useFunciones(s?.clubId);
  const ln = funciones.activa("lista_negra");
  const wa = funciones.activa("whatsapp");

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return router.replace(para === "dueno" ? "/dueno/login" : "/cliente/login");
      const { data: perfil } = await supabase.from("profiles").select("role, club_id, activo").eq("id", user.id).maybeSingle();
      if (perfil?.activo === false) return cerrarSesionDadoDeBaja(supabase, router, { colaCaja: para === "staff" });
      let clubId: string | null = null;
      let gestiona = false;
      if (para === "staff") {
        if ((perfil?.role !== "staff" && perfil?.role !== "gerente") || !perfil.club_id) return router.replace("/staff/panel");
        clubId = perfil.club_id;
        gestiona = perfil.role === "gerente";
      } else {
        if (perfil?.role !== "dueno") return router.replace("/cliente/login");
        const { data: clubs } = await supabase.from("clubs").select("id").eq("dueno_id", user.id).limit(1);
        clubId = clubs?.[0]?.id ?? null;
        gestiona = true;
      }
      if (!clubId) {
        setError("No encontramos tu antro.");
        return;
      }
      const { data: club } = await supabase.from("clubs").select("nombre, horario").eq("id", clubId).maybeSingle();
      setS({ clubId, nombreClub: club?.nombre ?? "", horario: club?.horario ?? null, gestiona });
    })();
  }, [para, router]);

  const cargarPlantillas = useCallback(async () => {
    if (!s?.clubId || !wa) return;
    const { data } = await createClient().rpc("whatsapp_plantillas", { p_club: s.clubId });
    const m: Partial<Record<TipoPlantilla, string>> = {};
    for (const f of (data ?? []) as { tipo: string; texto: string }[]) if (esTipoPlantilla(f.tipo)) m[f.tipo] = f.texto;
    setPropias(m);
  }, [s?.clubId, wa]);

  useEffect(() => {
    void cargarPlantillas();
  }, [cargarPlantillas]);

  const pestanas: { id: Pestana; etiqueta: string; visible: boolean }[] = [
    { id: "noche", etiqueta: "Noche", visible: ln || wa },
    { id: "noshow", etiqueta: "No-show", visible: Boolean(s?.gestiona) && ln },
    { id: "bloqueados", etiqueta: "Bloqueados", visible: Boolean(s?.gestiona) && ln },
    { id: "politica", etiqueta: "Política", visible: Boolean(s?.gestiona) && ln },
    { id: "mensajes", etiqueta: "Mensajes", visible: Boolean(s?.gestiona) && wa },
  ];
  const visibles = pestanas.filter((p) => p.visible);
  const actual = visibles.some((p) => p.id === pestana) ? pestana : (visibles[0]?.id ?? "noche");

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-8 sm:px-6">
      <div className="flex w-full max-w-2xl flex-col gap-5">
        <Link href={volver} className="inline-flex min-h-10 w-fit items-center text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Volver al panel
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Clientes y mensajes</h1>
          {s?.nombreClub && <p className="text-sm text-muted-foreground">{s.nombreClub}</p>}
        </header>
        {error && (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        )}
        {!error && (!s || funciones.cargando) && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {s && !funciones.cargando && visibles.length === 0 && (
          <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            Estas funciones todavía no están activas en tu antro. Las enciende AntroApp cuando el antro entra a la prueba.
          </p>
        )}
        {s && !funciones.cargando && visibles.length > 0 && (
          <>
            {visibles.length > 1 && (
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-border p-1 sm:grid-cols-5" role="tablist" aria-label="Secciones">
                {visibles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={actual === p.id}
                    onClick={() => setPestana(p.id)}
                    className={cn(
                      "h-10 rounded-md px-1 text-sm text-muted-foreground",
                      actual === p.id && "bg-muted font-medium text-foreground ring-1 ring-border",
                    )}
                  >
                    {p.etiqueta}
                  </button>
                ))}
              </div>
            )}
            {actual === "noche" && (
              <ReservasNoche clubId={s.clubId} antro={s.nombreClub} horario={s.horario} lnActiva={ln} waActiva={wa} propias={propias} />
            )}
            {actual === "noshow" && <ListaNoShow clubId={s.clubId} />}
            {actual === "bloqueados" && <ListaBloqueados clubId={s.clubId} />}
            {actual === "politica" && <PoliticaNoShow clubId={s.clubId} />}
            {actual === "mensajes" && (
              <PlantillasWhatsApp clubId={s.clubId} antro={s.nombreClub} horario={s.horario} propias={propias} onGuardado={cargarPlantillas} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
