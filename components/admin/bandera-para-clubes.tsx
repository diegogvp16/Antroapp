"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { captchaActivo } from "@/lib/captcha";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Admin: banderas de plataforma de /para-clubes (sql/post-junta-3/50-para-clubes.sql),
// las dos APAGADAS al nacer:
//   para_clubes               la página pública y su formulario (apagada: 404
//                             y la base rechaza los envíos);
//   contacto_requiere_captcha la base solo acepta el formulario por la ruta de
//                             la app que revisa el CAPTCHA. Solo tiene sentido
//                             con NEXT_PUBLIC_CAPTCHA_TURNSTILE encendida en
//                             Vercel: sin ella el formulario dejaría de
//                             funcionar, así que aquí no se deja encender.
// Cada cambio queda en para_clubes_bitacora.

interface Bandera {
  clave: "para_clubes" | "contacto_requiere_captcha";
  activa: boolean;
  cambiado_en: string | null;
  cambiado_por_nombre: string | null;
}

const fecha = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Mexico_City" });

function UltimoCambio({ b }: { b: Bandera | undefined }) {
  if (!b?.cambiado_en) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Último cambio: {fecha.format(new Date(b.cambiado_en))}
      {b.cambiado_por_nombre ? ` · ${b.cambiado_por_nombre}` : ""}
    </p>
  );
}

export function BanderaParaClubes() {
  const [banderas, setBanderas] = useState<Bandera[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const turnstile = captchaActivo();

  const cargar = useCallback(async () => {
    const { data, error: e } = await createClient().rpc("plataforma_banderas_estado");
    if (e) {
      setError(e.code === "PGRST202" ? "La base todavía no tiene la página para antros (falta el SQL 50 de post-junta-3)." : mensajeParaUsuario(e));
      return;
    }
    setError(null);
    setBanderas((data ?? []) as Bandera[]);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function cambiar(clave: Bandera["clave"], activa: boolean) {
    setOcupado(true);
    const { error: e } = await createClient().rpc("plataforma_bandera_cambiar", { p_clave: clave, p_activa: activa });
    setOcupado(false);
    if (e) {
      setError(mensajeParaUsuario(e));
      return;
    }
    await cargar();
  }

  const pagina = banderas?.find((b) => b.clave === "para_clubes");
  const captcha = banderas?.find((b) => b.clave === "contacto_requiere_captcha");

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Página para antros (/para-clubes)</h2>
          {pagina && (
            <Badge variant={pagina.activa ? "ok" : "neutral"} aria-live="polite">
              {pagina.activa ? "Encendida" : "Apagada"}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Página pública para dueños de antro, con su formulario de contacto. Apagada responde 404 y no recibe
          contactos. Los contactos llegan a{" "}
          <Link href="/admin/contactos" className="underline underline-offset-4">
            Contactos de antros
          </Link>
          ; no se manda ningún correo.
        </p>
        <UltimoCambio b={pagina} />
        {error && (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        )}
        {pagina && (
          <div className="flex flex-wrap gap-2">
            {pagina.activa ? (
              <Button variant="outline" className="h-10" disabled={ocupado} onClick={() => void cambiar("para_clubes", false)}>
                Apagar la página
              </Button>
            ) : (
              <Button className="h-10" disabled={ocupado} onClick={() => void cambiar("para_clubes", true)}>
                Encender la página
              </Button>
            )}
            {pagina.activa && (
              <Button variant="outline" className="h-10" render={<a href="/para-clubes" target="_blank" rel="noopener" />} nativeButton={false}>
                Abrir /para-clubes
              </Button>
            )}
          </div>
        )}

        {captcha && (
          <div className="mt-2 flex flex-col gap-2 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Exigir CAPTCHA en el formulario</h3>
              <Badge variant={captcha.activa ? "ok" : "neutral"}>{captcha.activa ? "Exigido" : "No exigido"}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Exigido, la base solo acepta el formulario por la ruta de la app que revisa la casilla de Cloudflare: nadie
              puede mandarlo directo con la llave pública.{" "}
              {turnstile
                ? "El CAPTCHA está encendido en esta versión de la app."
                : "El CAPTCHA está apagado en esta versión de la app (NEXT_PUBLIC_CAPTCHA_TURNSTILE): no se puede exigir, porque el formulario dejaría de funcionar."}
            </p>
            {captcha.activa && !turnstile && (
              <p role="alert" className="text-sm text-status-err">
                Exigido pero sin CAPTCHA en la app: el formulario rechaza todos los envíos. Deja de exigirlo.
              </p>
            )}
            <UltimoCambio b={captcha} />
            <div className="flex flex-wrap gap-2">
              {captcha.activa ? (
                <Button variant="outline" className="h-10" disabled={ocupado} onClick={() => void cambiar("contacto_requiere_captcha", false)}>
                  Dejar de exigir
                </Button>
              ) : (
                <Button className="h-10" disabled={ocupado || !turnstile} onClick={() => void cambiar("contacto_requiere_captcha", true)}>
                  Exigir CAPTCHA
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
