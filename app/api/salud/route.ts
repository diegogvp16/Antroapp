import { NextResponse } from "next/server";
import { clienteServicio } from "@/lib/supabase/servicio";

// Salud de la app, para un monitor externo (UptimeRobot, Better Stack…) o
// para revisar a mano. Público y sin datos: solo si la app responde y si la
// base contesta, cuánto tardó y qué versión está publicada. 200 = bien,
// 503 = la base no contesta (la app sí).

export const dynamic = "force-dynamic";
const TIEMPO_MAXIMO_MS = 3000;

export async function GET() {
  const t0 = Date.now();
  let base: { ok: boolean; ms: number };
  try {
    const consulta = clienteServicio().from("clubs").select("id", { head: true, count: "exact" }).limit(1);
    const limite = new Promise<{ error: { message: string } }>((r) => setTimeout(() => r({ error: { message: "tiempo" } }), TIEMPO_MAXIMO_MS));
    const r = await Promise.race([consulta, limite]);
    base = { ok: !r.error, ms: Date.now() - t0 };
  } catch {
    base = { ok: false, ms: Date.now() - t0 };
  }
  return NextResponse.json(
    {
      estado: base.ok ? "ok" : "sin_base",
      base,
      version: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
      entorno: process.env.VERCEL_ENV ?? "local",
      hora: new Date().toISOString(),
    },
    { status: base.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
