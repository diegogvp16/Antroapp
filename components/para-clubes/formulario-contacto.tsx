"use client";

import { useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { captchaActivo } from "@/lib/captcha";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { erroresContacto, MENSAJE_MAXIMO, type CampoContacto, type DatosContacto } from "@/lib/domain/contacto-club";
import { Turnstile, type TurnstileRef } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Formulario de contacto de /para-clubes. Guarda en la base
// (para_clubes_contacto_enviar); no manda correos. Sin CAPTCHA va directo a
// la base con la anon key (la base pone los límites por IP y por correo);
// con NEXT_PUBLIC_CAPTCHA_TURNSTILE pasa por /api/para-clubes/contacto, que
// revisa el token antes.

const VACIO: DatosContacto = { nombre: "", club: "", ciudad: "", correo: "", telefono: "", mensaje: "" };
const ORDEN: CampoContacto[] = ["nombre", "club", "ciudad", "correo", "telefono", "mensaje"];
const GENERICO = "No pudimos enviar tus datos. Intenta de nuevo en unos minutos.";

export function FormularioContacto({ avisoPrivacidad }: { avisoPrivacidad: React.ReactNode }) {
  const [datos, setDatos] = useState<DatosContacto>(VACIO);
  const [errores, setErrores] = useState<Partial<Record<CampoContacto, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const trampa = useRef<HTMLInputElement>(null);
  const captcha = useRef<TurnstileRef>(null);
  const confirmacion = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);

  const cambiar = (campo: CampoContacto) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setDatos((d) => ({ ...d, [campo]: e.target.value }));
    if (errores[campo]) setErrores((x) => ({ ...x, [campo]: undefined }));
  };

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const encontrados = erroresContacto(datos);
    setErrores(encontrados);
    const primero = ORDEN.find((c) => encontrados[c]);
    if (primero) {
      form.current?.querySelector<HTMLElement>(`[name="${primero}"]`)?.focus();
      return;
    }
    setEnviando(true);
    try {
      const cuerpo = {
        p_nombre: datos.nombre,
        p_club: datos.club,
        p_ciudad: datos.ciudad,
        p_correo: datos.correo,
        p_telefono: datos.telefono || null,
        p_mensaje: datos.mensaje || null,
        p_sitio_web: trampa.current?.value || null,
      };
      let fallo: string | null = null;
      if (captchaActivo()) {
        const r = await fetch("/api/para-clubes/contacto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...cuerpo, captchaToken: token }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          fallo = j?.error ?? GENERICO;
          captcha.current?.reiniciar();
        }
      } else {
        const { error: e2 } = await createClient().rpc("para_clubes_contacto_enviar", cuerpo);
        if (e2) fallo = mensajeParaUsuario(e2, GENERICO);
      }
      if (fallo) {
        setError(fallo);
        return;
      }
      setEnviado(true);
      requestAnimationFrame(() => confirmacion.current?.focus());
    } catch {
      setError(GENERICO);
    } finally {
      setEnviando(false);
    }
  }

  if (enviado) {
    return (
      <div
        ref={confirmacion}
        tabIndex={-1}
        role="status"
        className="flex flex-col gap-2 rounded-md border border-noche-accent/40 bg-card p-5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <p className="font-display text-2xl">Recibimos tus datos.</p>
        <p className="text-sm text-noche-muted">
          Te buscamos por correo{datos.telefono ? " o por teléfono" : ""} para platicar de tu antro. No te inscribimos a ninguna lista.
        </p>
      </div>
    );
  }

  const campo = (c: CampoContacto, etiqueta: string, props: React.ComponentProps<"input"> = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`contacto-${c}`}>{etiqueta}</Label>
      <Input
        id={`contacto-${c}`}
        name={c}
        value={datos[c]}
        onChange={cambiar(c)}
        aria-invalid={errores[c] ? true : undefined}
        aria-describedby={errores[c] ? `contacto-${c}-error` : undefined}
        {...props}
      />
      {errores[c] && (
        <p id={`contacto-${c}-error`} className="text-sm text-destructive">
          {errores[c]}
        </p>
      )}
    </div>
  );

  return (
    <form ref={form} onSubmit={enviar} noValidate className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {campo("nombre", "Tu nombre", { autoComplete: "name", maxLength: 80, required: true })}
        {campo("club", "Nombre del antro", { autoComplete: "organization", maxLength: 80, required: true })}
        {campo("ciudad", "Ciudad", { autoComplete: "address-level2", maxLength: 60, required: true })}
        {campo("correo", "Correo", { type: "email", autoComplete: "email", inputMode: "email", maxLength: 120, required: true })}
        {campo("telefono", "Teléfono (opcional)", { type: "tel", autoComplete: "tel", inputMode: "tel", maxLength: 20 })}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="contacto-mensaje">¿Qué te gustaría saber? (opcional)</Label>
        <textarea
          id="contacto-mensaje"
          name="mensaje"
          rows={4}
          maxLength={MENSAJE_MAXIMO}
          value={datos.mensaje}
          onChange={cambiar("mensaje")}
          aria-invalid={errores.mensaje ? true : undefined}
          aria-describedby={errores.mensaje ? "contacto-mensaje-error" : "contacto-mensaje-ayuda"}
          className={cn(
            "w-full min-w-0 rounded-lg border border-input bg-foreground/5 px-2.5 py-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
          )}
        />
        {errores.mensaje ? (
          <p id="contacto-mensaje-error" className="text-sm text-destructive">
            {errores.mensaje}
          </p>
        ) : (
          <p id="contacto-mensaje-ayuda" className="text-xs text-noche-muted">
            Por ejemplo: cuántas mesas tienes o cuántos RPs trabajan contigo.
          </p>
        )}
      </div>

      {/* Casilla trampa: invisible para las personas (y para los lectores de
          pantalla); un bot que la llena se descarta en la base sin avisarle. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="contacto-sitio-web">Sitio web</label>
        <input ref={trampa} id="contacto-sitio-web" name="sitio_web" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      <Turnstile ref={captcha} onToken={setToken} accion="contacto_club" />

      <div className="text-xs leading-relaxed text-noche-muted">{avisoPrivacidad}</div>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={enviando} className="h-12 w-full text-base font-semibold sm:w-auto sm:self-start sm:px-8">
        {enviando ? "Enviando…" : "Enviar mis datos"}
      </Button>
    </form>
  );
}
