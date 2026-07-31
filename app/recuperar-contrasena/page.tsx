"use client";

import { useState, type FormEvent } from "react";
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

export default function RecuperarContrasenaPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setSubmitting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: `${window.location.origin}/actualizar-contrasena` },
      );
      if (error) {
        console.error("Error solicitando reset de contraseña:", error);
      }
    } catch (err) {
      console.error("Error solicitando reset de contraseña:", err);
    } finally {
      // Mensaje genérico siempre, exista o no la cuenta -- por seguridad no
      // revelamos qué emails están registrados.
      setSent(true);
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Revisa tu correo</CardTitle>
            <CardDescription>
              Si el correo existe, te llegará un link para restablecer tu
              contraseña.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <Link
              href="/cliente/login"
              className="text-sm font-medium text-foreground underline underline-offset-4"
            >
              Volver a iniciar sesión
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
          <CardTitle>Recuperar contraseña</CardTitle>
          <CardDescription>
            Ingresa tu email y te enviaremos un link para restablecerla.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <Button
              type="submit"
              size="lg"
              className="mt-2 h-14 w-full text-base"
              disabled={submitting}
            >
              {submitting ? "Enviando..." : "Enviar link de recuperación"}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              <Link
                href="/cliente/login"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Volver a iniciar sesión
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
