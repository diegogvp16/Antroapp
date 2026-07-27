"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
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

const MIN_PASSWORD_LENGTH = 6;

export default function DuenoSignupPage() {
  const router = useRouter();
  const [nombre, setNombre] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [clubNombre, setClubNombre] = useState("");
  const [clubDireccion, setClubDireccion] = useState("");
  const [clubHorario, setClubHorario] = useState("");
  const [clubDeposito, setClubDeposito] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEmailTaken(false);

    if (
      !nombre.trim() ||
      !email.trim() ||
      !password ||
      !clubNombre.trim() ||
      !clubDireccion.trim() ||
      !clubHorario.trim() ||
      !clubDeposito
    ) {
      setError("Por favor completa todos los campos.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(
        `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      );
      return;
    }
    const depositoNum = Number(clubDeposito);
    if (!Number.isFinite(depositoNum) || depositoNum < 0) {
      setError("El depósito debe ser un número válido.");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      const { data: signUpData, error: signUpError } =
        await supabase.auth.signUp({
          email: email.trim(),
          password,
        });

      if (signUpError || !signUpData.user) {
        if (signUpError?.code === "user_already_exists") {
          setEmailTaken(true);
          return;
        }
        console.error("Supabase signUp error:", signUpError);
        throw signUpError;
      }

      const { error: profileError } = await supabase.from("profiles").insert({
        id: signUpData.user.id,
        nombre: nombre.trim(),
        role: "dueno",
      });

      if (profileError) {
        console.error("Supabase insert error (profiles):", profileError);
        throw profileError;
      }

      const { error: clubError } = await supabase.from("clubs").insert({
        nombre: clubNombre.trim(),
        direccion: clubDireccion.trim(),
        horario: clubHorario.trim(),
        deposito_monto: depositoNum,
        dueno_id: signUpData.user.id,
        suscripcion_activa: false,
      });

      if (clubError) {
        console.error("Supabase insert error (clubs):", clubError);
        throw clubError;
      }

      if (signUpData.session) {
        router.push("/dueno/panel");
      } else {
        setPendingConfirmation(true);
      }
    } catch (err) {
      console.error(err);
      setError(
        "No pudimos crear tu cuenta. Intenta de nuevo en unos segundos.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (pendingConfirmation) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Cuenta creada</CardTitle>
            <CardDescription>
              Revisa tu correo para confirmar tu cuenta antes de iniciar
              sesión.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <Link
              href="/dueno/login"
              className="text-sm font-medium text-foreground underline underline-offset-4"
            >
              Ir a iniciar sesión
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
          <CardTitle>Registra tu antro</CardTitle>
          <CardDescription>
            Crea tu cuenta de dueño y da de alta tu negocio.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nombre">Tu nombre</Label>
              <Input
                id="nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                required
              />
            </div>
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

            <div className="mt-2 border-t border-border pt-4">
              <p className="mb-3 text-sm font-medium">Datos de tu antro</p>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="club_nombre">Nombre del antro</Label>
                  <Input
                    id="club_nombre"
                    value={clubNombre}
                    onChange={(e) => setClubNombre(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="club_direccion">Dirección</Label>
                  <Input
                    id="club_direccion"
                    value={clubDireccion}
                    onChange={(e) => setClubDireccion(e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="club_horario">Horario</Label>
                  <Input
                    id="club_horario"
                    value={clubHorario}
                    onChange={(e) => setClubHorario(e.target.value)}
                    placeholder="ej. 10pm - 4am"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="club_deposito">Depósito ($)</Label>
                  <Input
                    id="club_deposito"
                    type="number"
                    min={0}
                    value={clubDeposito}
                    onChange={(e) => setClubDeposito(e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            {emailTaken && (
              <p className="text-sm text-destructive" role="alert">
                Ese correo ya tiene una cuenta.{" "}
                <Link
                  href="/dueno/login"
                  className="font-medium underline underline-offset-4"
                >
                  Intenta iniciar sesión en su lugar
                </Link>
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              className="mt-2 h-14 w-full text-base"
              disabled={submitting}
            >
              {submitting ? "Registrando..." : "Registrar mi antro"}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              ¿Ya tienes cuenta?{" "}
              <Link
                href="/dueno/login"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Inicia sesión aquí
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
