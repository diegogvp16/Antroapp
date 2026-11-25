"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Download, Printer, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { descargarArchivo } from "@/lib/descargar-archivo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SELECT_CLASSES } from "@/components/caja/accion";
import { ReporteCierreNoche } from "@/components/reportes/cierre-noche";
import { TemaReportesContenedor } from "@/components/tema-reportes";
import {
  esFechaISO,
  esUuid,
  generarCsvCierre,
  nombreArchivoCierre,
  normalizarReporte,
  type ReporteCierre,
} from "@/lib/domain/cierre-noche";
import { etiquetaNoche, nocheOperativaMexico, sumarDiasISO } from "@/lib/fechas";
import { cn } from "@/lib/utils";
import type { Profile } from "@/types";

type Rol = Profile["role"];
type RolPermitido = "dueno" | "gerente" | "admin";

const PANEL_DE: Partial<Record<Rol, string>> = {
  staff: "/staff/panel",
  rp: "/rp/panel",
  cliente: "/cliente",
};

function esPermitido(rol: Rol): rol is RolPermitido {
  return rol === "dueno" || rol === "gerente" || rol === "admin";
}

type Antro = { id: string; nombre: string };
type Sesion =
  | { estado: "cargando" }
  | { estado: "permitido"; rol: RolPermitido; antros: Antro[] }
  | { estado: "sin_acceso"; panel: string }
  | { estado: "error"; mensaje: string };

function Contenedor({ children }: { children: React.ReactNode }) {
  return (
    <TemaReportesContenedor className="reporte-imprimible flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10 print:p-0">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">{children}</div>
    </TemaReportesContenedor>
  );
}

function CierreNoche() {
  const router = useRouter();
  const params = useSearchParams();
  const desdeCaja = params.get("desde") === "caja";
  const clubParam = params.get("club");
  const fechaParam = params.get("fecha");

  const [sesion, setSesion] = useState<Sesion>({ estado: "cargando" });
  const [clubId, setClubId] = useState<string | null>(null);
  const [fecha, setFecha] = useState<string | null>(null);
  const [reporte, setReporte] = useState<ReporteCierre | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const ultima = useRef(0);

  // Sesión y antros que puede ver (los mismos de /grupo).
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
      const elegido = esUuid(clubParam) && antros.some((a) => a.id === clubParam) ? clubParam : (antros[0]?.id ?? null);
      setClubId(elegido);
    }
    void cargarSesion();
    // Solo al entrar: después el antro y la noche viven en el estado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // Noche por defecto: la de la URL o la noche en curso del antro (su zona).
  useEffect(() => {
    if (!clubId || fecha) return;
    if (esFechaISO(fechaParam)) {
      setFecha(fechaParam);
      return;
    }
    let vigente = true;
    void createClient()
      .rpc("club_fecha_operacion", { p_club_id: clubId })
      .then(({ data }) => {
        if (vigente) setFecha(typeof data === "string" && esFechaISO(data) ? data : nocheOperativaMexico());
      });
    return () => {
      vigente = false;
    };
  }, [clubId, fecha, fechaParam]);

  const consultar = useCallback(async (club: string, noche: string) => {
    const numero = ++ultima.current;
    setCargando(true);
    try {
      const { data, error: errorBase } = await createClient().rpc("reporte_cierre_noche", { p_club_id: club, p_fecha: noche });
      if (numero !== ultima.current) return;
      if (errorBase) {
        setReporte(null);
        setError(
          errorBase.code === "PGRST202"
            ? "El cierre de la noche todavía no está disponible."
            : mensajeParaUsuario(errorBase, "No pudimos cargar el cierre de la noche. Intenta de nuevo."),
        );
        return;
      }
      setReporte(normalizarReporte(data));
      setError(null);
    } catch (err) {
      console.error("Error cargando el cierre de la noche:", err);
      if (numero === ultima.current) setError("No se pudo cargar. Revisa tu conexión e intenta de nuevo.");
    } finally {
      if (numero === ultima.current) setCargando(false);
    }
  }, []);

  // Cargar y dejar el antro y la noche en la URL (para volver o compartir).
  useEffect(() => {
    if (!clubId || !fecha) return;
    void consultar(clubId, fecha);
    const q = new URLSearchParams({ club: clubId, fecha });
    if (desdeCaja) q.set("desde", "caja");
    router.replace(`/grupo/noche?${q.toString()}`, { scroll: false });
  }, [clubId, fecha, consultar, desdeCaja, router]);

  const volver = desdeCaja ? "/staff/caja" : "/grupo";

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
            <p className="text-sm">El cierre de la noche es para gerentes y dueños.</p>
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
  const cambiarNoche = (dias: number) => fecha && setFecha(sumarDiasISO(fecha, dias));

  return (
    <Contenedor>
      <Link
        href={volver}
        className="inline-flex min-h-10 w-fit items-center text-sm font-medium text-muted-foreground hover:text-foreground print:hidden"
      >
        ← Volver
      </Link>

      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Cierre de la noche</h1>
        <p className="text-sm text-muted-foreground">
          {antroActual?.nombre ?? reporte?.club.nombre ?? ""}
          {fecha ? ` · Noche del ${etiquetaNoche(fecha)}` : ""}
        </p>
      </div>

      {sesion.antros.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No hay antros que mostrar con tu cuenta.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3 print:hidden">
            {sesion.antros.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cierre-antro">Antro</Label>
                <select
                  id="cierre-antro"
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cierre-fecha">Noche</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="icon" className="size-11 shrink-0" aria-label="Noche anterior"
                  disabled={!fecha || cargando} onClick={() => cambiarNoche(-1)}>
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                <Input
                  id="cierre-fecha"
                  type="date"
                  className="h-11 min-w-0 flex-1"
                  value={fecha ?? ""}
                  onChange={(e) => {
                    if (esFechaISO(e.target.value)) setFecha(e.target.value);
                  }}
                />
                <Button type="button" variant="outline" size="icon" className="size-11 shrink-0" aria-label="Noche siguiente"
                  disabled={!fecha || cargando} onClick={() => cambiarNoche(1)}>
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Button type="button" variant="outline" className="h-11" disabled={!clubId || !fecha || cargando}
                onClick={() => clubId && fecha && consultar(clubId, fecha)}>
                <RefreshCw className={cn("size-4", cargando && "animate-spin")} aria-hidden="true" />
                {cargando ? "..." : "Actualizar"}
              </Button>
              <Button type="button" variant="outline" className="h-11" disabled={!reporte}
                onClick={() => reporte && descargarArchivo(generarCsvCierre(reporte), nombreArchivoCierre(reporte.club.nombre, reporte.fecha))}>
                <Download className="size-4" aria-hidden="true" />
                CSV
              </Button>
              <Button type="button" variant="outline" className="h-11" disabled={!reporte} onClick={() => window.print()}>
                <Printer className="size-4" aria-hidden="true" />
                Imprimir
              </Button>
            </div>
          </div>

          {error && (
            <Card size="sm" className="print:hidden">
              <CardContent className="flex flex-col gap-2 px-4">
                <p className="text-sm break-words text-destructive" role="alert">
                  {error}
                </p>
                <Button type="button" variant="outline" size="sm" className="w-fit"
                  onClick={() => clubId && fecha && consultar(clubId, fecha)}>
                  Reintentar
                </Button>
              </CardContent>
            </Card>
          )}

          {!reporte ? (
            !error && <p className="text-sm text-muted-foreground">Cargando el cierre...</p>
          ) : (
            <>
              {reporte.momento === "en_curso" && reporte.noche.estado === "sin_caja" && (
                <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-sm print:hidden">
                  <p>La noche en curso todavía no tiene caja abierta.</p>
                  <Button type="button" variant="outline" className="h-11 w-fit" onClick={() => cambiarNoche(-1)}>
                    Ver la noche anterior
                  </Button>
                </div>
              )}
              <div className={cn("transition-opacity", cargando && "opacity-60")} aria-busy={cargando}>
                <ReporteCierreNoche rep={reporte} />
              </div>
            </>
          )}
        </>
      )}
    </Contenedor>
  );
}

export default function CierreNochePage() {
  return (
    <Suspense
      fallback={
        <Contenedor>
          <p className="text-sm text-muted-foreground">Cargando...</p>
        </Contenedor>
      }
    >
      <CierreNoche />
    </Suspense>
  );
}
