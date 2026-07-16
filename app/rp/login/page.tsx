"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const SESSION_KEY = "antroapp_rp_session";

export default function RpLoginPage() {
  const router = useRouter();
  const [nombre, setNombre] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!nombre.trim() || !password) {
      setError("Ingresa tu nombre y contraseña.");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      const { data, error: queryError } = await supabase
        .from("profiles")
        .select("id, nombre")
        .eq("nombre", nombre.trim())
        .eq("password", password)
        .eq("role", "rp")
        .maybeSingle();

      if (queryError || !data) {
        setError("Nombre o contraseña incorrectos.");
        return;
      }

      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ id: data.id, nombre: data.nombre }),
      );
      router.push("/rp/panel");
    } catch (err) {
      console.error(err);
      setError("Ocurrió un error. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Acceso RP</CardTitle>
          <CardDescription>
            Ingresa con tu nombre y contraseña.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nombre">Nombre</Label>
              <Input
                id="nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              className="mt-2 h-14 w-full text-base"
              disabled={submitting}
            >
              {submitting ? "Entrando..." : "Entrar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
