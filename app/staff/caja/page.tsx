"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cerrarSesionDadoDeBaja } from "@/lib/cuenta-dada-de-baja";
import { RefreshCw, WifiOff } from "lucide-react";
import { CuadreNoche } from "@/components/caja/cuadre-noche";
import { MapaNoche } from "@/components/caja/mapa-noche";
import { DetalleMesa } from "@/components/caja/detalle-mesa";
import { AvisoCola, AvisoSesionCaja } from "@/components/caja/cola-caja";
import { useColaCaja } from "@/lib/use-cola-caja";
import { conPendientes, conteoPorMesa, sinLoYaGuardado, type NuevoMovimiento } from "@/lib/domain/caja-cola";
import { etiquetaNoche } from "@/lib/fechas";
import { ordenarMesas } from "@/lib/mesas";
import { cn } from "@/lib/utils";
import { esErrorDeRed } from "@/lib/errores-base";
import { useEnLinea } from "@/lib/use-en-linea";
import { FASE2_ACTIVA } from "@/lib/fase2";
import { Fase2Provider } from "@/lib/fase2-contexto";
import {
  formatearCentavos,
  nombreMesa,
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
  type Producto,
  type ReservaSentable,
} from "@/lib/domain/caja";

type Vista = "mesas" | "cuadre";

// Cada cuánto se vuelve a leer la caja para ver lo que registran otros staff
// (sin recargar la página). Con la conexión caída se reintenta más seguido.
const CADA_MS = 10_000;
const CADA_MS_SIN_RED = 4_000;
const horaMinSeg = (d: Date) =>
  d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const COLUMNAS_SESION =
  "id, mesa_id, estado, abierta_por, abierta_en, cerrada_en, cuadrada_por, cuadrada_en";
const COLUMNAS_CUENTA =
  "id, sesion_id, reservation_id, rp_id, origen, cliente_nombre, personas, creada_en";
const COLUMNAS_CONSUMO =
  "id, sesion_id, cuenta_id, monto_centavos, concepto, registrado_por, registrado_en, anulado, anulado_por, anulado_en, motivo_anulacion, clave_cliente";
const COLUMNAS_PAGO =
  "id, sesion_id, cuenta_id, metodo, monto_centavos, referencia, registrado_por, registrado_en, anulado, anulado_por, anulado_en, motivo_anulacion, clave_cliente" +
  // Fase 2: la propina solo se lee con la bandera (sin ella la base puede no tenerla).
  (FASE2_ACTIVA ? ", propina_centavos" : "");
const COLUMNAS_PRODUCTO = "id, nombre, categoria, precio_centavos, existencias, existencias_minimas, activo";
const COLUMNAS_CUADRE =
  "id, sesion_id, tipo, registrado_centavos, cobrado_efectivo_centavos, cobrado_tarjeta_centavos, cobrado_otro_centavos, saldo_sin_cobrar_centavos, contado_efectivo_centavos, contado_tarjeta_centavos, contado_otro_centavos, diferencia_centavos, notas, hecho_por, hecho_en";

// Lanza el error de una consulta (para el catch de cargarCaja).
function filas<T>(r: { data: unknown; error: { message: string } | null }, que: string): T[] {
  if (r.error) throw new Error(`${que}: ${r.error.message}`);
  return (r.data ?? []) as T[];
}

// PostgREST entrega como máximo 1000 filas por consulta: una noche con más
// consumos o pagos perdería en silencio los últimos (y el saldo saldría más
// bajo). Se lee por páginas hasta traer todo.
const PAGINA = 1000;
type ConsultaPaginada = {
  range: (desde: number, hasta: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
async function todas<T>(armar: () => ConsultaPaginada, que: string): Promise<T[]> {
  const total: T[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const r = await armar().range(desde, desde + PAGINA - 1);
    const lote = filas<T>(r, que);
    total.push(...lote);
    if (lote.length < PAGINA) return total;
  }
}

// Firma de la noche: cambia cuando cambia algo de la caja. Nula si la base
// aún no tiene la función (entonces cada revisión lee todo, como antes).
async function leerFirma(clubId: string): Promise<string | null> {
  const r = await createClient().rpc("caja_firma_noche", { p_club_id: clubId });
  if (r.error) {
    if (r.error.code === "PGRST202") return null;
    throw new Error(`Firma: ${r.error.message}`);
  }
  return typeof r.data === "string" ? r.data : null;
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
    const nocheId = noche.id;
    // Orden con desempate por id: estable entre páginas.
    // Las cuentas se filtran por la noche de su sesión (join en la base),
    // en el mismo viaje que lo demás.
    let cuentasConSesion: (MesaCuenta & { mesa_sesiones?: unknown })[];
    [sesiones, consumos, pagos, cuadres, cuentasConSesion] = await Promise.all([
      todas<MesaSesion>(() => supabase.from("mesa_sesiones").select(COLUMNAS_SESION).eq("noche_id", nocheId).order("abierta_en").order("id"), "Sesiones"),
      todas<CajaConsumo>(() => supabase.from("caja_consumos").select(COLUMNAS_CONSUMO).eq("noche_id", nocheId).order("registrado_en").order("id"), "Consumos"),
      todas<CajaPago>(() => supabase.from("caja_pagos").select(COLUMNAS_PAGO).eq("noche_id", nocheId).order("registrado_en").order("id"), "Pagos"),
      todas<CajaCuadre>(() => supabase.from("caja_cuadres").select(COLUMNAS_CUADRE).eq("noche_id", nocheId).order("id"), "Cuadres"),
      todas<MesaCuenta & { mesa_sesiones?: unknown }>(
        () =>
          supabase
            .from("mesa_cuentas")
            .select(`${COLUMNAS_CUENTA}, mesa_sesiones!inner(noche_id)`)
            .eq("mesa_sesiones.noche_id", nocheId)
            .order("creada_en")
            .order("id"),
        "Cuentas",
      ),
    ]);
    cuentas = cuentasConSesion.map((c) => {
      const copia = { ...c };
      delete copia.mesa_sesiones;
      return copia;
    });
  }

  // Fase 2: catálogo activo del antro (para la hoja de consumo).
  const productos = FASE2_ACTIVA
    ? filas<Producto>(await supabase.from("productos").select(COLUMNAS_PRODUCTO).eq("club_id", clubId).eq("activo", true).order("nombre"), "Productos")
    : [];

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
    datos: { noche, mesas, sesiones, cuentas, consumos, pagos, cuadres, reservasSentables, nombres, productos },
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
  const [usuarioId, setUsuarioId] = useState<string | null>(null);
  // Solo cuenta la respuesta de la última recarga (si se piden dos seguidas).
  const ultimaCarga = useRef(0);
  const enVuelo = useRef(false);
  // Firma de la noche de la última lectura completa (caja_firma_noche).
  const ultimaFirma = useRef<string | null>(null);
  const enLinea = useEnLinea();
  // La última lectura falló por la red (wifi sin salida, señal mala).
  const [falloRed, setFalloRed] = useState(false);
  // Hora de la última lectura confirmada. Ref, no estado: cada revisión sin
  // cambios no vuelve a pintar las 50 mesas; el aviso la lee al aparecer.
  const actualizado = useRef<Date | null>(null);
  const sinConexion = !enLinea || falloRed;

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
        .select("role, club_id, activo")
        .eq("id", user.id)
        .maybeSingle();
      if (perfil?.activo === false) {
        await cerrarSesionDadoDeBaja(supabase, router, { colaCaja: true });
        return;
      }
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
      setUsuarioId(user.id);

      // Todos los permisos en una llamada (caja_mis_permisos). Si la base aún
      // no tiene esa función, se piden uno por uno como antes.
      const [clubRes, todos] = await Promise.all([
        supabase.from("clubs").select("nombre").eq("id", club).maybeSingle(),
        supabase.rpc("caja_mis_permisos", { p_club_id: club }),
      ]);
      if (clubRes.data) setClubNombre(clubRes.data.nombre as string);
      const nuevos: PermisosCaja = { ...SIN_PERMISOS };
      if (!todos.error && todos.data && typeof todos.data === "object") {
        const mapa = todos.data as Record<string, unknown>;
        for (const p of PERMISOS_CAJA) nuevos[p] = mapa[p] === true;
      } else {
        const uno = await Promise.all(
          PERMISOS_CAJA.map((p) => supabase.rpc("caja_tiene_permiso", { p_club_id: club, p_permiso: p })),
        );
        PERMISOS_CAJA.forEach((p, i) => {
          if (uno[i].error) console.error(`Error leyendo permiso ${p}:`, uno[i].error);
          nuevos[p] = uno[i].data === true;
        });
        // Sin permisos leídos la mesa se vería sin botones y sin explicación.
        if (uno.some((x) => x.error)) setErrorCarga("No pudimos leer tus permisos de caja. Revisa tu conexión y vuelve a abrir la caja.");
      }
      setPermisos(nuevos);
      setClubId(club);
    }
    cargarSesion();
  }, [router]);

  // silencioso: la revisión periódica no mueve el ícono de actualizar.
  const cargar = useCallback(
    async (silencioso: boolean) => {
      if (!clubId) return;
      const numero = ++ultimaCarga.current;
      enVuelo.current = true;
      if (!silencioso) setRecargando(true);
      try {
        // La firma se pide antes de leer: si algo cambia mientras se lee, la
        // siguiente revisión lo nota y vuelve a leer.
        const firma = await leerFirma(clubId);
        if (silencioso && firma !== null && firma === ultimaFirma.current) {
          // Nada cambió: no se baja la noche otra vez.
          if (numero === ultimaCarga.current) {
            setFalloRed(false);
            actualizado.current = new Date();
          }
          return;
        }
        const resultado = await cargarCaja(clubId);
        ultimaFirma.current = firma;
        if (numero !== ultimaCarga.current) return;
        setFecha(resultado.fecha);
        setDatos(resultado.datos);
        setErrorCarga(null);
        setFalloRed(false);
        actualizado.current = new Date();
      } catch (err) {
        if (numero !== ultimaCarga.current) return;
        if (esErrorDeRed(err)) {
          setFalloRed(true);
        } else {
          console.error("Error cargando la caja:", err);
          setErrorCarga("Revisa tu conexión e intenta de nuevo.");
        }
      } finally {
        if (numero === ultimaCarga.current) {
          enVuelo.current = false;
          setRecargando(false);
        }
      }
    },
    [clubId],
  );
  const recargar = useCallback(() => cargar(false), [cargar]);

  // Consumos y cobros capturados (con o sin señal): primero al teléfono y de
  // ahí a la base. Lo que la base ya tiene (misma clave) no se suma dos veces.
  const cola = useColaCaja({ usuarioId, enLinea: !sinConexion, onCambioEnBase: recargar });
  const { quedan: movimientos, yaGuardados } = useMemo(() => {
    const delClub = cola.movimientos.filter((x) => x.clubId === clubId);
    return datos ? sinLoYaGuardado(delClub, [...datos.consumos, ...datos.pagos]) : { quedan: delClub, yaGuardados: [] as string[] };
  }, [cola.movimientos, clubId, datos]);
  const { descartar } = cola;
  // La sesión del teléfono dejó de ser la de quien abrió la caja (se cerró o
  // entró otra cuenta en otra pestaña): la caja se tapa. Sus lecturas y
  // botones irían con la sesión de otra persona o con ninguna.
  const sesionAjena = cola.sesion === "ok" ? null : cola.sesion;
  useEffect(() => {
    if (yaGuardados.length) void descartar(yaGuardados);
  }, [yaGuardados, descartar]);
  const enviarMovimientos = useCallback(
    (nuevos: Omit<NuevoMovimiento, "clubId">[]) => cola.enviar(nuevos.map((n) => ({ ...n, clubId: clubId ?? "" }))),
    [cola, clubId],
  );

  useEffect(() => {
    recargar();
  }, [recargar]);

  // Revisión periódica mientras la pantalla está a la vista, y al volver la
  // red o la pantalla. No pisa lo que el staff está capturando: las hojas
  // guardan su propio estado y solo cambian los números de la base.
  useEffect(() => {
    if (!clubId) return;
    const revisar = () => {
      if (document.visibilityState === "visible" && !enVuelo.current) void cargar(true);
    };
    const id = window.setInterval(revisar, sinConexion ? CADA_MS_SIN_RED : CADA_MS);
    window.addEventListener("online", revisar);
    document.addEventListener("visibilitychange", revisar);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", revisar);
      document.removeEventListener("visibilitychange", revisar);
    };
  }, [clubId, cargar, sinConexion]);

  const nocheCerrada = datos?.noche?.estado === "cerrada";
  // Una sola pasada por render de datos (no por tecla del buscador: la
  // búsqueda vive dentro del mapa).
  // Con lo pendiente de enviar sumado al saldo de las mesas abiertas: es lo
  // que el staff tiene enfrente (y el saldo esperado de un cobro sin señal).
  const resumenes = useMemo(
    () =>
      datos
        ? datos.mesas.map((m) => {
            const r = resumirMesa(m, datos);
            return r.estado === "abierta" ? conPendientes(r, r.sesion?.id ?? null, movimientos) : { ...r, porEnviar: 0 };
          })
        : [],
    [datos, movimientos],
  );
  const porMesa = useMemo(() => conteoPorMesa(movimientos), [movimientos]);
  const nombreDeMesa = useCallback(
    (id: string) => {
      const mesa = datos?.mesas.find((x) => x.id === id);
      return mesa ? nombreMesa(mesa.numero) : "Mesa";
    },
    [datos],
  );
  const actual = mesaId ? resumenes.find((r) => r.mesa.id === mesaId) : undefined;
  // Totales de la noche con lo pendiente de enviar, con la MISMA regla que las
  // mesas: solo lo de una sesión abierta de esta noche. Lo pendiente de una
  // mesa ya cerrada o cuadrada, o de otra noche, no suma (la base lo va a
  // rechazar) y así "Por cobrar" cuadra con la suma de las mesas.
  const totales = useMemo(() => {
    if (!datos) return null;
    const t = totalesNoche(datos);
    const abiertas = new Set(resumenes.filter((r) => r.estado === "abierta" && r.sesion).map((r) => r.sesion!.id));
    let consumo = t.consumo;
    let cobrado = t.cobrado;
    for (const x of movimientos) {
      if (x.estado !== "pendiente" || !abiertas.has(x.sesionId)) continue;
      if (x.tipo === "pago") cobrado += x.montoCentavos;
      else consumo += x.montoCentavos;
    }
    return { consumo, cobrado, porCobrar: Math.max(0, consumo - cobrado) };
  }, [datos, movimientos, resumenes]);

  return (
    // Fase 2 (bloque 8): banderas del antro para inventario y propinas.
    <Fase2Provider clubId={clubId}>
    <div className="theme-caja flex flex-1 flex-col items-center px-4 pt-3 pb-4 font-sans">
      <div className="flex w-full max-w-md min-w-0 flex-col gap-3">
        {!actual && !sesionAjena && (
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

        {sinConexion && (
          <div role="status" className="sticky top-0 z-30 flex items-start gap-2 rounded-lg border border-caja-aviso/60 bg-caja-superficie px-3 py-2 text-sm">
            <WifiOff className="mt-0.5 size-4 shrink-0 text-caja-aviso" aria-hidden="true" />
            <p>
              <span className="font-medium">Sin conexión · reconectando…</span>
              <span className="block text-xs text-caja-secundario">
                {actualizado.current ? `Los montos son de las ${horaMinSeg(actualizado.current)} y pueden haber cambiado. ` : ""}
                Consumos y cobros de mesas abiertas se guardan en este teléfono y se envían solos al volver la señal. Abrir, sentar,
                cerrar y cuadrar necesitan señal.
              </span>
            </p>
          </div>
        )}

        {!actual && !sesionAjena && (
          <AvisoCola
            movimientos={movimientos}
            persistente={cola.persistente}
            enviando={cola.enviando}
            sinConexion={sinConexion}
            nombreDeMesa={nombreDeMesa}
            onVerMesa={(id) => {
              setVista("mesas");
              setMesaId(id);
            }}
            onDescartar={(c) => void cola.descartar(c)}
            onEnviarAhora={cola.sincronizar}
            deOtraCuenta={cola.deOtraCuenta}
          />
        )}

        {errorCarga && !sesionAjena && !(datos && sinConexion) && (
          <div className="flex flex-col gap-2 rounded-lg border border-caja-borde p-3">
            <p className="text-sm text-destructive" role="alert">No pudimos cargar la caja. {errorCarga}</p>
            <button type="button" onClick={recargar} className="h-11 w-fit rounded-md border border-caja-borde px-3 text-sm">Reintentar</button>
          </div>
        )}

        {sesionAjena ? (
          <AvisoSesionCaja
            estado={sesionAjena}
            pendientes={cola.movimientos.filter((x) => x.estado === "pendiente").length}
            onReabrir={() => window.location.reload()}
          />
        ) : !datos ? (
          !errorCarga && <p className="text-sm text-caja-secundario">Cargando la caja...</p>
        ) : vista === "cuadre" && permisos.cerrar_noche && !actual ? (
          <CuadreNoche
            datos={datos}
            onCambio={recargar}
            enlaceCierre={esGerente && clubId && fecha ? `/grupo/noche?club=${clubId}&fecha=${fecha}&desde=caja` : undefined}
          />
        ) : actual ? (
          <DetalleMesa
            key={actual.mesa.id}
            m={actual}
            datos={datos}
            permisos={permisos}
            esGerente={esGerente}
            nocheCerrada={nocheCerrada}
            sinConexion={sinConexion}
            movimientos={movimientos.filter((x) => x.mesaId === actual.mesa.id)}
            onEnviar={enviarMovimientos}
            onDescartar={(c) => void cola.descartar(c)}
            onEnviarAhora={cola.sincronizar}
            enviandoCola={cola.enviando}
            onVolver={() => setMesaId(null)}
            onCambio={recargar}
          />
        ) : (
          <MapaNoche mesas={resumenes} porMesa={porMesa} onAbrirMesa={setMesaId} />
        )}
      </div>
    </div>
    </Fase2Provider>
  );
}
