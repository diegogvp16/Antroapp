"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// Primer inicio con contraseña temporal: hay que elegir una propia antes de
// seguir. El login manda aquí a quien tiene app_metadata.debe_cambiar.

const PANEL: Record<string, string> = {
  cliente: "/cliente",
  rp: "/rp/panel",
  staff: "/staff/panel",
  gerente: "/staff/panel",
  dueno: "/dueno/panel",
  admin: "/admin",
};

export default function CambiarContrasenaPage() {
  const router = useRouter();
  const [listo, setListo] = useState(false);
  const [nueva, setNueva] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!data.user) router.replace("/cliente/login");
        else setListo(true);
      });
  }, [router]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (nueva.length < 8) return setError("La contraseña debe tener al menos 8 caracteres.");
    if (nueva !== confirmar) return setError("Las contraseñas no coinciden.");
    setGuardando(true);
    try {
      const r = await fetch("/api/auth/cambiar-contrasena", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nueva }),
      });
      const c: { ok?: boolean; error?: string } = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) {
        setError(c.error ?? "No pudimos cambiar tu contraseña. Intenta de nuevo.");
        return;
      }
      // Refresca la sesión para que el token ya no traiga la marca.
      const supabase = createClient();
      await supabase.auth.refreshSession();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data: perfil } = user ? await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle() : { data: null };
      router.replace(PANEL[perfil?.role ?? ""] ?? "/cliente");
    } catch {
      setError("Sin conexión. Revisa tu internet e intenta de nuevo.");
    } finally {
      setGuardando(false);
    }
  }

  if (!listo) return null;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Elige tu contraseña</CardTitle>
          <CardDescription>Entraste con una contraseña temporal. Elige una propia para seguir; la temporal deja de servir.</CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form onSubmit={guardar} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nueva">Contraseña nueva</Label>
              <Input id="nueva" type="password" autoComplete="new-password" className="h-10" value={nueva} onChange={(e) => setNueva(e.target.value)} required />
              <p className="text-xs text-muted-foreground">Mínimo 8 caracteres.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmar">Repítela</Label>
              <Input id="confirmar" type="password" autoComplete="new-password" className="h-10" value={confirmar} onChange={(e) => setConfirmar(e.target.value)} required />
            </div>
            {error && (
              <p role="alert" className="text-sm text-status-err">
                {error}
              </p>
            )}
            <Button type="submit" className="h-10" disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar y entrar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
