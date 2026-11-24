import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio, hashTexto, ipDe } from "@/lib/supabase/servicio";
import {
  MAX_FALLOS_POR_CORREO,
  MAX_FALLOS_POR_CORREO_E_IP,
  MAX_FALLOS_POR_IP,
  VENTANA_MINUTOS,
  fallosDesdeUltimoExito,
  mensajeBloqueo,
  minutosDeBloqueo,
  type Intento,
} from "@/lib/domain/login";
import { captchaActivo, modoCaptcha } from "@/lib/captcha";
import { verificarTurnstile } from "@/lib/captcha-servidor";
import { registrarError } from "@/lib/log";
import {
  DEGRADADO_MAX_FALLOS_POR_CORREO_E_IP,
  DEGRADADO_MAX_FALLOS_POR_IP,
  MENSAJE_CAPTCHA_INVALIDO,
  decidirCaptcha,
} from "@/lib/domain/captcha";

// Login con límite de intentos. Los formularios de login (cliente, dueño y
// admin) entran por aquí: la ruta revisa los fallos recientes de ese correo
// desde esa IP (estricto), de ese correo desde cualquier IP (holgado) y de
// esa IP, inicia la sesión con las cookies de servidor (que el cliente
// del navegador ya lee) y registra el resultado. Nunca guarda la contraseña;
// correo e IP se guardan como hash.
//
// Esto limita los formularios de la app. Quien llame a Supabase Auth directo
// con la anon key se salta esta ruta: para eso están los límites por IP y el
// CAPTCHA de Supabase Auth (se activan en su dashboard).
//
// CAPTCHA (lib/captcha.ts, apagado por defecto): con la bandera encendida en
// modo "app" se verifica aquí el token de Turnstile; si no llega o Cloudflare
// no responde, se deja pasar con límites más estrictos (modo degradado). En
// modo "supabase" el token se le pasa a Supabase Auth, que lo verifica.

const ERROR_GENERICO = "Email o contraseña incorrectos.";
const CUENTAS_DE_TRABAJO = ["rp", "staff", "gerente"];

export async function POST(request: Request) {
  let email = "";
  let password = "";
  let captchaToken: unknown = null;
  try {
    const cuerpo: unknown = await request.json();
    if (typeof cuerpo === "object" && cuerpo !== null) {
      const c = cuerpo as Record<string, unknown>;
      email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
      password = typeof c.password === "string" ? c.password : "";
      captchaToken = c.captchaToken;
    }
  } catch {
    // Cuerpo inválido: se trata como datos vacíos.
  }
  if (!email || !password || email.length > 254 || password.length > 200) {
    return NextResponse.json({ error: "Ingresa tu email y contraseña." }, { status: 400 });
  }

  // CAPTCHA (solo con la bandera encendida).
  let degradado = false;
  const conCaptcha = captchaActivo();
  if (conCaptcha && modoCaptcha() === "app") {
    const decision = decidirCaptcha(await verificarTurnstile(captchaToken, ipDe(request)));
    if (!decision.permitir) return NextResponse.json({ error: decision.error, captcha: true }, { status: 400 });
    degradado = decision.degradado;
  }
  const maxIp = degradado ? DEGRADADO_MAX_FALLOS_POR_IP : MAX_FALLOS_POR_IP;
  const maxCorreoIp = degradado ? DEGRADADO_MAX_FALLOS_POR_CORREO_E_IP : MAX_FALLOS_POR_CORREO_E_IP;

  const admin = clienteServicio();
  const emailHash = hashTexto(email);
  const ipHash = hashTexto(ipDe(request));
  const desde = new Date(Date.now() - VENTANA_MINUTOS * 60_000).toISOString();

  const [porCorreo, porIp] = await Promise.all([
    admin.from("login_intentos").select("exito, creado_en, ip_hash").eq("email_hash", emailHash)
      .gte("creado_en", desde).order("creado_en", { ascending: false }).limit(50),
    admin.from("login_intentos").select("exito, creado_en").eq("ip_hash", ipHash)
      .gte("creado_en", desde).order("creado_en", { ascending: false }).limit(100),
  ]);
  if (porCorreo.error || porIp.error) {
    registrarError("login: leer intentos", porCorreo.error ?? porIp.error);
    return NextResponse.json({ error: "No pudimos iniciar sesión. Intenta de nuevo." }, { status: 500 });
  }

  const bloqueo = Math.max(
    minutosDeBloqueo(fallosDesdeUltimoExito((porCorreo.data ?? []) as Intento[]), MAX_FALLOS_POR_CORREO),
    minutosDeBloqueo(((porIp.data ?? []) as Intento[]).filter((i) => !i.exito), maxIp),
  );
  const fallosParCorreoIp = fallosDesdeUltimoExito(
    ((porCorreo.data ?? []) as (Intento & { ip_hash: string })[]).filter((i) => i.ip_hash === ipHash),
  );
  const bloqueoTotal = Math.max(bloqueo, minutosDeBloqueo(fallosParCorreoIp, maxCorreoIp));
  if (bloqueoTotal > 0) {
    return NextResponse.json({ error: mensajeBloqueo(bloqueoTotal), bloqueadoMinutos: bloqueoTotal }, { status: 429 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
    // Modo "supabase": Supabase Auth verifica el token.
    ...(conCaptcha && modoCaptcha() === "supabase" && typeof captchaToken === "string" ? { options: { captchaToken } } : {}),
  });
  if (error?.code === "captcha_failed") {
    return NextResponse.json({ error: MENSAJE_CAPTCHA_INVALIDO, captcha: true }, { status: 400 });
  }
  const exito = !error && !!data.session;

  const registro = await admin.from("login_intentos").insert({ email_hash: emailHash, ip_hash: ipHash, exito });
  if (registro.error) registrarError("login: registrar intento", registro.error);

  if (!exito) {
    return NextResponse.json({ error: ERROR_GENERICO }, { status: 401 });
  }

  // Un RP, staff o gerente dado de baja no entra, aunque su contraseña sea
  // correcta. La pantalla también lo revisa; aquí no depende de ella.
  const { data: perfil } = await admin.from("profiles").select("role, activo").eq("id", data.user.id).maybeSingle();
  if (perfil && CUENTAS_DE_TRABAJO.includes(perfil.role) && perfil.activo !== true) {
    await supabase.auth.signOut();
    return NextResponse.json({ error: "Tu cuenta ha sido desactivada, contacta al antro." }, { status: 403 });
  }
  // Cuenta creada con contraseña temporal (alta de antros): que la cambie.
  const debeCambiar = data.user.app_metadata?.debe_cambiar === true;
  return NextResponse.json({ ok: true, userId: data.user.id, ...(debeCambiar ? { debeCambiar: true } : {}) });
}
