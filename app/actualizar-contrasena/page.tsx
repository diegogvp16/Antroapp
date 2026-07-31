"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
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

const MIN_PASSWORD_LENGTH = 6;

export default function ActualizarContrasenaPage() {
  const supabaseRef = useRef(createClient());

  const [checkingRecovery, setCheckingRecovery] = useState(true);
  const [recoveryReady, setRecoveryReady] = useState(false);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // El link del correo trae el token de recovery en el fragmento (#) de
    // la URL. El cliente de @supabase/ssr (a diferencia del cliente base
    // de supabase-js) NO lo detecta ni lo procesa automáticamente -- está
    // pensado para el flujo de cookies/PKCE. Si llamamos a updateUser()
    // sin antes establecer la sesión a mano, falla con "Auth session
    // missing" aunque el link sea válido. Por eso parseamos el hash y
    // llamamos a setSession() explícitamente.
    const supabase = supabaseRef.current;
    let cancelled = false;

    async function resolveRecoverySession() {
      const { data: existing } = await supabase.auth.getSession();
      if (existing.session) {
        if (!cancelled) {
          setRecoveryReady(true);
          setCheckingRecovery(false);
        }
        return;
      }

      const rawHash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const params = new URLSearchParams(rawHash);
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");

      if (accessToken && refreshToken) {
        const { error: setSessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (!cancelled) {
          setRecoveryReady(!setSessionError);
          setCheckingRecovery(false);
        }
        return;
      }

      if (!cancelled) {
        setCheckingRecovery(false);
      }
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryReady(true);
        setCheckingRecovery(false);
      }
    });

    resolveRecoverySession();

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!password || !confirmPassword) {
      setError("Completa ambos campos.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      );
      return;
    }
    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = supabaseRef.current;
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });

      if (updateError) {
        console.error("Error actualizando contraseña:", updateError);
        setError(
          "No pudimos actualizar tu contraseña. El link puede haber expirado — solicita uno nuevo.",
        );
        return;
      }

      setSuccess(true);
    } catch (err) {
      console.error(err);
      setError("Ocurrió un error. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  if (checkingRecovery) {
    return null;
  }

  if (success) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Contraseña actualizada</CardTitle>
            <CardDescription>
              Ya puedes iniciar sesión con tu nueva contraseña.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <Link
              href="/cliente/login"
              className="text-sm font-medium text-foreground underline underline-offset-4"
            >
              Ir a iniciar sesión
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!recoveryReady) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Link inválido o expirado</CardTitle>
            <CardDescription>
              Este link para restablecer tu contraseña ya no es válido.
              Solicita uno nuevo.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <Link
              href="/recuperar-contrasena"
              className="text-sm font-medium text-foreground underline underline-offset-4"
            >
              Solicitar un nuevo link
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Actualizar contraseña</CardTitle>
          <CardDescription>Elige tu nueva contraseña.</CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Nueva contraseña</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirmPassword">Confirma tu contraseña</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
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
              {submitting ? "Guardando..." : "Actualizar contraseña"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
