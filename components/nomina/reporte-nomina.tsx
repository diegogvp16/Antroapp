"use client";

import { mensajeParaUsuario } from "@/lib/errores-base";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FilaMonto } from "@/components/caja/accion";
import { TarjetaRpNomina } from "@/components/nomina/tarjeta-rp-nomina";
import { formatearCentavos } from "@/lib/domain/caja";
import { nocheOperativaMexico } from "@/lib/fechas";
import {
  ANIO_MIN,
  compararSemanas,
  ESTADO_NOMINA_BADGE,
  ESTADO_NOMINA_LABEL,
  ESTADOS_NOMINA,
  etiquetaSemana,
  generarCsvNomina,
  nombreArchivoNomina,
  nombreRp,
  semanaAnterior,
  semanaIsoDe,
  semanaSiguiente,
  tieneMovimiento,
  totalesSemana,
  type FilaNomina,
  type SemanaIso,
} from "@/lib/domain/nomina";

// Descarga un texto como archivo en el navegador.
function descargar(contenido: string, nombreArchivo: string) {
  const blob = new Blob([contenido], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Nómina semanal de un antro (gerente y dueño). Todo lo calcula la base:
// nomina_semana devuelve una fila por RP con montos en centavos por estado.
export function ReporteNomina({ clubId, clubNombre }: { clubId: string; clubNombre: string }) {
  // La semana actual se fija al montar (la de la noche operativa en curso).
  const [actual] = useState<SemanaIso>(() => semanaIsoDe(nocheOperativaMexico()));
  const [semana, setSemana] = useState<SemanaIso>(actual);
  const [filas, setFilas] = useState<FilaNomina[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [verSinMovimiento, setVerSinMovimiento] = useState(false);
  // Solo cuenta la respuesta de la última carga (cambios rápidos de semana).
  const ultimaCarga = useRef(0);

  const cargar = useCallback(async () => {
    const numero = ++ultimaCarga.current;
    setCargando(true);
    try {
      const { data, error: errorBase } = await createClient().rpc("nomina_semana", {
        p_club_id: clubId,
        p_anio: semana.anio,
        p_semana: semana.semana,
      });
      if (numero !== ultimaCarga.current) return;
      if (errorBase) {
        setError(mensajeParaUsuario(errorBase, "No pudimos cargar la nómina. Intenta de nuevo."));
        setFilas(null);
        return;
      }
      setError(null);
      setFilas((data ?? []) as FilaNomina[]);
    } catch (err) {
      console.error("Error cargando la nómina:", err);
      if (numero !== ultimaCarga.current) return;
      setError("No se pudo cargar la nómina. Revisa tu conexión e intenta de nuevo.");
      setFilas(null);
    } finally {
      if (numero === ultimaCarga.current) setCargando(false);
    }
  }, [clubId, semana]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const totales = useMemo(() => (filas ? totalesSemana(filas) : null), [filas]);

  const { conMovimiento, sinMovimiento } = useMemo(() => {
    const texto = busqueda.trim().toLocaleLowerCase("es-MX");
    const visibles = (filas ?? []).filter(
      (f) => !texto || nombreRp(f).toLocaleLowerCase("es-MX").includes(texto),
    );
    return {
      conMovimiento: visibles.filter(tieneMovimiento),
      sinMovimiento: visibles.filter((f) => !tieneMovimiento(f)),
    };
  }, [filas, busqueda]);

  const esActual = compararSemanas(semana, actual) === 0;
  const hayAnterior = !(semana.anio <= ANIO_MIN && semana.semana <= 1);
  const haySiguiente = compararSemanas(semana, actual) < 0;

  function cambiarSemana(nueva: SemanaIso) {
    setSemana(nueva);
    setFilas(null);
    setError(null);
    setVerSinMovimiento(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        La nómina la paga el antro; AntroApp solo la calcula. Cuenta por la noche de cada
        reserva (lunes a domingo).
      </p>

      {/* Selector de semana */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Semana anterior"
          disabled={!hayAnterior}
          onClick={() => cambiarSemana(semanaAnterior(semana))}
        >
          ‹
        </Button>
        <div className="flex min-w-0 flex-1 flex-col items-center text-center">
          <span className="text-sm font-medium break-words">{etiquetaSemana(semana)}</span>
          {esActual ? (
            <span className="text-xs text-muted-foreground">Semana en curso</span>
          ) : (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => cambiarSemana(actual)}
            >
              Ir a la semana en curso
            </button>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Semana siguiente"
          disabled={!haySiguiente}
          onClick={() => cambiarSemana(semanaSiguiente(semana))}
        >
          ›
        </Button>
      </div>

      {error && (
        <Card size="sm">
          <CardContent className="flex flex-col gap-2 px-4">
            <p className="text-sm break-words text-destructive" role="alert">
              {error}
            </p>
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={cargar}>
              Reintentar
            </Button>
          </CardContent>
        </Card>
      )}

      {!filas || !totales ? (
        !error && <p className="text-sm text-muted-foreground">Cargando la nómina...</p>
      ) : (
        <>
          {/* Totales de la semana */}
          <Card>
            <CardHeader>
              <CardTitle>Totales de la semana</CardTitle>
              <CardDescription>
                {totales.reservasEntraron} reservas entraron · {totales.comisiones} comisiones ·{" "}
                {totales.dias} días
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {ESTADOS_NOMINA.map((e) => (
                  <div
                    key={e}
                    className="flex min-w-0 flex-col gap-1 rounded-lg border border-border px-3 py-2"
                  >
                    <Badge variant={ESTADO_NOMINA_BADGE[e]}>{ESTADO_NOMINA_LABEL[e]}</Badge>
                    <span className="font-semibold tabular-nums">
                      {formatearCentavos(totales.porEstado[e])}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1">
                <FilaMonto etiqueta="Comisiones" valor={formatearCentavos(totales.comision)} />
                <FilaMonto etiqueta="Pago por día" valor={formatearCentavos(totales.dia)} />
                <FilaMonto
                  etiqueta="Total (sin anuladas)"
                  valor={formatearCentavos(totales.total)}
                  fuerte
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={filas.length === 0}
                  onClick={() =>
                    descargar(generarCsvNomina(filas), nombreArchivoNomina(clubNombre, semana))
                  }
                >
                  Exportar CSV
                </Button>
                <Button type="button" variant="ghost" disabled={cargando} onClick={cargar}>
                  {cargando ? "Actualizando..." : "Actualizar"}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* RPs */}
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold">RPs</h2>
              {filas.length > 0 && (
                <Input
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder="Buscar RP"
                  aria-label="Buscar RP"
                  className="sm:max-w-56"
                />
              )}
            </div>

            {filas.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                Este antro no tiene RPs ni movimientos esa semana.
              </p>
            ) : (
              <>
                {conMovimiento.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    {busqueda.trim()
                      ? "Ningún RP con movimientos coincide con la búsqueda."
                      : "Ningún RP tuvo movimientos esta semana."}
                  </p>
                ) : (
                  conMovimiento.map((f) => (
                    <TarjetaRpNomina
                      key={f.rp_id}
                      fila={f}
                      clubId={clubId}
                      semana={semana}
                      onCambio={cargar}
                    />
                  ))
                )}

                {sinMovimiento.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      className="w-fit text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      onClick={() => setVerSinMovimiento((v) => !v)}
                      aria-expanded={verSinMovimiento}
                    >
                      {verSinMovimiento ? "Ocultar" : "Ver"} {sinMovimiento.length}{" "}
                      {sinMovimiento.length === 1 ? "RP" : "RPs"} sin movimientos
                    </button>
                    {verSinMovimiento && (
                      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                        {sinMovimiento.map((f) => (
                          <li
                            key={f.rp_id}
                            className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                          >
                            <span className="min-w-0 break-words">{nombreRp(f)}</span>
                            {!f.rp_activo && <Badge variant="neutral">Inactivo</Badge>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
