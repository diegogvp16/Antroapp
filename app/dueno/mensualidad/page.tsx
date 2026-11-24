"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { mensualidadActiva } from "@/lib/mensualidad/bandera";
import { ETIQUETA_ESTADO, TONO_ESTADO, type EstadoMensualidad } from "@/lib/domain/mensualidad";
import { formatearCentavos } from "@/lib/domain/caja";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Mensualidad del antro (bandera NEXT_PUBLIC_MENSUALIDAD). El dueño ve su
// plan, el estado, el próximo cobro y el historial, y va a Stripe para
// suscribirse o administrar su tarjeta. Nada se cobra desde esta pantalla:
// Stripe cobra y el webhook actualiza el estado.

type Plan = { id: string; nombre: string; descripcion: string | null; monto_centavos: number | null; moneda: string; dias_gracia: number };
type Suscripcion = {
  estado: EstadoMensualidad;
  periodo_fin: string | null;
  gracia_hasta: string | null;
  cancelar_al_final: boolean;
  plan_id: string | null;
};
type Pago = { id: string; monto_centavos: number; moneda: string; estado: string; periodo_inicio: string | null; periodo_fin: string | null; url_factura: string | null; creado_en: string };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "long", year: "numeric" });
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const ESTADO_PAGO: Record<string, { texto: string; tono: "ok" | "err" | "neutral" | "warn" }> = {
  pagado: { texto: "Pagado", tono: "ok" },
  fallido: { texto: "Falló", tono: "err" },
  pendiente: { texto: "Pendiente", tono: "warn" },
  anulado: { texto: "Anulado", tono: "neutral" },
};

export default function MensualidadDuenoPage() {
  const router = useRouter();
  const [club, setClub] = useState<{ id: string; nombre: string } | null>(null);
  const [sus, setSus] = useState<Suscripcion | null>(null);
  const [planes, setPlanes] = useState<Plan[]>([]);
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [yendo, setYendo] = useState<string | null>(null);
  // Regresó de Stripe Checkout (?listo=1): el webhook puede tardar unos segundos.
  const [recienPagado, setRecienPagado] = useState(false);

  const cargar = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return router.replace("/dueno/login");
    const { data: clubs } = await supabase.from("clubs").select("id, nombre").eq("dueno_id", user.id).limit(1);
    const c = clubs?.[0];
    if (!c) {
      setError("No encontramos tu antro.");
      setCargando(false);
      return;
    }
    setClub(c);
    const [s, p, h] = await Promise.all([
      supabase.from("suscripciones").select("estado, periodo_fin, gracia_hasta, cancelar_al_final, plan_id").eq("club_id", c.id).maybeSingle(),
      supabase.from("planes").select("id, nombre, descripcion, monto_centavos, moneda, dias_gracia").eq("activo", true).order("monto_centavos"),
      supabase.from("pagos_mensualidad").select("id, monto_centavos, moneda, estado, periodo_inicio, periodo_fin, url_factura, creado_en").eq("club_id", c.id).order("creado_en", { ascending: false }).limit(24),
    ]);
    if (s.error || p.error || h.error) setError("No pudimos cargar tu mensualidad. Intenta de nuevo.");
    setSus((s.data as Suscripcion | null) ?? null);
    setPlanes((p.data ?? []) as Plan[]);
    setPagos((h.data ?? []) as Pago[]);
    setCargando(false);
  }, [router]);

  useEffect(() => {
    if (!mensualidadActiva()) {
      router.replace("/dueno/panel");
      return;
    }
    setRecienPagado(new URLSearchParams(window.location.search).get("listo") === "1");
    cargar();
  }, [cargar, router]);

  async function irA(ruta: "checkout" | "portal", planId?: string) {
    if (!club) return;
    setYendo(planId ?? ruta);
    setError(null);
    try {
      const r = await fetch(`/api/mensualidad/${ruta}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ club_id: club.id, ...(planId ? { plan_id: planId } : {}) }),
      });
      const c: { url?: string; error?: string } = await r.json().catch(() => ({}));
      if (!r.ok || !c.url) {
        setError(c.error ?? "No pudimos abrir Stripe. Intenta de nuevo.");
        return;
      }
      window.location.assign(c.url);
    } catch {
      setError("Sin conexión. Revisa tu internet e intenta de nuevo.");
    } finally {
      setYendo(null);
    }
  }

  const estado: EstadoMensualidad = sus?.estado ?? "sin_suscripcion";
  const plan = planes.find((p) => p.id === sus?.plan_id) ?? null;
  const puedeSuscribirse = estado === "sin_suscripcion" || estado === "vencida" || estado === "cancelada";

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-8 sm:px-6">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <Link href="/dueno/panel" className="inline-flex min-h-10 w-fit items-center text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Volver al panel
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Mensualidad</h1>
          {club && <p className="text-sm text-muted-foreground">{club.nombre}</p>}
        </header>

        {cargando && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {error && (
          <p role="alert" className="rounded-lg border border-status-err/40 bg-status-err/10 p-3 text-sm text-status-err">
            {error}
          </p>
        )}
        {recienPagado && estado === "sin_suscripcion" && (
          <p role="status" className="rounded-lg border border-border p-3 text-sm">
            Recibimos tu pago en Stripe. La confirmación tarda unos segundos; recarga esta página si no cambia.
          </p>
        )}

        {!cargando && club && (
          <>
            <Card>
              <CardContent className="flex flex-col gap-3 px-5 py-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">Estado</span>
                  <Badge variant={TONO_ESTADO[estado]}>{ETIQUETA_ESTADO[estado]}</Badge>
                </div>
                {plan && (
                  <p className="text-sm">
                    Plan <strong>{plan.nombre}</strong>
                    {plan.monto_centavos != null ? ` · ${formatearCentavos(plan.monto_centavos)} al mes` : ""}
                  </p>
                )}
                {estado === "activa" && sus?.periodo_fin && (
                  <p className="text-sm">
                    {sus.cancelar_al_final ? "Se cancela el " : "Próximo cobro: "}
                    <strong>{fecha.format(new Date(sus.periodo_fin))}</strong>
                  </p>
                )}
                {estado === "en_gracia" && sus?.gracia_hasta && (
                  <p className="text-sm text-status-warn">
                    No pudimos cobrar tu mensualidad. Tu antro sigue publicado hasta el <strong>{fechaHora.format(new Date(sus.gracia_hasta))}</strong>. Actualiza
                    tu tarjeta en «Administrar pago».
                  </p>
                )}
                {(estado === "vencida" || estado === "cancelada") && (
                  <p className="text-sm">
                    Tu antro ya no se muestra a los clientes. <strong>La puerta, la caja y tus reportes siguen funcionando.</strong> Suscríbete para volver a
                    publicarlo.
                  </p>
                )}
                {estado === "sin_suscripcion" && <p className="text-sm text-muted-foreground">Elige un plan para publicar tu antro.</p>}
                {sus && estado !== "sin_suscripcion" && (
                  <Button type="button" variant="outline" className="h-10 self-start" disabled={yendo !== null} onClick={() => irA("portal")}>
                    {yendo === "portal" ? "Abriendo…" : "Administrar pago (Stripe)"}
                  </Button>
                )}
              </CardContent>
            </Card>

            {puedeSuscribirse && (
              <section className="flex flex-col gap-3">
                <h2 className="text-lg font-semibold">Planes</h2>
                {planes.length === 0 && <p className="text-sm text-muted-foreground">Todavía no hay planes disponibles. Escríbenos para activarte.</p>}
                {planes.map((p) => (
                  <Card key={p.id}>
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                      <div className="flex min-w-0 flex-col">
                        <span className="font-medium">{p.nombre}</span>
                        <span className="text-sm text-muted-foreground">
                          {p.monto_centavos != null ? `${formatearCentavos(p.monto_centavos)} al mes` : "Precio en el pago"}
                          {p.descripcion ? ` · ${p.descripcion}` : ""}
                        </span>
                      </div>
                      <Button type="button" className="h-10" disabled={yendo !== null} onClick={() => irA("checkout", p.id)}>
                        {yendo === p.id ? "Abriendo…" : "Suscribirme"}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
                <p className="text-xs text-muted-foreground">El pago se hace en Stripe. AntroApp no guarda los datos de tu tarjeta.</p>
              </section>
            )}

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">Historial</h2>
              {pagos.length === 0 ? (
                <p className="text-sm text-muted-foreground">Sin pagos todavía.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                  {pagos.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                      <span className="flex flex-col">
                        <span className="tabular-nums font-medium">{formatearCentavos(p.monto_centavos)}</span>
                        <span className="text-xs text-muted-foreground">{fecha.format(new Date(p.periodo_inicio ?? p.creado_en))}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <Badge variant={ESTADO_PAGO[p.estado]?.tono ?? "neutral"}>{ESTADO_PAGO[p.estado]?.texto ?? p.estado}</Badge>
                        {p.url_factura && (
                          <a href={p.url_factura} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">
                            Factura
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
