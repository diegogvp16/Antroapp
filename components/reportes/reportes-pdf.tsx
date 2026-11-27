"use client";

// Pantalla de los reportes PDF del dueño (/grupo/reportes): elegir antro,
// noche o semana, ver las cifras clave y descargar el PDF. Detrás de la
// bandera por antro 'reportes_pdf' (lib/funciones.ts); la base también la
// revisa (sql/post-junta-3/70-reportes-pdf.sql). Ninguna cifra se calcula
// aquí: todo viene de reporte_pdf_noche / reporte_pdf_semana.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, FileDown, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { leerFunciones } from "@/lib/funciones";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SELECT_CLASSES } from "@/components/caja/accion";
import { TemaReportesContenedor } from "@/components/tema-reportes";
import { esFechaISO, esParcial, esUuid } from "@/lib/domain/cierre-noche";
import {
  DEF_TICKET,
  DEF_TICKET_SEMANA,
  entregarPdf,
  mensajeEntrega,
  entero,
  fechaCorta,
  fechaLarga,
  nocheConDatos,
  nombreArchivoPdf,
  normalizarNochePdf,
  normalizarSemanaPdf,
  pdfReporteNoche,
  pdfReporteSemana,
  pesos,
  rangoSemana,
  semanaConDatos,
  type ReporteNochePdf,
  type ReporteSemanaPdf,
} from "@/lib/domain/reporte-pdf";
import { diaSemanaISO, nocheOperativaMexico, sumarDiasISO } from "@/lib/fechas";
import { cn } from "@/lib/utils";
import type { Profile } from "@/types";

type Rol = Profile["role"];
type RolPermitido = "dueno" | "gerente" | "admin";
type Tipo = "noche" | "semana";

const VOLVER: Record<RolPermitido, string> = { dueno: "/dueno/panel", gerente: "/staff/panel", admin: "/admin" };
const PANEL_DE: Partial<Record<Rol, string>> = { staff: "/staff/panel", rp: "/rp/panel", cliente: "/cliente" };
const esPermitido = (rol: Rol): rol is RolPermitido => rol === "dueno" || rol === "gerente" || rol === "admin";

type Antro = { id: string; nombre: string };
type Sesion =
  | { estado: "cargando" }
  | { estado: "permitido"; rol: RolPermitido; antros: Antro[] }
  | { estado: "sin_acceso"; panel: string }
  | { estado: "error"; mensaje: string };

type Reporte = { tipo: "noche"; datos: ReporteNochePdf } | { tipo: "semana"; datos: ReporteSemanaPdf };

/** Lunes (semana de lunes a domingo) de una fecha de calendario. */
const lunesDe = (fecha: string) => {
  const d = diaSemanaISO(fecha);
  return sumarDiasISO(fecha, d === 0 ? -6 : 1 - d);
};

function Contenedor({ children }: { children: React.ReactNode }) {
  return (
    <TemaReportesContenedor className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">{children}</div>
    </TemaReportesContenedor>
  );
}

function Cifra({ etiqueta, valor, detalle }: { etiqueta: string; valor: string; detalle?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{etiqueta}</span>
      <span className="text-lg font-semibold break-words tabular-nums">{valor}</span>
      {detalle && <span className="text-xs break-words text-muted-foreground tabular-nums">{detalle}</span>}
    </div>
  );
}

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-sm" role="status">
      {children}
    </p>
  );
}

function VistaNoche({ rep }: { rep: ReporteNochePdf }) {
  const con = nocheConDatos(rep);
  return (
    <div className="flex flex-col gap-3">
      {rep.momento === "futura" ? (
        <Aviso>Esta noche todavía no empieza: solo se ven las reservas apartadas hasta ahora.</Aviso>
      ) : esParcial(rep) ? (
        <Aviso>Noche en curso: las cifras son parciales y pueden cambiar.</Aviso>
      ) : rep.noche.estado === "abierta" ? (
        <Aviso>La caja de esta noche sigue abierta aunque ya pasó su corte.</Aviso>
      ) : null}
      {!con ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Sin movimientos: esta noche no tiene reservas, consumo, cobros ni comisiones. El PDF lo dirá igual.
        </p>
      ) : (
        <Card size="sm">
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 sm:grid-cols-3">
            <Cifra etiqueta="Consumo total" valor={pesos(rep.consumo.total_centavos)} />
            <Cifra etiqueta="Ticket promedio" valor={pesos(rep.consumo.ticket_promedio_centavos)}
              detalle={`${entero(rep.consumo.cuentas_con_consumo)} cuentas con consumo`} />
            <Cifra etiqueta="Cuentas" valor={entero(rep.walk_ins.cuentas_total)}
              detalle={`Mesas usadas ${entero(rep.mesas.mesas_usadas)} de ${entero(rep.mesas.mesas_antro)}`} />
            <Cifra etiqueta="Cobrado" valor={pesos(rep.cobros.total_centavos)}
              detalle={`Efectivo ${pesos(rep.cobros.efectivo_centavos)} · tarjeta ${pesos(rep.cobros.tarjeta_centavos)} · otro ${pesos(rep.cobros.otro_centavos)}`} />
            <Cifra etiqueta="Comisiones" valor={pesos(rep.comisiones.total_centavos)} detalle={`${entero(rep.rps.length)} RPs con movimiento`} />
            <Cifra etiqueta="Reservas" valor={entero(rep.reservas.reservas)}
              detalle={`${entero(rep.reservas.personas)} personas · llegaron ${entero(rep.reservas.entraron)}`} />
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">{DEF_TICKET}</p>
    </div>
  );
}

function VistaSemana({ rep }: { rep: ReporteSemanaPdf }) {
  const t = rep.totales;
  return (
    <div className="flex flex-col gap-3">
      {rep.parcial && (
        <Aviso>
          Semana en curso: {t.noches_sin_terminar === 1 ? "1 noche no ha terminado" : `${t.noches_sin_terminar} noches no han terminado`}. Las
          cifras son parciales.
        </Aviso>
      )}
      {!semanaConDatos(rep) ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Sin movimientos: esta semana no tiene reservas, consumo, cobros ni comisiones. El PDF lo dirá igual.
        </p>
      ) : (
        <>
          <Card size="sm">
            <CardContent className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 sm:grid-cols-3">
              <Cifra etiqueta="Consumo total" valor={pesos(t.consumo_centavos)} detalle={`${entero(t.noches_con_consumo)} noches con consumo`} />
              <Cifra etiqueta="Ticket promedio" valor={pesos(t.ticket_promedio_centavos)} detalle={`${entero(t.cuentas_con_consumo)} cuentas con consumo`} />
              <Cifra etiqueta="Cuentas" valor={entero(t.cuentas)} detalle={`${entero(t.grupos)} grupos de mesa`} />
              <Cifra etiqueta="Cobrado" valor={pesos(t.cobrado_centavos)}
                detalle={`Efectivo ${pesos(t.efectivo_centavos)} · tarjeta ${pesos(t.tarjeta_centavos)} · otro ${pesos(t.otro_centavos)}`} />
              <Cifra etiqueta="Comisiones" valor={pesos(t.comisiones_centavos)} detalle={`${entero(rep.rps.length)} RPs con movimiento`} />
              <Cifra etiqueta="Reservas" valor={entero(t.reservas)} detalle={`${entero(t.personas)} personas · llegaron ${entero(t.entraron)}`} />
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader className="px-4">
              <CardTitle>Noche por noche</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <ul className="flex flex-col divide-y divide-border text-sm">
                {rep.noches.map((n) => (
                  <li key={n.fecha} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span className="min-w-0">
                      {fechaCorta(n.fecha)}
                      {!n.termino && <span className="ml-1 text-xs text-muted-foreground">{n.momento === "futura" ? "· por venir" : "· en curso"}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums">{pesos(n.consumo_centavos)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {DEF_TICKET} {DEF_TICKET_SEMANA}
      </p>
    </div>
  );
}

export function ReportesPdf() {
  const router = useRouter();
  const params = useSearchParams();
  const clubParam = params.get("club");
  const tipoParam = params.get("tipo");
  const fechaParam = params.get("fecha");

  const [sesion, setSesion] = useState<Sesion>({ estado: "cargando" });
  const [clubId, setClubId] = useState<string | null>(null);
  const [tipo, setTipo] = useState<Tipo>(tipoParam === "semana" ? "semana" : "noche");
  const [fecha, setFecha] = useState<string | null>(null);
  const [reporte, setReporte] = useState<Reporte | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const ultima = useRef(0);

  // Sesión y antros con la bandera encendida (de los que ve en /grupo).
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
      const todos = ((Array.isArray(data) ? data : []) as { club_id: string; nombre: string }[]).map((a) => ({ id: a.club_id, nombre: a.nombre }));
      const banderas = await Promise.all(todos.map((a) => leerFunciones(a.id)));
      const antros = todos.filter((_, i) => banderas[i].has("reportes_pdf"));
      setSesion({ estado: "permitido", rol, antros });
      setClubId(esUuid(clubParam) && antros.some((a) => a.id === clubParam) ? clubParam : (antros[0]?.id ?? null));
    }
    void cargarSesion();
    // Solo al entrar: después el antro, el tipo y la fecha viven en el estado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Fecha por defecto: la de la URL o, en la zona del antro, la última noche
  // completa (la anterior a la noche en curso) y la semana en curso.
  useEffect(() => {
    if (!clubId || fecha) return;
    if (esFechaISO(fechaParam)) {
      setFecha(tipo === "semana" ? lunesDe(fechaParam) : fechaParam);
      return;
    }
    let vigente = true;
    void createClient()
      .rpc("club_fecha_operacion", { p_club_id: clubId })
      .then(({ data }) => {
        if (!vigente) return;
        const enCurso = typeof data === "string" && esFechaISO(data) ? data : nocheOperativaMexico();
        setFecha(tipo === "semana" ? lunesDe(enCurso) : sumarDiasISO(enCurso, -1));
      });
    return () => {
      vigente = false;
    };
  }, [clubId, fecha, fechaParam, tipo]);

  const consultar = useCallback(async (club: string, t: Tipo, f: string) => {
    const numero = ++ultima.current;
    setCargando(true);
    setAviso(null);
    try {
      const supabase = createClient();
      const { data, error: errorBase } =
        t === "noche"
          ? await supabase.rpc("reporte_pdf_noche", { p_club_id: club, p_fecha: f })
          : await supabase.rpc("reporte_pdf_semana", { p_club_id: club, p_lunes: f });
      if (numero !== ultima.current) return;
      if (errorBase) {
        setReporte(null);
        setError(
          errorBase.code === "PGRST202"
            ? "Los reportes PDF todavía no están disponibles."
            : mensajeParaUsuario(errorBase, "No pudimos cargar el reporte. Intenta de nuevo."),
        );
        return;
      }
      setReporte(t === "noche" ? { tipo: "noche", datos: normalizarNochePdf(data) } : { tipo: "semana", datos: normalizarSemanaPdf(data) });
      setError(null);
    } catch (err) {
      console.error("Error cargando el reporte PDF:", err);
      if (numero === ultima.current) setError("No se pudo cargar. Revisa tu conexión e intenta de nuevo.");
    } finally {
      if (numero === ultima.current) setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (!clubId || !fecha) return;
    void consultar(clubId, tipo, fecha);
    router.replace(`/grupo/reportes?${new URLSearchParams({ club: clubId, tipo, fecha }).toString()}`, { scroll: false });
  }, [clubId, tipo, fecha, consultar, router]);

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
            <p className="text-sm">Los reportes PDF son para dueños y gerentes.</p>
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
        <Button type="button" variant="outline" className="w-fit" onClick={() => window.location.reload()}>
          Reintentar
        </Button>
      </Contenedor>
    );
  }

  const antroActual = sesion.antros.find((a) => a.id === clubId);
  // Lo que se ve y se descarga es SIEMPRE el reporte del antro, tipo y fecha
  // elegidos: mientras llega otro, el botón espera.
  const vigente =
    !!reporte &&
    reporte.datos.club.id === clubId &&
    reporte.tipo === tipo &&
    (reporte.tipo === "noche" ? reporte.datos.fecha === fecha : reporte.datos.lunes === fecha);
  const puedeDescargar = vigente && !cargando;

  const mover = (pasos: number) => fecha && setFecha(sumarDiasISO(fecha, pasos * (tipo === "semana" ? 7 : 1)));
  const cambiarTipo = (t: Tipo) => {
    if (t === tipo) return;
    setTipo(t);
    setReporte(null);
    if (fecha && t === "semana") setFecha(lunesDe(fecha));
  };

  // Se genera y se entrega dentro del mismo clic (compartir en iOS lo exige).
  async function descargar() {
    if (!reporte || !puedeDescargar) return;
    try {
      const { bytes, nombre, titulo } =
        reporte.tipo === "noche"
          ? {
              bytes: pdfReporteNoche(reporte.datos),
              nombre: nombreArchivoPdf("noche", reporte.datos.club.nombre, reporte.datos.fecha),
              titulo: `Reporte de la noche · ${reporte.datos.club.nombre}`,
            }
          : {
              bytes: pdfReporteSemana(reporte.datos),
              nombre: nombreArchivoPdf("semana", reporte.datos.club.nombre, reporte.datos.lunes),
              titulo: `Reporte de la semana · ${reporte.datos.club.nombre}`,
            };
      setAviso(mensajeEntrega(await entregarPdf(bytes, nombre, titulo)));
    } catch (err) {
      console.error("Error generando el PDF:", err);
      setAviso("No se pudo generar el PDF. Intenta de nuevo.");
    }
  }

  const periodo = fecha ? (tipo === "noche" ? `Noche del ${fechaLarga(fecha)}` : `Semana ${rangoSemana(fecha, sumarDiasISO(fecha, 6))}`) : "";

  return (
    <Contenedor>
      <Link href={VOLVER[sesion.rol]} className="inline-flex min-h-10 w-fit items-center text-sm font-medium text-muted-foreground hover:text-foreground">
        ← Volver
      </Link>

      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Reportes PDF</h1>
        <p className="text-sm break-words text-muted-foreground">
          {antroActual?.nombre ?? ""}
          {periodo ? ` · ${periodo}` : ""}
        </p>
      </div>

      {sesion.antros.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Los reportes PDF no están activos para tus antros.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {sesion.antros.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pdf-antro">Antro</Label>
                <select
                  id="pdf-antro"
                  className={cn(SELECT_CLASSES, "h-11")}
                  value={clubId ?? ""}
                  onChange={(e) => {
                    setReporte(null);
                    setFecha(null);
                    setClubId(e.target.value);
                  }}
                >
                  {sesion.antros.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nombre}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Tipo de reporte">
              {(["noche", "semana"] as const).map((t) => (
                <Button key={t} type="button" variant={tipo === t ? "default" : "outline"} className="h-11" aria-pressed={tipo === t}
                  onClick={() => cambiarTipo(t)}>
                  {t === "noche" ? "Reporte de la noche" : "Reporte de la semana"}
                </Button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pdf-fecha">{tipo === "noche" ? "Noche" : "Semana (lunes a domingo)"}</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="icon" className="size-11 shrink-0"
                  aria-label={tipo === "noche" ? "Noche anterior" : "Semana anterior"} disabled={!fecha || cargando} onClick={() => mover(-1)}>
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                <Input
                  id="pdf-fecha"
                  type="date"
                  className="h-11 min-w-0 flex-1"
                  value={fecha ?? ""}
                  onChange={(e) => {
                    if (esFechaISO(e.target.value)) setFecha(tipo === "semana" ? lunesDe(e.target.value) : e.target.value);
                  }}
                />
                <Button type="button" variant="outline" size="icon" className="size-11 shrink-0"
                  aria-label={tipo === "noche" ? "Noche siguiente" : "Semana siguiente"} disabled={!fecha || cargando} onClick={() => mover(1)}>
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
              {tipo === "semana" && fecha && (
                <p className="text-xs text-muted-foreground">
                  Del {fechaCorta(fecha)} al {fechaCorta(sumarDiasISO(fecha, 6))}
                </p>
              )}
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-2">
              <Button type="button" variant="outline" className="h-11" disabled={!clubId || !fecha || cargando}
                onClick={() => clubId && fecha && consultar(clubId, tipo, fecha)}>
                <RefreshCw className={cn("size-4", cargando && "animate-spin")} aria-hidden="true" />
                {cargando ? "..." : "Actualizar"}
              </Button>
              <Button type="button" className="h-11" disabled={!puedeDescargar} onClick={() => void descargar()}>
                <FileDown className="size-4" aria-hidden="true" />
                Descargar PDF
              </Button>
            </div>
            {aviso && (
              <p className="text-sm text-muted-foreground" role="status">
                {aviso}
              </p>
            )}
          </div>

          {error && (
            <Card size="sm">
              <CardContent className="flex flex-col gap-2 px-4">
                <p className="text-sm break-words text-destructive" role="alert">
                  {error}
                </p>
                <Button type="button" variant="outline" size="sm" className="w-fit"
                  onClick={() => clubId && fecha && consultar(clubId, tipo, fecha)}>
                  Reintentar
                </Button>
              </CardContent>
            </Card>
          )}

          {!reporte ? (
            !error && <p className="text-sm text-muted-foreground">Cargando el reporte...</p>
          ) : (
            <div className={cn("transition-opacity", (cargando || !vigente) && "opacity-60")} aria-busy={cargando}>
              {reporte.tipo === "noche" ? <VistaNoche rep={reporte.datos} /> : <VistaSemana rep={reporte.datos} />}
            </div>
          )}
        </>
      )}
    </Contenedor>
  );
}
