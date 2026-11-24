// Inicio de sesión desde los formularios: pasa por /api/auth/login (límite
// de intentos y, con la bandera encendida, CAPTCHA). La sesión queda en
// cookies y el cliente del navegador (@/lib/supabase/client) la lee igual que
// antes.

export type ResultadoLogin =
  | { ok: true; userId: string; debeCambiar: boolean }
  | { ok: false; error: string };

export async function iniciarSesion(email: string, password: string, captchaToken: string | null = null): Promise<ResultadoLogin> {
  try {
    const respuesta = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(captchaToken ? { email, password, captchaToken } : { email, password }),
    });
    const cuerpo: unknown = await respuesta.json().catch(() => null);
    const datos = (typeof cuerpo === "object" && cuerpo !== null ? cuerpo : {}) as {
      ok?: boolean;
      userId?: string;
      error?: string;
      debeCambiar?: boolean;
    };
    if (respuesta.ok && datos.ok && typeof datos.userId === "string") {
      return { ok: true, userId: datos.userId, debeCambiar: datos.debeCambiar === true };
    }
    return { ok: false, error: datos.error ?? "Email o contraseña incorrectos." };
  } catch {
    return { ok: false, error: "No pudimos conectar. Revisa tu internet e intenta de nuevo." };
  }
}
