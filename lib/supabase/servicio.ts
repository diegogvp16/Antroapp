import "server-only";
// Cliente con la service role key. SOLO para rutas de servidor (app/api):
// nunca importarlo desde un componente "use client" (la llave no lleva
// NEXT_PUBLIC_, así que en el navegador quedaría vacía y fallaría).
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export function clienteServicio() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// Hash para guardar correos e IPs sin guardarlos en claro.
export function hashTexto(texto: string): string {
  return createHash("sha256").update(texto).digest("hex");
}

// IP de quien llama, detrás del proxy de Vercel.
export function ipDe(request: Request): string {
  const reenviada = request.headers.get("x-forwarded-for");
  return (reenviada?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "desconocida").trim();
}
