// Registro por el servidor (POST /api/auth/registro). Solo se usa con la
// bandera del CAPTCHA encendida; apagada, las páginas de registro siguen con
// su flujo de siempre (directo a Supabase).

export type DatosRegistro =
  | { tipo: "cliente"; nombre: string; telefono: string; email: string; password: string; captchaToken: string | null; aceptaLegales?: boolean }
  | {
      tipo: "dueno";
      nombre: string;
      email: string;
      password: string;
      captchaToken: string | null;
      club: { nombre: string; direccion: string; horario: string };
    };

export type ResultadoRegistro = { ok: true; sesion: boolean } | { ok: false; error: string; emailTaken: boolean };

export async function registrarEnServidor(datos: DatosRegistro): Promise<ResultadoRegistro> {
  try {
    const r = await fetch("/api/auth/registro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(datos),
    });
    const c = (await r.json().catch(() => ({}))) as { ok?: boolean; sesion?: boolean; error?: string; emailTaken?: boolean };
    if (r.ok && c.ok) return { ok: true, sesion: c.sesion === true };
    return { ok: false, error: c.error ?? "No pudimos crear tu cuenta. Intenta de nuevo en unos segundos.", emailTaken: c.emailTaken === true };
  } catch {
    return { ok: false, error: "No pudimos conectar. Revisa tu internet e intenta de nuevo.", emailTaken: false };
  }
}
