"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { mensualidadActiva } from "@/lib/mensualidad/bandera";
import { ETIQUETA_ESTADO, TONO_ESTADO, type EstadoMensualidad } from "@/lib/domain/mensualidad";
import { formatearCentavos } from "@/lib/domain/caja";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Admin: estado de la mensualidad de todos los antros y planes
// (bandera NEXT_PUBLIC_MENSUALIDAD). Los planes guardan el id del precio de
// Stripe; el precio se define EN STRIPE (no se inventa aquí).

type Fila = { id: string; nombre: string; suscripcion_activa: boolean; sus: { estado: EstadoMensualidad; periodo_fin: string | null; gracia_hasta: string | null; plan: string | null } | null };
type Plan = { id: string; clave: string; nombre: string; stripe_price_id: string; monto_centavos: number | null; dias_gracia: number; activo: boolean };

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short" });
const ORDEN: Record<EstadoMensualidad, number> = { en_gracia: 0, vencida: 1, activa: 2, cancelada: 3, sin_suscripcion: 4 };

export default function MensualidadAdminPage() {
  const router = useRouter();
  const [listo, setListo] = useState(false);
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [planes, setPlanes] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nuevo, setNuevo] = useState({ clave: "", nombre: "", stripe_price_id: "", dias_gracia: "7" });
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    const supabase = createClient();
    const [c, s, p] = await Promise.all([
      supabase.from("clubs").select("id, nombre, suscripcion_activa").order("nombre"),
      supabase.from("suscripciones").select("club_id, estado, periodo_fin, gracia_hasta, planes(nombre)"),
      supabase.from("planes").select("id, clave, nombre, stripe_price_id, monto_centavos, dias_gracia, activo").order("creado_en"),
    ]);
    if (c.error || s.error || p.error) {
      setError("No pudimos cargar las mensualidades.");
      return;
    }
    const porClub = new Map((s.data ?? []).map((x) => [x.club_id, x]));
    setFilas(
      (c.data ?? [])
        .map((club) => {
          const x = porClub.get(club.id);
          const plan = x?.planes as unknown as { nombre: string } | null;
          return { ...club, sus: x ? { estado: x.estado as EstadoMensualidad, periodo_fin: x.periodo_fin, gracia_hasta: x.gracia_hasta, plan: plan?.nombre ?? null } : null };
        })
        .sort((a, b) => ORDEN[a.sus?.estado ?? "sin_suscripcion"] - ORDEN[b.sus?.estado ?? "sin_suscripcion"]),
    );
    setPlanes((p.data ?? []) as Plan[]);
  }, []);

  useEffect(() => {
    if (!mensualidadActiva()) {
      router.replace("/admin");
      return;
    }
    const supabase = createClient();
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return router.replace("/admin/login");
      const { data: perfil } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (perfil?.role !== "admin") return router.replace("/admin/login");
      setListo(true);
      cargar();
    })();
  }, [cargar, router]);

  async function crearPlan(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const dias = Number(nuevo.dias_gracia);
    if (!/^[a-z0-9_-]{2,40}$/.test(nuevo.clave)) return setError("La clave va en minúsculas, sin espacios (por ejemplo: mensual).");
    if (nuevo.nombre.trim().length < 2) return setError("Escribe el nombre del plan.");
    if (!/^price_[A-Za-z0-9]+$/.test(nuevo.stripe_price_id.trim())) return setError("El id del precio de Stripe empieza con price_.");
    if (!Number.isInteger(dias) || dias < 0 || dias > 60) return setError("Los días de gracia van de 0 a 60.");
    setGuardando(true);
    const { error: e2 } = await createClient()
      .from("planes")
      .insert({ clave: nuevo.clave, nombre: nuevo.nombre.trim(), stripe_price_id: nuevo.stripe_price_id.trim(), dias_gracia: dias });
    setGuardando(false);
    if (e2) return setError(mensajeParaUsuario(e2, "No se pudo guardar el plan (¿clave o precio repetidos?)."));
    setNuevo({ clave: "", nombre: "", stripe_price_id: "", dias_gracia: "7" });
    cargar();
  }

  async function alternar(p: Plan) {
    const { error: e2 } = await createClient().from("planes").update({ activo: !p.activo }).eq("id", p.id);
    if (e2) setError(mensajeParaUsuario(e2, "No se pudo cambiar el plan."));
    cargar();
  }

  if (!listo) return null;
  const cuenta = (e: EstadoMensualidad) => (filas ?? []).filter((f) => (f.sus?.estado ?? "sin_suscripcion") === e).length;

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-8 sm:px-6">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <Link href="/admin" className="inline-flex min-h-10 w-fit items-center text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Panel admin
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Mensualidades</h1>
        {error && (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["activa", "en_gracia", "vencida", "sin_suscripcion"] as const).map((e) => (
            <Card key={e} size="sm">
              <CardContent className="flex flex-col gap-1 px-4">
                <span className="text-xs text-muted-foreground">{ETIQUETA_ESTADO[e]}</span>
                <span className="text-2xl font-bold tabular-nums">{cuenta(e)}</span>
              </CardContent>
            </Card>
          ))}
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Antros</h2>
          {filas === null ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
              {filas.map((f) => {
                const e = f.sus?.estado ?? "sin_suscripcion";
                return (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{f.nombre}</span>
                      <span className="text-xs text-muted-foreground">
                        {f.sus?.plan ?? "Sin plan"}
                        {e === "activa" && f.sus?.periodo_fin ? ` · cobra el ${fecha.format(new Date(f.sus.periodo_fin))}` : ""}
                        {e === "en_gracia" && f.sus?.gracia_hasta ? ` · gracia hasta el ${fecha.format(new Date(f.sus.gracia_hasta))}` : ""}
                        {` · ${f.suscripcion_activa ? "publicado" : "no publicado"}`}
                      </span>
                    </span>
                    <Badge variant={TONO_ESTADO[e]}>{ETIQUETA_ESTADO[e]}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Los antros sin fila de suscripción (de antes de la mensualidad) conservan su publicación: la tarea diaria solo despublica vencidos o
            cancelados.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Planes</h2>
          {planes.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {p.nombre} <span className="text-muted-foreground">({p.clave})</span>
                  </span>
                  <span className="break-all text-xs text-muted-foreground">
                    {p.stripe_price_id} · {p.monto_centavos != null ? formatearCentavos(p.monto_centavos) : "precio en Stripe"} · {p.dias_gracia} días de gracia
                  </span>
                </span>
                <Button type="button" variant="outline" className="h-10" onClick={() => alternar(p)}>
                  {p.activo ? "Ocultar" : "Ofrecer"}
                </Button>
              </CardContent>
            </Card>
          ))}
          <Card>
            <CardContent className="px-5 py-5">
              <form onSubmit={crearPlan} className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="plan-clave">Clave</Label>
                  <Input id="plan-clave" className="h-10" placeholder="mensual" value={nuevo.clave} onChange={(e) => setNuevo({ ...nuevo, clave: e.target.value.trim().toLowerCase() })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="plan-nombre">Nombre</Label>
                  <Input id="plan-nombre" className="h-10" placeholder="Mensual" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="plan-precio">Id del precio en Stripe</Label>
                  <Input id="plan-precio" className="h-10" placeholder="price_…" value={nuevo.stripe_price_id} onChange={(e) => setNuevo({ ...nuevo, stripe_price_id: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="plan-gracia">Días de gracia</Label>
                  <Input id="plan-gracia" className="h-10" inputMode="numeric" value={nuevo.dias_gracia} onChange={(e) => setNuevo({ ...nuevo, dias_gracia: e.target.value.replace(/\D/g, "").slice(0, 2) })} />
                </div>
                <Button type="submit" className="h-10 sm:col-span-2" disabled={guardando}>
                  {guardando ? "Guardando…" : "Agregar plan"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
