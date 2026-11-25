"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SELECT_CLASES } from "@/components/admin/alta/campo";
import { ConfigGrupo } from "@/components/grupo/config-grupo";
import { TemaReportesContenedor } from "@/components/tema-reportes";

// Configuración del grupo: solo el dueño del grupo y el admin
// (grupo_config_mis_grupos devuelve los grupos que cada quien puede
// configurar; la base vuelve a autorizar cada cambio).

type GrupoMio = { id: string; nombre: string; antros: number };
type Estado = { tipo: "cargando" } | { tipo: "error"; texto: string } | { tipo: "listo"; grupos: GrupoMio[] };

export default function ConfiguracionGrupoPage() {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });
  const [elegido, setElegido] = useState<string>("");

  const cargar = useCallback(async () => {
    setEstado({ tipo: "cargando" });
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      router.replace("/cliente/login");
      return;
    }
    const { data, error } = await supabase.rpc("grupo_config_mis_grupos");
    if (error) {
      setEstado({ tipo: "error", texto: mensajeParaUsuario(error, "No pudimos cargar tus grupos. Intenta de nuevo.") });
      return;
    }
    const grupos = (Array.isArray(data) ? data : []) as GrupoMio[];
    const pedido = new URLSearchParams(window.location.search).get("grupo");
    setElegido(grupos.find((g) => g.id === pedido)?.id ?? grupos[0]?.id ?? "");
    setEstado({ tipo: "listo", grupos });
  }, [router]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  return (
    <TemaReportesContenedor className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <Link href="/grupo" className="inline-flex min-h-10 w-fit items-center text-sm font-medium text-muted-foreground hover:text-foreground">
          ← Volver al panel de grupo
        </Link>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words">Configuración del grupo</h1>
          <p className="mt-1 text-sm text-muted-foreground">Valores por defecto para todos los antros del grupo.</p>
        </div>

        {estado.tipo === "cargando" && <p className="text-sm text-muted-foreground">Cargando…</p>}

        {estado.tipo === "error" && (
          <Card size="sm">
            <CardContent className="flex flex-col gap-2 px-4">
              <p role="alert" className="text-sm break-words text-status-err">
                {estado.texto}
              </p>
              <Button type="button" variant="outline" className="h-10 w-fit" onClick={cargar}>
                Reintentar
              </Button>
            </CardContent>
          </Card>
        )}

        {estado.tipo === "listo" && estado.grupos.length === 0 && (
          <Card size="sm">
            <CardContent className="flex flex-col gap-2 px-4">
              <p className="text-sm">Esta pantalla es para el dueño de un grupo de antros. Tu cuenta no administra ningún grupo.</p>
              <Link href="/grupo" className="inline-flex min-h-10 w-fit items-center text-sm font-medium underline underline-offset-4">
                Ir al panel de grupo
              </Link>
            </CardContent>
          </Card>
        )}

        {estado.tipo === "listo" && estado.grupos.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="grupo-elegido" className="text-sm font-medium">
              Grupo
            </label>
            <select id="grupo-elegido" className={SELECT_CLASES} value={elegido} onChange={(e) => setElegido(e.target.value)}>
              {estado.grupos.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nombre} ({g.antros} {g.antros === 1 ? "antro" : "antros"})
                </option>
              ))}
            </select>
          </div>
        )}

        {estado.tipo === "listo" && elegido && (
          <>
            {estado.grupos.length === 1 && <p className="text-sm font-medium break-words">{estado.grupos[0].nombre}</p>}
            <ConfigGrupo key={elegido} grupoId={elegido} />
          </>
        )}
      </div>
    </TemaReportesContenedor>
  );
}
