"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { descargarArchivo } from "@/lib/descargar-archivo";
import { formatearCentavos } from "@/lib/domain/caja";
import { esFechaISO } from "@/lib/domain/cierre-noche";
import {
  csvComisiones,
  csvConsumos,
  csvRendimientoRp,
  csvReservas,
  FUNCION_EXPORTE,
  LIMITE_PAGINA,
  nombreArchivoExporte,
  normalizarComision,
  normalizarConsumo,
  normalizarInfo,
  normalizarReserva,
  resumenComisiones,
  resumenConsumos,
  resumenReservas,
  resumenRps,
  traerTodo,
  type InfoExportes,
  type ResumenExporte,
  type TipoExporte,
} from "@/lib/domain/exportes";
import { nombreZona, normalizarRendimiento, validarRango } from "@/lib/domain/grupo";
import { etiquetaNoche, etiquetaRango, nocheOperativaMexico, sumarDiasISO, type RangoNoches } from "@/lib/fechas";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SELECT_CLASSES } from "@/components/caja/accion";
import { rangoDeAtajo, SelectorRango, type Atajo } from "@/components/grupo/selector-rango";
import { TemaReportesContenedor } from "@/components/tema-reportes";
import { cn } from "@/lib/utils";
import type { Profile } from "@/types";

type Rol = Profile["role"];
type RolPermitido = "dueno" | "gerente" | "admin";

const VOLVER: Record<RolPermitido, string> = { dueno: "/dueno/panel", gerente: "/staff/panel", admin: "/admin" };
const PANEL_DE: Partial<Record<Rol, string>> = { staff: "/staff/panel", rp: "/rp/panel", cliente: "/cliente" };
const esPermitido = (rol: Rol): rol is RolPermitido => rol === "dueno" || rol === "gerente" || rol === "admin";

type Antro = { id: string; nombre: string };
type Sesion =
  | { estado: "cargando" }
  | { estado: "permitido"; rol: RolPermitido; antros: Antro[] }
  | { estado: "sin_acceso"; panel: string }
  | { estado: "error"; mensaje: string };

type EstadoDescarga =
  | { estado: "inactivo" }
  | { estado: "descargando"; renglones: number }
  | { estado: "listo"; resumen: ResumenExporte; archivo: string }
  | { estado: "vacio" }
  | { estado: "error"; mensaje: string };

const INACTIVOS: Record<TipoExporte, EstadoDescarga> = {
  reservas: { estado: "inactivo" },
  consumos: { estado: "inactivo" },
  comisiones: { estado: "inactivo" },
  rps: { estado: "inactivo" },
};

const TEXTO_TELEFONO: Record<InfoExportes["telefono"], string> = {
  completo: "con teléfono completo",
  enmascarado: "con solo los últimos 4 dígitos del teléfono",
  sin_telefono: "sin teléfono",
};

const TARJETAS: { tipo: TipoExporte; titulo: string; detalle: (info: InfoExportes | null) => string; suma: string }[] = [
  {
    tipo: "reservas",
    titulo: "Reservas",
    detalle: (info) =>
      `Una fila por reserva: cliente (${info ? TEXTO_TELEFONO[info.telefono] : "…"}), personas, origen, RP, estado, mesa y consumo.`,
    suma: "consumo de las reservas",
  },
  {
    tipo: "consumos",
    titulo: "Consumo en caja",
    detalle: () => "Una fila por renglón de caja: mesa, grupo, cuenta, RP, concepto y quién lo registró. Los anulados van marcados y no suman.",
    suma: "consumo sin anulados",
  },
  {
    tipo: "comisiones",
    titulo: "Comisiones y pagos a RPs",
    detalle: () => "Comisiones por reserva y pagos por día de cada RP, con su estado. Las anuladas van marcadas y no suman.",
    suma: "comisiones y pagos sin anulados",
  },
  {
    tipo: "rps",
    titulo: "Rendimiento por RP",
    detalle: () => "Una fila por RP: reservas, entradas, consumo y lo que gana (las mismas cifras que el resumen).",
    suma: "comisiones y pagos",
  },
];

const miles = (n: number) => n.toLocaleString("es-MX");

function Contenedor({ children }: { children: React.ReactNode }) {
  return (
    <TemaReportesContenedor className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">{children}</div>
    </TemaReportesContenedor>
  );
}

// Pantalla de exportación CSV. Se monta en /grupo/exportar, /dueno/exportar
// y /staff/exportar (solo el gerente). Quién ve qué lo decide la base.
export function PantallaExportar({ volver }: { volver?: string }) {
  const router = useRouter();
  const [sesion, setSesion] = useState<Sesion>({ estado: "cargando" });
  const [clubId, setClubId] = useState<string | null>(null);
  const [info, setInfo] = useState<InfoExportes | null>(null);
  const [errorInfo, setErrorInfo] = useState<string | null>(null);
  const [modo, setModo] = useState<"noche" | "rango">("noche");
  const [noche, setNoche] = useState<string>(() => nocheOperativaMexico());
  const [atajo, setAtajo] = useState<Atajo>("semana");
  const [rango, setRango] = useState<RangoNoches>(() => rangoDeAtajo("semana"));
  const [descargas, setDescargas] = useState<Record<TipoExporte, EstadoDescarga>>(INACTIVOS);
  const [intentoInfo, setIntentoInfo] = useState(0);

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
      const { data: perfil, error: errorPerfil } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (errorPerfil || !perfil) {
        router.replace("/cliente/login");
        return;
      }
      const rol = perfil.role as Rol;
      if (!esPermitido(rol)) {
        setSesion({ estado: "sin_acceso", panel: PANEL_DE[rol] ?? "/cliente" });
        return;
      }
      const hoy = nocheOperativaMexico();
      const { data, error: errorLista } = await supabase.rpc("grupo_resumen", { p_desde: hoy, p_hasta: hoy });
      if (errorLista) {
        setSesion({ estado: "error", mensaje: mensajeParaUsuario(errorLista, "No pudimos cargar tus antros. Intenta de nuevo.") });
        return;
      }
      const antros = ((Array.isArray(data) ? data : []) as { club_id: string; nombre: string }[]).map((a) => ({ id: a.club_id, nombre: a.nombre }));
      setSesion({ estado: "permitido", rol, antros });
      setClubId(antros[0]?.id ?? null);
    }
    void cargarSesion();
  }, [router]);

  // Nivel de acceso del antro elegido (qué teléfono verá) y su noche en curso.
  useEffect(() => {
    if (!clubId) return;
    let vigente = true;
    setInfo(null);
    setErrorInfo(null);
    setDescargas(INACTIVOS);
    void createClient()
      .rpc("reporte_exportes_info", { p_club_id: clubId })
      .then(({ data, error }) => {
        if (!vigente) return;
        if (error) {
          setErrorInfo(
            error.code === "PGRST202"
              ? "Los reportes para descargar todavía no están disponibles."
              : mensajeParaUsuario(error, "No pudimos revisar tu acceso a los reportes. Intenta de nuevo."),
          );
          return;
        }
        const i = normalizarInfo(data);
        setInfo(i);
        if (i && esFechaISO(i.noche_en_curso)) setNoche(i.noche_en_curso);
      });
    return () => {
      vigente = false;
    };
  }, [clubId, intentoInfo]);

  const efectivo: RangoNoches = modo === "noche" ? { desde: noche, hasta: noche } : rango;
  const invalido = validarRango(efectivo);
  const ocupado = Object.values(descargas).some((d) => d.estado === "descargando");

  async function descargar(tipo: TipoExporte) {
    if (!clubId || !info || validarRango(efectivo)) return;
    const supabase = createClient();
    const poner = (e: EstadoDescarga) => setDescargas((d) => ({ ...d, [tipo]: e }));
    poner({ estado: "descargando", renglones: 0 });
    try {
      let csv: string;
      let resumen: ResumenExporte;
      if (tipo === "rps") {
        const { data, error } = await supabase.rpc("grupo_rendimiento_rp", {
          p_club_id: clubId,
          p_desde: efectivo.desde,
          p_hasta: efectivo.hasta,
        });
        if (error) {
          poner({ estado: "error", mensaje: mensajeParaUsuario(error, "No pudimos armar el archivo. Intenta de nuevo.") });
          return;
        }
        const filas = (Array.isArray(data) ? data : [])
          .map((f) => normalizarRendimiento(f as Record<string, unknown>))
          .filter((f) => f.reservas > 0 || f.comisiones_centavos > 0);
        csv = csvRendimientoRp(filas);
        resumen = resumenRps(filas);
      } else {
        const r = await traerTodo(
          async (despues) => {
            const { data, error } = await supabase.rpc(FUNCION_EXPORTE[tipo], {
              p_club_id: clubId,
              p_desde: efectivo.desde,
              p_hasta: efectivo.hasta,
              p_despues: despues,
              p_limite: LIMITE_PAGINA,
            });
            if (error) return { error };
            return { filas: (Array.isArray(data) ? data : []) as Record<string, unknown>[] };
          },
          { alAvanzar: (renglones) => poner({ estado: "descargando", renglones }) },
        );
        if ("error" in r) {
          const e = r.error as { message?: string; code?: string };
          poner({
            estado: "error",
            mensaje:
              e.code === "PGRST202"
                ? "Este reporte todavía no está disponible."
                : !e.code && e.message?.startsWith("La descarga")
                  ? e.message
                  : mensajeParaUsuario(e as { message: string; code?: string }, "No pudimos armar el archivo. Intenta de nuevo."),
          });
          return;
        }
        if (tipo === "reservas") {
          const filas = r.filas.map(normalizarReserva);
          csv = csvReservas(filas, info.telefono);
          resumen = resumenReservas(filas);
        } else if (tipo === "consumos") {
          const filas = r.filas.map(normalizarConsumo);
          csv = csvConsumos(filas);
          resumen = resumenConsumos(filas);
        } else {
          const filas = r.filas.map(normalizarComision);
          csv = csvComisiones(filas);
          resumen = resumenComisiones(filas);
        }
      }
      if (resumen.renglones === 0) {
        poner({ estado: "vacio" });
        return;
      }
      const archivo = nombreArchivoExporte(tipo, info.club.nombre, efectivo.desde, efectivo.hasta);
      descargarArchivo(csv, archivo);
      poner({ estado: "listo", resumen, archivo });
    } catch (err) {
      console.error("Error al exportar:", err);
      poner({ estado: "error", mensaje: "No se pudo descargar. Revisa tu conexión e intenta de nuevo." });
    }
  }

  if (sesion.estado === "cargando") {
    return (
      <Contenedor>
        <p className="text-sm text-muted-foreground">Cargando...</p>
      </Contenedor>
    );
  }
  if (sesion.estado === "sin_acceso") {
    return (
      <Contenedor>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">Descargar reportes es para gerentes y dueños.</p>
            <Link href={sesion.panel} className="inline-flex min-h-10 w-fit items-center text-sm font-medium underline underline-offset-4">
              Ir a tu panel
            </Link>
          </CardContent>
        </Card>
      </Contenedor>
    );
  }
  if (sesion.estado === "error") {
    return (
      <Contenedor>
        <p className="text-sm text-destructive" role="alert">
          {sesion.mensaje}
        </p>
        <Button type="button" variant="outline" className="h-11 w-fit" onClick={() => window.location.reload()}>
          Reintentar
        </Button>
      </Contenedor>
    );
  }

  const antroActual = sesion.antros.find((a) => a.id === clubId);
  const zona = nombreZona(info?.club.zona_horaria ?? null);

  return (
    <Contenedor>
      <Link
        href={volver ?? VOLVER[sesion.rol]}
        className="inline-flex min-h-10 w-fit items-center text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        ← Volver
      </Link>

      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Descargar reportes</h1>
        <p className="text-sm text-muted-foreground">
          Archivos CSV para Excel o Google Sheets{antroActual ? ` · ${antroActual.nombre}` : ""}
        </p>
      </div>

      {sesion.antros.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No hay antros que mostrar con tu cuenta.
        </p>
      ) : (
        <>
          {sesion.antros.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="exportar-antro">Antro</Label>
              <select
                id="exportar-antro"
                className={cn(SELECT_CLASSES, "h-11")}
                value={clubId ?? ""}
                disabled={ocupado}
                onChange={(e) => setClubId(e.target.value)}
              >
                {sesion.antros.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Periodo">
              {(
                [
                  ["noche", "Una noche"],
                  ["rango", "Varias noches"],
                ] as const
              ).map(([m, etiqueta]) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={modo === m}
                  disabled={ocupado}
                  onClick={() => {
                    setModo(m);
                    setDescargas(INACTIVOS);
                  }}
                  className={cn(
                    "h-10 rounded-md px-2 text-sm font-medium text-muted-foreground disabled:opacity-50",
                    modo === m && "bg-background text-foreground shadow-sm",
                  )}
                >
                  {etiqueta}
                </button>
              ))}
            </div>

            {modo === "noche" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="exportar-noche">Noche</Label>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="icon" className="size-11 shrink-0" aria-label="Noche anterior"
                    disabled={ocupado} onClick={() => { setNoche(sumarDiasISO(noche, -1)); setDescargas(INACTIVOS); }}>
                    <ChevronLeft className="size-4" aria-hidden="true" />
                  </Button>
                  <Input
                    id="exportar-noche"
                    type="date"
                    className="h-11 min-w-0 flex-1"
                    value={noche}
                    disabled={ocupado}
                    onChange={(e) => {
                      if (esFechaISO(e.target.value)) {
                        setNoche(e.target.value);
                        setDescargas(INACTIVOS);
                      }
                    }}
                  />
                  <Button type="button" variant="outline" size="icon" className="size-11 shrink-0" aria-label="Noche siguiente"
                    disabled={ocupado} onClick={() => { setNoche(sumarDiasISO(noche, 1)); setDescargas(INACTIVOS); }}>
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ) : (
              <SelectorRango
                atajo={atajo}
                rango={rango}
                deshabilitado={ocupado}
                onCambiar={(a, r) => {
                  setAtajo(a);
                  setRango(r);
                  setDescargas(INACTIVOS);
                }}
              />
            )}

            <p className="text-sm text-muted-foreground tabular-nums">
              {modo === "noche" ? `Noche del ${etiquetaNoche(noche)}` : etiquetaRango(rango)}
              {zona ? ` · ${zona}` : ""}
            </p>
            {invalido && (
              <p className="text-sm text-status-warn" role="alert">
                {invalido}
              </p>
            )}
          </div>

          {errorInfo ? (
            <Card size="sm">
              <CardContent className="flex flex-col gap-2 px-4">
                <p className="text-sm break-words text-destructive" role="alert">
                  {errorInfo}
                </p>
                <Button type="button" variant="outline" className="h-11 w-fit" onClick={() => setIntentoInfo((n) => n + 1)}>
                  Reintentar
                </Button>
              </CardContent>
            </Card>
          ) : !info ? (
            <p className="text-sm text-muted-foreground">Revisando tu acceso...</p>
          ) : (
            <div className="flex flex-col gap-3">
              {TARJETAS.map((tarjeta) => {
                const d = descargas[tarjeta.tipo];
                return (
                  <Card key={tarjeta.tipo} size="sm">
                    <CardContent className="flex flex-col gap-3 px-4">
                      <div className="flex min-w-0 flex-col gap-1">
                        <h2 className="text-base font-semibold">{tarjeta.titulo}</h2>
                        <p className="text-sm text-muted-foreground">{tarjeta.detalle(info)}</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 w-full sm:w-fit"
                        disabled={ocupado || !!invalido}
                        onClick={() => void descargar(tarjeta.tipo)}
                      >
                        <Download className="size-4" aria-hidden="true" />
                        {d.estado === "descargando" ? "Descargando..." : "Descargar CSV"}
                      </Button>
                      <div aria-live="polite" className="text-sm">
                        {d.estado === "descargando" && (
                          <p className="text-muted-foreground tabular-nums">
                            {d.renglones > 0 ? `${miles(d.renglones)} renglones hasta ahora...` : "Preparando..."}
                          </p>
                        )}
                        {d.estado === "listo" && (
                          <p className="break-words tabular-nums">
                            <span className="font-medium text-status-ok">Listo:</span> {miles(d.resumen.renglones)}{" "}
                            {d.resumen.renglones === 1 ? "renglón" : "renglones"} · {tarjeta.suma}{" "}
                            {formatearCentavos(d.resumen.suma_centavos)}
                            {d.resumen.anulados > 0 ? ` · ${miles(d.resumen.anulados)} anulado${d.resumen.anulados === 1 ? "" : "s"}` : ""}
                            <span className="block text-xs text-muted-foreground">{d.archivo}</span>
                          </p>
                        )}
                        {d.estado === "vacio" && <p className="text-muted-foreground">No hay renglones en ese periodo; no se descargó nada.</p>}
                        {d.estado === "error" && (
                          <p className="break-words text-destructive" role="alert">
                            {d.mensaje}
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
              <p className="text-xs text-muted-foreground">
                Horas en la zona del antro. Montos en pesos con dos decimales. La noche va de las 08:00 a las 07:59 del día
                siguiente. Con la noche abierta las comisiones salen parciales: nacen al cuadrar cada mesa.
                {info.telefono === "enmascarado" && " Como admin ves solo los últimos 4 dígitos del teléfono."}
                {info.telefono === "sin_telefono" && " Como dueño del grupo no ves teléfonos de clientes."}
              </p>
            </div>
          )}
        </>
      )}
    </Contenedor>
  );
}
