import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { clienteServicio } from "@/lib/supabase/servicio";
import { mensualidadActiva } from "@/lib/mensualidad/bandera";
import { aplicarVencimientos } from "@/lib/mensualidad/webhook";
import { enviarAlerta } from "@/lib/alertas";

// Tarea diaria de la mensualidad (Vercel Cron, vercel.json: 16:00 UTC =
// 10:00 en CDMX y 09:00 en Tijuana, siempre después del corte de las 08:00).
// Vercel manda "Authorization: Bearer <CRON_SECRET>". Con la bandera apagada
// no hace nada.

function autorizado(request: Request): boolean {
  const secreto = process.env.CRON_SECRET;
  const recibido = request.headers.get("authorization") ?? "";
  if (!secreto) return false;
  const esperado = Buffer.from(`Bearer ${secreto}`);
  const dado = Buffer.from(recibido);
  return esperado.length === dado.length && timingSafeEqual(esperado, dado);
}

export async function GET(request: Request) {
  if (!autorizado(request)) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  if (!mensualidadActiva()) return NextResponse.json({ omitido: "mensualidad apagada" });
  try {
    const svc = clienteServicio();
    const r = await aplicarVencimientos(svc);
    if (r.despublicados > 0) {
      await enviarAlerta(svc, "mensualidad_despublicados", `${r.despublicados} antros dejaron de mostrarse`,
        `La tarea diaria quitó la publicación a ${r.despublicados} antros con la mensualidad vencida o cancelada. Revisa /admin/mensualidad.`);
    }
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("cron-mensualidad:", e instanceof Error ? e.message : "error");
    return NextResponse.json({ error: "Falló la tarea." }, { status: 500 });
  }
}
