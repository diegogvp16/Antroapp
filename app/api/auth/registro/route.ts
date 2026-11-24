import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio, hashTexto, ipDe } from "@/lib/supabase/servicio";
import { captchaActivo, modoCaptcha } from "@/lib/captcha";
import { verificarTurnstile } from "@/lib/captcha-servidor";
import {
  DEGRADADO_REGISTROS_POR_IP_HORA,
  MENSAJE_CAPTCHA_INVALIDO,
  REGISTROS_POR_IP_HORA,
  decidirCaptcha,
} from "@/lib/domain/captcha";

// Registro de cliente o de dueño PASANDO POR EL SERVIDOR. Solo se usa con la
// bandera del CAPTCHA encendida (lib/captcha.ts); apagada, /cliente/signup y
// /dueno/signup siguen exactamente como antes (directo a Supabase).
//
//   1. CAPTCHA: modo "app" se verifica aquí (si no llega o Cloudflare no
//      responde, modo degradado); modo "supabase" lo verifica Supabase Auth.
//   2. Límite por IP: 5 registros por hora (2 en modo degradado).
//   3. Crea la cuenta con signUp (las cookies de sesión quedan puestas) y el
//      perfil (y el antro del dueño) con ESA sesión, así que RLS y los
//      candados de clubs aplican igual que desde el navegador.
//   4. Si el perfil o el antro fallan, borra la cuenta: no quedan dueños sin
//      antro (deuda 5 de CLAUDE.md, solo con la bandera encendida).

const texto = (min: number, max: number, msg: string) => z.string().trim().min(min, msg).max(max, msg);
const base = {
  nombre: texto(2, 120, "Escribe tu nombre."),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email("Revisa tu correo.")),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres.").max(200),
  captchaToken: z.string().max(2048).nullable().optional(),
};
const esquema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("cliente"), telefono: z.string().trim().max(20).optional().default(""), ...base }),
  z.object({
    tipo: z.literal("dueno"),
    club: z.object({
      nombre: texto(2, 120, "Escribe el nombre del antro."),
      direccion: texto(3, 300, "Escribe la dirección del antro."),
      horario: texto(3, 120, "Escribe el horario."),
    }),
    ...base,
  }),
]);

const GENERICO = "No pudimos crear tu cuenta. Intenta de nuevo en unos segundos.";

export async function POST(request: Request) {
  if (!captchaActivo()) {
    // Con la bandera apagada esta ruta no existe para la app.
    return NextResponse.json({ error: "No disponible." }, { status: 404 });
  }
  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    return NextResponse.json({ error: "Datos inválidos." }, { status: 400 });
  }
  const r = esquema.safeParse(cuerpo);
  if (!r.success) return NextResponse.json({ error: r.error.issues[0]?.message ?? "Revisa los datos." }, { status: 400 });
  const d = r.data;

  // 1. CAPTCHA.
  const ip = ipDe(request);
  let degradado = false;
  if (modoCaptcha() === "app") {
    const decision = decidirCaptcha(await verificarTurnstile(d.captchaToken, ip));
    if (!decision.permitir) return NextResponse.json({ error: decision.error, captcha: true }, { status: 400 });
    degradado = decision.degradado;
  }

  // 2. Límite por IP.
  const admin = clienteServicio();
  const ipHash = hashTexto(ip);
  const { count, error: errCuenta } = await admin
    .from("registro_intentos")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("creado_en", new Date(Date.now() - 3_600_000).toISOString());
  if (errCuenta) {
    console.error("registro: contar intentos", errCuenta.code);
    return NextResponse.json({ error: GENERICO }, { status: 500 });
  }
  if ((count ?? 0) >= (degradado ? DEGRADADO_REGISTROS_POR_IP_HORA : REGISTROS_POR_IP_HORA)) {
    return NextResponse.json({ error: "Demasiados registros desde esta conexión. Intenta de nuevo en una hora." }, { status: 429 });
  }
  await admin.from("registro_intentos").insert({ ip_hash: ipHash, tipo: d.tipo, degradado });

  // 3. Cuenta, perfil y antro.
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: d.email,
    password: d.password,
    ...(modoCaptcha() === "supabase" && d.captchaToken ? { options: { captchaToken: d.captchaToken } } : {}),
  });
  if (error || !data.user) {
    if (error?.code === "user_already_exists") return NextResponse.json({ error: "Ya existe una cuenta con ese correo.", emailTaken: true }, { status: 409 });
    if (error?.code === "captcha_failed") return NextResponse.json({ error: MENSAJE_CAPTCHA_INVALIDO, captcha: true }, { status: 400 });
    if (error?.code === "over_email_send_rate_limit") {
      return NextResponse.json({ error: "Por ahora no podemos enviar más correos de confirmación. Intenta de nuevo en un rato." }, { status: 429 });
    }
    if (error?.code === "weak_password") return NextResponse.json({ error: "Esa contraseña es muy común o muy corta. Elige otra." }, { status: 400 });
    console.error("registro: signUp", error?.code ?? error?.status);
    return NextResponse.json({ error: GENERICO }, { status: 500 });
  }
  const usuario = data.user;
  // Con sesión (confirmación de correo apagada) se escribe como el usuario;
  // sin sesión, con service_role y valores fijos (lo que haría el candado).
  const escritor = data.session ? supabase : admin;

  const perfil = await escritor.from("profiles").insert({
    id: usuario.id,
    nombre: d.nombre,
    role: d.tipo,
    ...(d.tipo === "cliente" ? { telefono: d.telefono || null } : {}),
  });
  let fallo = perfil.error;
  if (!fallo && d.tipo === "dueno") {
    const club = await escritor.from("clubs").insert({
      nombre: d.club.nombre,
      direccion: d.club.direccion,
      horario: d.club.horario,
      dueno_id: usuario.id,
      suscripcion_activa: false,
      estado_verificacion: "borrador",
      verificado_en: null,
      motivo_rechazo: null,
    });
    fallo = club.error;
  }
  if (fallo) {
    // 4. Nada a medias.
    console.error("registro: perfil o antro", fallo.code);
    if (data.session) await supabase.auth.signOut();
    const borrar = await admin.auth.admin.deleteUser(usuario.id);
    if (borrar.error) console.error("registro: no se pudo deshacer la cuenta", borrar.error.code);
    return NextResponse.json({ error: GENERICO }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sesion: !!data.session });
}
