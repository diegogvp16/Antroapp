"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ETIQUETA_ROL_INVITADO,
  MIN_CONTRASENA,
  esTokenValido,
  type EstadoInvitacion,
  type RolInvitable,
} from "@/lib/domain/invitaciones";

// Aceptar una invitación del equipo: muestra a qué antro y con qué rol, y
// pide elegir contraseña. La cuenta, el rol y el antro los pone el servidor
// con lo que dice la invitación (POST /api/invitacion), nunca este formulario.

type Invitacion = { estado: EstadoInvitacion; correo: string; nombre: string; rol: RolInvitable; club: string; expira_en: string };
type Vista =
  | { tipo: "cargando" }
  | { tipo: "error"; mensaje: string }
  | { tipo: "formulario"; inv: Invitacion }
  | { tipo: "listo"; correo: string };

const NO_SIRVE: Record<Exclude<EstadoInvitacion, "pendiente">, { titulo: string; texto: string }> = {
  aceptada: { titulo: "Esta invitación ya se usó", texto: "Ya tienes cuenta: inicia sesión con tu correo y tu contraseña." },
  vencida: { titulo: "Esta invitación venció", texto: "Las invitaciones duran 72 horas. Pide a quien te invitó que te la reenvíe." },
  revocada: { titulo: "Esta invitación se canceló", texto: "Pide una nueva a quien te invitó." },
};

const vence = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });

async function llamar(cuerpo: object): Promise<{ status: number; datos: Record<string, unknown> }> {
  const r = await fetch("/api/invitacion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
  return { status: r.status, datos: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

export default function InvitacionPage() {
  const { token } = useParams<{ token: string }>();
  const [vista, setVista] = useState<Vista>({ tipo: "cargando" });
  const [password, setPassword] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function consultar() {
    setVista({ tipo: "cargando" });
    if (!esTokenValido(token)) return setVista({ tipo: "error", mensaje: "El enlace no es válido. Revisa que lo copiaste completo." });
    try {
      const { status, datos } = await llamar({ accion: "consultar", token });
      if (status === 200 && datos.invitacion) return setVista({ tipo: "formulario", inv: datos.invitacion as Invitacion });
      setVista({ tipo: "error", mensaje: typeof datos.error === "string" ? datos.error : "No pudimos revisar la invitación." });
    } catch {
      setVista({ tipo: "error", mensaje: "Sin conexión. Revisa tu internet e intenta de nuevo." });
    }
  }

  useEffect(() => {
    consultar();
    // Solo al abrir la página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function aceptar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_CONTRASENA) return setError(`La contraseña debe tener al menos ${MIN_CONTRASENA} caracteres.`);
    if (password !== confirmar) return setError("Las contraseñas no coinciden.");
    setGuardando(true);
    try {
      const { status, datos } = await llamar({ accion: "aceptar", token, password });
      if (status === 200 && datos.ok) return setVista({ tipo: "listo", correo: String(datos.correo ?? "") });
      setError(typeof datos.error === "string" ? datos.error : "No pudimos crear tu cuenta. Intenta de nuevo.");
    } catch {
      setError("Sin conexión. Revisa tu internet e intenta de nuevo.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 sm:px-6">
      <Card className="w-full max-w-sm">
        {vista.tipo === "cargando" && (
          <CardContent className="px-6 py-8">
            <p role="status" className="text-sm text-muted-foreground">
              Revisando tu invitación…
            </p>
          </CardContent>
        )}

        {vista.tipo === "error" && (
          <>
            <CardHeader>
              <CardTitle>No pudimos abrir la invitación</CardTitle>
              <CardDescription role="alert">{vista.mensaje}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 px-6 pb-6">
              <Button type="button" variant="outline" className="h-10" onClick={consultar}>
                Reintentar
              </Button>
              <Button render={<Link href="/cliente/login" />} nativeButton={false} variant="ghost" className="h-10">
                Ir a iniciar sesión
              </Button>
            </CardContent>
          </>
        )}

        {vista.tipo === "formulario" && vista.inv.estado !== "pendiente" && (
          <>
            <CardHeader>
              <CardTitle>{NO_SIRVE[vista.inv.estado].titulo}</CardTitle>
              <CardDescription>
                {vista.inv.club} · {ETIQUETA_ROL_INVITADO[vista.inv.rol]}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-6 pb-6">
              <p className="text-sm">{NO_SIRVE[vista.inv.estado].texto}</p>
              <Button render={<Link href="/cliente/login" />} nativeButton={false} variant="outline" className="h-10">
                Ir a iniciar sesión
              </Button>
            </CardContent>
          </>
        )}

        {vista.tipo === "formulario" && vista.inv.estado === "pendiente" && (
          <>
            <CardHeader>
              <CardTitle>Únete a {vista.inv.club}</CardTitle>
              <CardDescription>
                Te invitaron como <strong className="font-semibold text-foreground">{ETIQUETA_ROL_INVITADO[vista.inv.rol]}</strong>. Elige tu contraseña para crear
                tu cuenta.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <form onSubmit={aceptar} className="flex flex-col gap-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Nombre</dt>
                  <dd className="min-w-0 break-words">{vista.inv.nombre}</dd>
                  <dt className="text-muted-foreground">Correo</dt>
                  <dd className="min-w-0 break-all">{vista.inv.correo}</dd>
                </dl>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">Contraseña</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    className="h-10"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <p className="text-xs text-muted-foreground">Mínimo {MIN_CONTRASENA} caracteres.</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirmar">Repítela</Label>
                  <Input
                    id="confirmar"
                    type="password"
                    autoComplete="new-password"
                    className="h-10"
                    value={confirmar}
                    onChange={(e) => setConfirmar(e.target.value)}
                    required
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm text-status-err">
                    {error}
                  </p>
                )}
                <Button type="submit" className="h-10" disabled={guardando}>
                  {guardando ? "Creando tu cuenta…" : "Crear mi cuenta"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  El enlace sirve una sola vez y vence el {vence.format(new Date(vista.inv.expira_en))} (hora del centro de México). Si no esperabas esta invitación, cierra esta página.
                </p>
              </form>
            </CardContent>
          </>
        )}

        {vista.tipo === "listo" && (
          <>
            <CardHeader>
              <CardTitle>Tu cuenta está lista</CardTitle>
              <CardDescription role="status">
                Inicia sesión con <span className="break-all font-medium text-foreground">{vista.correo}</span> y la contraseña que elegiste.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <Button render={<Link href="/cliente/login" />} nativeButton={false} className="h-10 w-full">
                Iniciar sesión
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
