"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RefreshCw } from "lucide-react";
import { CuadreNoche } from "@/components/caja/cuadre-noche";
import { MapaNoche } from "@/components/caja/mapa-noche";
import { DetalleMesa } from "@/components/caja/detalle-mesa";
import { etiquetaNoche } from "@/lib/fechas";
import { ordenarMesas } from "@/lib/mesas";
import { cn } from "@/lib/utils";
import {
  formatearCentavos,
  resumirMesa,
  totalesNoche,
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
  const [esGerente, setEsGerente] = useState(false);
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
      setEsGerente(perfil.role === "gerente");

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

  const nocheCerrada = datos?.noche?.estado === "cerrada";
  const resumenes = datos ? datos.mesas.map((m) => resumirMesa(m, datos)) : [];
  const actual = mesaId ? resumenes.find((r) => r.mesa.id === mesaId) : undefined;
  const totales = datos ? totalesNoche(datos) : null;

  return (
    <div className="theme-caja flex flex-1 flex-col items-center px-4 pt-3 pb-4 font-sans">
      <div className="flex w-full max-w-md min-w-0 flex-col gap-3">
        {!actual && (
          <header className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Link href="/staff/panel" className="-ml-2 flex h-11 items-center px-2 text-sm text-caja-secundario hover:text-caja-texto">
                ← Panel
              </Link>
              <span className="ml-auto text-sm text-caja-secundario">{clubNombre}</span>
              <button
                type="button"
                onClick={recargar}
                disabled={!clubId || recargando}
                aria-label="Actualizar"
                className="-mr-2 flex size-11 items-center justify-center rounded-md text-caja-secundario hover:text-caja-texto disabled:opacity-40"
              >
                <RefreshCw className={cn("size-4", recargando && "animate-spin")} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="text-base font-semibold">{fecha ? `Noche del ${etiquetaNoche(fecha)}` : "Noche en curso"}</h1>
              {datos && (
                <span className={cn("text-xs", nocheCerrada ? "text-caja-aviso" : datos.noche ? "text-caja-ok" : "text-caja-secundario")}>
                  {nocheCerrada ? "Noche cerrada" : datos.noche ? "Noche abierta" : "Sin mesas abiertas"}
                </span>
              )}
              {permisos.cerrar_noche && (
                <button
                  type="button"
                  onClick={() => setVista(vista === "cuadre" ? "mesas" : "cuadre")}
                  className="ml-auto h-11 rounded-md border border-caja-borde px-3 text-sm"
                >
                  {vista === "cuadre" ? "Ver mesas" : "Cuadre de la noche"}
                </button>
              )}
            </div>
            {totales && (
              <dl className="grid grid-cols-3 gap-2 rounded-lg border border-caja-borde bg-caja-superficie px-3 py-2 text-xs">
                <div><dt className="text-caja-secundario">Consumo</dt><dd className="text-sm font-medium tabular-nums">{formatearCentavos(totales.consumo)}</dd></div>
                <div><dt className="text-caja-secundario">Cobrado</dt><dd className="text-sm font-medium tabular-nums">{formatearCentavos(totales.cobrado)}</dd></div>
                <div><dt className="text-caja-secundario">Por cobrar</dt><dd className={cn("text-sm font-medium tabular-nums", totales.porCobrar > 0 && "text-caja-dorado")}>{formatearCentavos(totales.porCobrar)}</dd></div>
              </dl>
            )}
          </header>
        )}

        {errorCarga && (
          <div className="flex flex-col gap-2 rounded-lg border border-caja-borde p-3">
            <p className="text-sm text-destructive" role="alert">No pudimos cargar la caja. {errorCarga}</p>
            <button type="button" onClick={recargar} className="h-11 w-fit rounded-md border border-caja-borde px-3 text-sm">Reintentar</button>
          </div>
        )}

        {!datos ? (
          !errorCarga && <p className="text-sm text-caja-secundario">Cargando la caja...</p>
        ) : vista === "cuadre" && permisos.cerrar_noche && !actual ? (
          <CuadreNoche datos={datos} onCambio={recargar} />
        ) : actual ? (
          <DetalleMesa
            key={actual.mesa.id}
            m={actual}
            datos={datos}
            permisos={permisos}
            esGerente={esGerente}
            nocheCerrada={nocheCerrada}
            onVolver={() => setMesaId(null)}
            onCambio={recargar}
          />
        ) : (
          <MapaNoche mesas={resumenes} onAbrirMesa={setMesaId} />
        )}
      </div>
    </div>
  );
}
