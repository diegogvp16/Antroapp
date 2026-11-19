"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MensajeError, useAccion } from "@/components/caja/accion";
import { CuadreNoche } from "@/components/caja/cuadre-noche";
import { MapaMesas } from "@/components/caja/mapa-mesas";
import { MesaDetalle } from "@/components/caja/mesa-detalle";
import { etiquetaNoche } from "@/lib/fechas";
import { ordenarMesas } from "@/lib/mesas";
import { cn } from "@/lib/utils";
import {
  PERMISOS_CAJA,
  SIN_PERMISOS,
  type CajaConsumo,
  type CajaCuadre,
  type CajaNoche,
  type CajaPago,
  type DatosCaja,
  type MesaCaja,
  type MesaCuenta,
  type MesaSesion,
  type PermisosCaja,
  type ReservaSentable,
} from "@/lib/domain/caja";

type Vista = "mesas" | "cuadre";

const COLUMNAS_SESION =
  "id, mesa_id, estado, abierta_por, abierta_en, cerrada_en, cuadrada_por, cuadrada_en";
const COLUMNAS_CUENTA =
  "id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas, creada_en";
const COLUMNAS_CONSUMO =
  "id, sesion_id, cuenta_id, monto_centavos, concepto, registrado_por, registrado_en, anulado, anulado_por, anulado_en, motivo_anulacion";
const COLUMNAS_PAGO =
  "id, sesion_id, cuenta_id, metodo, monto_centavos, referencia, registrado_por, registrado_en, anulado, anulado_por, anulado_en, motivo_anulacion";
const COLUMNAS_CUADRE =
  "id, sesion_id, tipo, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos, saldo_sin_cobrar_centavos, contado_efectivo_centavos, contado_tarjeta_centavos, contado_otro_centavos, diferencia_centavos, notas, hecho_por, hecho_en";

// Lanza el error de una consulta (para el catch de cargarCaja).
function filas<T>(r: { data: unknown; error: { message: string } | null }, que: string): T[] {
  if (r.error) throw new Error(`${que}: ${r.error.message}`);
  return (r.data ?? []) as T[];
}

// Lee todo lo de la noche operativa en curso del club.
async function cargarCaja(clubId: string): Promise<{ fecha: string; datos: DatosCaja }> {
  const supabase = createClient();

  const fechaRes = await supabase.rpc("club_fecha_operacion", { p_club_id: clubId });
  if (fechaRes.error) throw new Error(`Noche operativa: ${fechaRes.error.message}`);
  const fecha = fechaRes.data as string;

  const [mesasRes, nocheRes, reservasRes] = await Promise.all([
    supabase.from("club_tables").select("id, numero, capacidad").eq("club_id", clubId),
    supabase
      .from("caja_noches")
      .select("id, club_id, fecha_operacion, estado, cerrada_en")
      .eq("club_id", clubId)
      .eq("fecha_operacion", fecha)
      .maybeSingle(),
    // Reservas de esta noche con la entrada confirmada en la puerta.
    supabase
      .from("reservations")
      .select("id, cliente_nombre, personas, source, rp_id")
      .eq("club_id", clubId)
      .eq("fecha", fecha)
      .or("status.eq.usada,puerta_estado.eq.entro")
      .order("cliente_nombre", { ascending: true }),
  ]);

  const mesas = ordenarMesas(filas<MesaCaja>(mesasRes, "Mesas"));
  if (nocheRes.error) throw new Error(`Noche: ${nocheRes.error.message}`);
  const noche = (nocheRes.data ?? null) as CajaNoche | null;
  const reservas = filas<ReservaSentable>(reservasRes, "Reservas");

  let sesiones: MesaSesion[] = [];
  let cuentas: MesaCuenta[] = [];
  let consumos: CajaConsumo[] = [];
  let pagos: CajaPago[] = [];
  let cuadres: CajaCuadre[] = [];

  if (noche) {
    const [sesionesRes, consumosRes, pagosRes, cuadresRes] = await Promise.all([
      supabase
        .from("mesa_sesiones")
        .select(COLUMNAS_SESION)
        .eq("noche_id", noche.id)
        .order("abierta_en", { ascending: true }),
      supabase
        .from("caja_consumos")
        .select(COLUMNAS_CONSUMO)
        .eq("noche_id", noche.id)
        .order("registrado_en", { ascending: true }),
      supabase
        .from("caja_pagos")
        .select(COLUMNAS_PAGO)
        .eq("noche_id", noche.id)
        .order("registrado_en", { ascending: true }),
      supabase.from("caja_cuadres").select(COLUMNAS_CUADRE).eq("noche_id", noche.id),
    ]);
    sesiones = filas<MesaSesion>(sesionesRes, "Sesiones");
    consumos = filas<CajaConsumo>(consumosRes, "Consumos");
    pagos = filas<CajaPago>(pagosRes, "Pagos");
    cuadres = filas<CajaCuadre>(cuadresRes, "Cuadres");

    if (sesiones.length > 0) {
      const cuentasRes = await supabase
        .from("mesa_cuentas")
        .select(COLUMNAS_CUENTA)
        .in(
          "sesion_id",
          sesiones.map((s) => s.id),
        )
        .order("creada_en", { ascending: true });
      cuentas = filas<MesaCuenta>(cuentasRes, "Cuentas");
    }
  }

  const sentadas = new Set(cuentas.map((c) => c.reservation_id).filter(Boolean));
  const reservasSentables = reservas.filter((r) => !sentadas.has(r.id));

  // Nombres de RPs y del personal que registró, anuló o cuadró.
  const ids = new Set<string>();
  const agregar = (id: string | null) => {
    if (id) ids.add(id);
  };
  cuentas.forEach((c) => agregar(c.rp_id));
  reservasSentables.forEach((r) => agregar(r.rp_id));
  sesiones.forEach((s) => {
    agregar(s.abierta_por);
    agregar(s.cuadrada_por);
  });
  [...consumos, ...pagos].forEach((k) => {
    agregar(k.registrado_por);
    agregar(k.anulado_por);
  });
  cuadres.forEach((c) => agregar(c.hecho_por));

  const nombres: Record<string, string> = {};
  if (ids.size > 0) {
    const perfiles = filas<{ id: string; nombre: string }>(
      await supabase.from("profiles").select("id, nombre").in("id", Array.from(ids)),
      "Nombres",
    );
    for (const p of perfiles) nombres[p.id] = p.nombre;
  }

  return {
    fecha,
    datos: { noche, mesas, sesiones, cuentas, consumos, pagos, cuadres, reservasSentables, nombres },
  };
}

export default function StaffCajaPage() {
  const router = useRouter();
  const [clubId, setClubId] = useState<string | null>(null);
  const [clubNombre, setClubNombre] = useState("");
  const [permisos, setPermisos] = useState<PermisosCaja>(SIN_PERMISOS);
  const [fecha, setFecha] = useState<string | null>(null);
  const [datos, setDatos] = useState<DatosCaja | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [recargando, setRecargando] = useState(false);
  const [vista, setVista] = useState<Vista>("mesas");
  const [mesaId, setMesaId] = useState<string | null>(null);
  const [abriendoId, setAbriendoId] = useState<string | null>(null);
  const abrir = useAccion();
  // Solo cuenta la respuesta de la última recarga (si se piden dos seguidas).
  const ultimaCarga = useRef(0);

  // Sesión: solo staff o gerente con antro.
  useEffect(() => {
    async function cargarSesion() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/cliente/login");
        return;
      }
      const { data: perfil, error } = await supabase
        .from("profiles")
        .select("role, club_id")
        .eq("id", user.id)
        .maybeSingle();
      if (
        error ||
        !perfil ||
        (perfil.role !== "staff" && perfil.role !== "gerente") ||
        !perfil.club_id
      ) {
        router.replace("/cliente/login");
        return;
      }
      const club = perfil.club_id as string;

      const [clubRes, ...permisosRes] = await Promise.all([
        supabase.from("clubs").select("nombre").eq("id", club).maybeSingle(),
        ...PERMISOS_CAJA.map((p) =>
          supabase.rpc("caja_tiene_permiso", { p_club_id: club, p_permiso: p }),
        ),
      ]);
      if (clubRes.data) setClubNombre(clubRes.data.nombre as string);
      const nuevos: PermisosCaja = { ...SIN_PERMISOS };
      PERMISOS_CAJA.forEach((p, i) => {
        const r = permisosRes[i];
        if (r.error) console.error(`Error leyendo permiso ${p}:`, r.error);
        nuevos[p] = r.data === true;
      });
      setPermisos(nuevos);
      setClubId(club);
    }
    cargarSesion();
  }, [router]);

  const recargar = useCallback(async () => {
    if (!clubId) return;
    const numero = ++ultimaCarga.current;
    setRecargando(true);
    try {
      const resultado = await cargarCaja(clubId);
      if (numero !== ultimaCarga.current) return;
      setFecha(resultado.fecha);
      setDatos(resultado.datos);
      setErrorCarga(null);
    } catch (err) {
      console.error("Error cargando la caja:", err);
      if (numero !== ultimaCarga.current) return;
      setErrorCarga(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      if (numero === ultimaCarga.current) setRecargando(false);
    }
  }, [clubId]);

  useEffect(() => {
    recargar();
  }, [recargar]);

  async function abrirMesa(id: string) {
    setAbriendoId(id);
    const ok = await abrir.ejecutar(
      () => createClient().rpc("caja_abrir_mesa", { p_mesa_id: id }),
      recargar,
    );
    setAbriendoId(null);
    if (ok) setMesaId(id);
  }

  const nocheCerrada = datos?.noche?.estado === "cerrada";
  const mesa = datos && mesaId ? datos.mesas.find((m) => m.id === mesaId) : undefined;

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <Link
          href="/staff/panel"
          className="w-fit text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          ← Panel
        </Link>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold tracking-tight">
              Caja{clubNombre ? ` · ${clubNombre}` : ""}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{fecha ? `Noche del ${etiquetaNoche(fecha)}` : "Noche en curso"}</span>
              {datos && (
                <Badge variant={nocheCerrada ? "warn" : datos.noche ? "ok" : "neutral"}>
                  {nocheCerrada ? "Noche cerrada" : datos.noche ? "Noche abierta" : "Sin mesas abiertas"}
                </Badge>
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={recargar}
            disabled={!clubId || recargando}
          >
            {recargando ? "Actualizando..." : "Actualizar"}
          </Button>
        </div>

        {permisos.cerrar_noche && (
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
            {(
              [
                ["mesas", "Mesas de la noche"],
                ["cuadre", "Cuadre de la noche"],
              ] as const
            ).map(([v, etiqueta]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={vista === v}
                onClick={() => setVista(v)}
                className={cn(
                  "h-8 rounded-md text-sm font-medium text-muted-foreground",
                  vista === v && "bg-background text-foreground shadow-sm",
                )}
              >
                {etiqueta}
              </button>
            ))}
          </div>
        )}

        {errorCarga && (
          <Card size="sm">
            <CardContent className="flex flex-col gap-2 px-4">
              <p className="text-sm text-destructive" role="alert">
                No pudimos cargar la caja. {errorCarga}
              </p>
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={recargar}>
                Reintentar
              </Button>
            </CardContent>
          </Card>
        )}

        {vista === "mesas" && <MensajeError mensaje={abrir.error} />}

        {!datos ? (
          !errorCarga && <p className="text-sm text-muted-foreground">Cargando la caja...</p>
        ) : vista === "cuadre" && permisos.cerrar_noche ? (
          <CuadreNoche datos={datos} onCambio={recargar} />
        ) : mesa ? (
          <MesaDetalle
            key={mesa.id}
            mesa={mesa}
            datos={datos}
            permisos={permisos}
            onCambio={recargar}
            onVolver={() => setMesaId(null)}
            onAbrir={abrirMesa}
            abriendo={abriendoId === mesa.id}
          />
        ) : (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Mesas de la noche</h2>
            <MapaMesas
              datos={datos}
              puedeAbrir={permisos.abrir_mesa && !nocheCerrada}
              abriendoId={abriendoId}
              onSeleccionar={setMesaId}
              onAbrir={abrirMesa}
            />
          </section>
        )}
      </div>
    </div>
  );
}
