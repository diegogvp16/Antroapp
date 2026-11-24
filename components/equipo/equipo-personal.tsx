"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

// Staff y gerentes del antro, con «Dar de baja» y «Reactivar» (con
// confirmación y motivo). Quién puede a quién lo decide la base
// (personal_cambiar_estado): el dueño y el admin a staff y gerentes, el
// gerente solo a staff. Al darlo de baja pierde el acceso al momento,
// aunque tenga la sesión abierta.

type Persona = { id: string; nombre: string; role: "staff" | "gerente"; activo: boolean };

const ETIQUETA = { staff: "Staff", gerente: "Gerente" } as const;

export function EquipoPersonal({
  clubId,
  miId,
  puedeGerentes,
  recargar = 0,
}: {
  clubId: string;
  miId: string | null;
  // true para dueño y admin; el gerente solo cambia a staff.
  puedeGerentes: boolean;
  // Cambia cuando se crea una cuenta nueva desde otra sección.
  recargar?: number;
}) {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const { data, error: e } = await createClient()
      .from("profiles")
      .select("id, nombre, role, activo")
      .eq("club_id", clubId)
      .in("role", ["staff", "gerente"])
      .order("activo", { ascending: false })
      .order("nombre");
    if (e) {
      setError(mensajeParaUsuario(e, "No pudimos cargar tu equipo."));
      return;
    }
    setError(null);
    setPersonas((data ?? []) as Persona[]);
  }, [clubId]);

  useEffect(() => {
    cargar();
  }, [cargar, recargar]);

  function abrir(id: string) {
    setAbierto(id);
    setMotivo("");
    setErrorAccion(null);
    setAviso(null);
  }

  async function confirmar(p: Persona) {
    if (motivo.trim().length < 3) {
      setErrorAccion("Escribe el motivo (mínimo 3 letras).");
      return;
    }
    setGuardando(true);
    setErrorAccion(null);
    const { error: e } = await createClient().rpc("personal_cambiar_estado", {
      p_profile_id: p.id,
      p_activo: !p.activo,
      p_motivo: motivo.trim(),
    });
    setGuardando(false);
    if (e) {
      setErrorAccion(mensajeParaUsuario(e, "No se pudo guardar. Intenta de nuevo."));
      return;
    }
    setAbierto(null);
    setAviso(p.activo ? `${p.nombre} quedó dado de baja. Ya no puede entrar.` : `${p.nombre} quedó reactivado.`);
    await cargar();
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-status-err">
        {error}
      </p>
    );
  }
  if (personas === null) return <p className="text-sm text-muted-foreground">Cargando equipo…</p>;
  if (personas.length === 0) return <p className="text-sm text-muted-foreground">Todavía no hay staff ni gerentes.</p>;

  return (
    <div className="flex flex-col gap-2">
      {aviso && (
        <p role="status" className="text-sm text-status-ok">
          {aviso}
        </p>
      )}
      {personas.map((p) => {
        const puede = p.id !== miId && (puedeGerentes || p.role === "staff");
        const idMotivo = `motivo-${p.id}`;
        return (
          <Card key={p.id}>
            <CardContent className="flex flex-col gap-3 px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{p.nombre}</span>
                  <span className="text-xs text-muted-foreground">{ETIQUETA[p.role]}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={p.activo ? "ok" : "neutral"}>{p.activo ? "Activo" : "Dado de baja"}</Badge>
                  {puede && abierto !== p.id && (
                    <Button type="button" variant={p.activo ? "destructive" : "outline"} className="h-10" onClick={() => abrir(p.id)}>
                      {p.activo ? "Dar de baja" : "Reactivar"}
                    </Button>
                  )}
                </div>
              </div>

              {abierto === p.id && (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                  <p className="text-sm">
                    {p.activo
                      ? `¿Dar de baja a ${p.nombre}? Pierde el acceso al momento, aunque tenga la app abierta. Lo que registró se conserva.`
                      : `¿Reactivar a ${p.nombre}? Podrá volver a entrar con su contraseña.`}
                  </p>
                  <Label htmlFor={idMotivo}>Motivo</Label>
                  <textarea
                    id={idMotivo}
                    className="min-h-16 w-full rounded-lg border border-input bg-background px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
                    maxLength={300}
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    autoFocus
                  />
                  {errorAccion && (
                    <p role="alert" className="text-xs font-medium text-status-err">
                      {errorAccion}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant={p.activo ? "destructive" : "default"} className="h-10" disabled={guardando} onClick={() => confirmar(p)}>
                      {guardando ? "Guardando…" : p.activo ? "Sí, dar de baja" : "Sí, reactivar"}
                    </Button>
                    <Button type="button" variant="ghost" className="h-10" disabled={guardando} onClick={() => setAbierto(null)}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
