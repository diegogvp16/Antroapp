import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clienteServicio, hashTexto, ipDe } from "@/lib/supabase/servicio";
import { registrarError } from "@/lib/log";
import { revisarPicoErrores } from "@/lib/alertas";
import { rutaSinParametros, sinDatosPersonales } from "@/lib/domain/sanitizar";

// Aviso de errores de la app: las pantallas de error (app/error.tsx y
// app/global-error.tsx) mandan aquí lo que falló. Se guarda recortado en
// app_errores (solo el admin lo lee). Límite: 20 avisos por IP cada 10
// minutos, para que nadie llene la tabla.

const MAX_POR_IP = 20;
const VENTANA_MS = 10 * 60_000;
const texto = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

export async function POST(request: Request) {
  let cuerpo: Record<string, unknown> = {};
  try {
    const crudo = await request.text();
    if (crudo.length > 4000) return NextResponse.json({ ok: false }, { status: 413 });
    const json: unknown = JSON.parse(crudo);
    if (typeof json === "object" && json !== null) cuerpo = json as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  // Sin correos, teléfonos ni tokens: se guardan para depurar, no para identificar.
  const crudoMensaje = texto(cuerpo.mensaje, 1000);
  const mensaje = crudoMensaje ? sinDatosPersonales(crudoMensaje) : null;
  if (!mensaje) return NextResponse.json({ ok: false }, { status: 400 });

  const admin = clienteServicio();
  const ipHash = hashTexto(ipDe(request));
  const { count } = await admin
    .from("app_errores")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("creado_en", new Date(Date.now() - VENTANA_MS).toISOString());
  if ((count ?? 0) >= MAX_POR_IP) return NextResponse.json({ ok: false }, { status: 429 });

  // Quién estaba (si hay sesión), para poder ayudarle.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { error } = await admin.from("app_errores").insert({
    mensaje,
    ruta: (() => {
      const r = texto(cuerpo.ruta, 300);
      return r ? sinDatosPersonales(rutaSinParametros(r)) : null;
    })(),
    digest: texto(cuerpo.digest, 100),
    navegador: (request.headers.get("user-agent") ?? "").slice(0, 300),
    usuario_id: user?.id ?? null,
    ip_hash: ipHash,
  });
  if (error) {
    registrarError("errores: guardar", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  // Con la bandera de alertas: correo al admin si hay un pico (una vez por hora).
  await revisarPicoErrores(admin);
  return NextResponse.json({ ok: true });
}
