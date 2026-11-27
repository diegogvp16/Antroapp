import { NextResponse } from "next/server";
import { z } from "zod";
import { captchaActivo } from "@/lib/captcha";
import { verificarTurnstile } from "@/lib/captcha-servidor";
import { decidirCaptcha } from "@/lib/domain/captcha";
import { clienteServicio, ipDe } from "@/lib/supabase/servicio";

// Formulario de contacto de /para-clubes CON CAPTCHA. Solo existe con la
// bandera NEXT_PUBLIC_CAPTCHA_TURNSTILE encendida; apagada, el formulario va
// directo a la base y esta ruta responde 404.
//
//   1. Revisa el token de Turnstile (mismas reglas que el login: token falso o
//      faltante se rechaza; si Cloudflare no responde, se deja pasar y quedan
//      los límites de la base).
//   2. Llama a para_clubes_contacto_enviar con la service role, pasándole la
//      IP de quien llama (detrás de Vercel la del gateway de Supabase sería la
//      del servidor). La base valida, aplica la bandera de plataforma, la
//      casilla trampa y los límites por IP y por correo, y guarda.
// No manda correos.

const texto = (max: number) => z.string().max(max * 2).nullable().optional();
const esquema = z.object({
  p_nombre: z.string().max(200),
  p_club: z.string().max(200),
  p_ciudad: z.string().max(200),
  p_correo: z.string().max(300),
  p_telefono: texto(20),
  p_mensaje: texto(1000),
  p_sitio_web: texto(200),
  captchaToken: z.string().max(2048).nullable().optional(),
});

const GENERICO = "No pudimos enviar tus datos. Intenta de nuevo en unos minutos.";

export async function POST(request: Request) {
  if (!captchaActivo()) return NextResponse.json({ error: "No disponible." }, { status: 404 });
  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json({ error: "Datos inválidos." }, { status: 400 });
  }
  const r = esquema.safeParse(cuerpo);
  if (!r.success) return NextResponse.json({ error: "Revisa los datos del formulario." }, { status: 400 });
  const { captchaToken, ...datos } = r.data;

  const ip = ipDe(request);
  const decision = decidirCaptcha(await verificarTurnstile(captchaToken, ip));
  if (!decision.permitir) return NextResponse.json({ error: decision.error, captcha: true }, { status: 400 });

  const { error } = await clienteServicio().rpc("para_clubes_contacto_enviar", {
    ...datos,
    p_telefono: datos.p_telefono ?? null,
    p_mensaje: datos.p_mensaje ?? null,
    p_sitio_web: datos.p_sitio_web ?? null,
    p_ip: ip === "desconocida" ? null : ip,
  });
  if (error) {
    // Los avisos de la base (P0001) se muestran tal cual; lo demás, genérico.
    if (error.code === "P0001") return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("para-clubes: error al guardar el contacto", error.code ?? "");
    return NextResponse.json({ error: GENERICO }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
