"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { captchaActivo, llaveSitioTurnstile } from "@/lib/captcha";

// Casilla de Cloudflare Turnstile. Con la bandera apagada no renderiza nada
// ni carga ningún script. Si el script no carga (bloqueador, sin red,
// Cloudflare caído), el formulario sigue funcionando: el servidor lo trata
// como "modo degradado" (límites más estrictos), no como error.

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let cargando: Promise<TurnstileApi | null> | null = null;

function cargarScript(): Promise<TurnstileApi | null> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  cargando ??= new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve(window.turnstile ?? null);
    s.onerror = () => {
      cargando = null;
      resolve(null);
    };
    document.head.appendChild(s);
    // Si en 8 s no cargó, se sigue sin CAPTCHA (modo degradado).
    setTimeout(() => resolve(window.turnstile ?? null), 8000);
  });
  return cargando;
}

export type TurnstileRef = { reiniciar: () => void };

export const Turnstile = forwardRef<TurnstileRef, { onToken: (token: string | null) => void; accion?: string }>(function Turnstile(
  { onToken, accion },
  ref,
) {
  const caja = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const alToken = useRef(onToken);
  const [aviso, setAviso] = useState<string | null>(null);
  const activo = captchaActivo();

  useEffect(() => {
    alToken.current = onToken;
  }, [onToken]);

  useImperativeHandle(ref, () => ({
    reiniciar: () => {
      alToken.current(null);
      if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
    },
  }));

  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    cargarScript().then((api) => {
      if (!vivo || !caja.current) return;
      if (!api) {
        setAviso("No se pudo cargar la verificación. Puedes continuar.");
        return;
      }
      widget.current = api.render(caja.current, {
        sitekey: llaveSitioTurnstile(),
        action: accion,
        language: "es",
        theme: "auto",
        callback: (t: string) => {
          setAviso(null);
          alToken.current(t);
        },
        "expired-callback": () => alToken.current(null),
        "error-callback": () => {
          alToken.current(null);
          setAviso("No se pudo verificar. Puedes continuar.");
        },
      });
    });
    return () => {
      vivo = false;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [activo, accion]);

  if (!activo) return null;
  return (
    <div className="flex min-h-[65px] flex-col gap-1">
      <div ref={caja} />
      {aviso && (
        <p role="status" className="text-xs text-muted-foreground">
          {aviso}
        </p>
      )}
    </div>
  );
});
