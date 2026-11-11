"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  BUCKET_VERIFICACION,
  MOTIVO_RECHAZO_MAXIMO,
  SEGUNDOS_URL_FIRMADA,
  etiquetaDocumento,
  formatearFechaVerificacion,
  validarMotivoRechazo,
} from "@/lib/verificacion";
import type { Club, VerificacionDocumento } from "@/types";

type ClubPendiente = Pick<Club, "id" | "nombre" | "direccion" | "dueno_id">;

interface DocumentoConUrl extends VerificacionDocumento {
  url: string | null;
}

interface Pendiente {
  club: ClubPendiente;
  duenoNombre: string | null;
  documentos: DocumentoConUrl[];
  // Fecha del documento más reciente: la base no guarda cuándo se envió
  // a revisión, y el envío siempre es después del último documento.
  ultimoDocumento: string | null;
}

interface VerificacionesPendientesProps {
  // Avisa al panel para que recargue su lista de antros.
  onCambio: () => unknown;
}

export function VerificacionesPendientes({ onCambio }: VerificacionesPendientesProps) {
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [procesandoId, setProcesandoId] = useState<string | null>(null);
  const [rechazandoId, setRechazandoId] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [errorPorClub, setErrorPorClub] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErrorCarga(null);
    try {
      const supabase = createClient();
      const { data: clubs, error: clubsError } = await supabase
        .from("clubs")
        .select("id, nombre, direccion, dueno_id")
        .eq("estado_verificacion", "en_revision")
        .order("nombre", { ascending: true });
      if (clubsError) throw clubsError;

      const lista = (clubs ?? []) as ClubPendiente[];
      if (lista.length === 0) {
        setPendientes([]);
        return;
      }

      const clubIds = lista.map((c) => c.id);
      const duenoIds = lista
        .map((c) => c.dueno_id)
        .filter((id): id is string => id !== null);

      const [docsRes, duenosRes] = await Promise.all([
        supabase
          .from("verificacion_documentos")
          .select("id, club_id, tipo, storage_path, created_at")
          .in("club_id", clubIds)
          .order("created_at", { ascending: true }),
        duenoIds.length > 0
          ? supabase.from("profiles").select("id, nombre").in("id", duenoIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (docsRes.error) throw docsRes.error;
      if (duenosRes.error) throw duenosRes.error;

      // SAFETY: check constraint sobre `tipo` en la tabla.
      const docs = (docsRes.data ?? []) as VerificacionDocumento[];

      // URLs firmadas de pocos minutos, con la sesión del admin.
      const urlPorRuta: Record<string, string> = {};
      if (docs.length > 0) {
        const { data: firmadas, error: firmaError } = await supabase.storage
          .from(BUCKET_VERIFICACION)
          .createSignedUrls(
            docs.map((d) => d.storage_path),
            SEGUNDOS_URL_FIRMADA,
          );
        if (firmaError) throw firmaError;
        for (const f of firmadas ?? []) {
          if (f.path && f.signedUrl) urlPorRuta[f.path] = f.signedUrl;
        }
      }

      const nombrePorDueno = new Map(
        (duenosRes.data ?? []).map((p) => [p.id, p.nombre as string]),
      );

      setPendientes(
        lista.map((club) => {
          const documentos = docs
            .filter((d) => d.club_id === club.id)
            .map((d) => ({ ...d, url: urlPorRuta[d.storage_path] ?? null }));
          return {
            club,
            duenoNombre: club.dueno_id
              ? (nombrePorDueno.get(club.dueno_id) ?? null)
              : null,
            documentos,
            ultimoDocumento: documentos.at(-1)?.created_at ?? null,
          };
        }),
      );
    } catch (err) {
      console.error("Error cargando verificaciones pendientes:", err);
      setErrorCarga("No pudimos cargar las verificaciones. Recarga la página.");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  function limpiarErrorDe(clubId: string) {
    setErrorPorClub((prev) => {
      const resto = { ...prev };
      delete resto[clubId];
      return resto;
    });
  }

  async function terminar(mensaje: string) {
    setAviso(mensaje);
    await Promise.all([cargar(), onCambio()]);
  }

  async function handleAprobar(club: ClubPendiente) {
    limpiarErrorDe(club.id);
    setAviso(null);
    setProcesandoId(club.id);
    try {
      const supabase = createClient();
      // No toca suscripcion_activa: aprobar la verificación no publica el
      // antro si no tiene suscripción.
      const { error } = await supabase
        .from("clubs")
        .update({
          estado_verificacion: "verificado",
          verificado_en: new Date().toISOString(),
          motivo_rechazo: null,
        })
        .eq("id", club.id);
      if (error) throw error;
      await terminar(`${club.nombre} quedó verificado.`);
    } catch (err) {
      console.error("Error aprobando verificación:", err);
      setErrorPorClub((prev) => ({
        ...prev,
        [club.id]: "No pudimos aprobar este antro. Intenta de nuevo.",
      }));
    } finally {
      setProcesandoId(null);
    }
  }

  function abrirRechazo(clubId: string) {
    limpiarErrorDe(clubId);
    setAviso(null);
    setMotivo("");
    setRechazandoId(clubId);
  }

  async function handleRechazar(club: ClubPendiente) {
    const problema = validarMotivoRechazo(motivo);
    if (problema) {
      setErrorPorClub((prev) => ({ ...prev, [club.id]: problema }));
      return;
    }
    limpiarErrorDe(club.id);
    setProcesandoId(club.id);
    try {
      const res = await fetch("/api/admin/rechazar-verificacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ club_id: club.id, motivo: motivo.trim() }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const mensaje =
          json && typeof json === "object" && "error" in json && typeof json.error === "string"
            ? json.error
            : "No pudimos rechazar este antro. Intenta de nuevo.";
        throw new Error(mensaje);
      }
      setRechazandoId(null);
      setMotivo("");
      await terminar(`${club.nombre} quedó rechazado. El dueño verá el motivo.`);
    } catch (err) {
      console.error("Error rechazando verificación:", err);
      setErrorPorClub((prev) => ({
        ...prev,
        [club.id]:
          err instanceof Error
            ? err.message
            : "No pudimos rechazar este antro. Intenta de nuevo.",
      }));
    } finally {
      setProcesandoId(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Verificaciones pendientes</h2>
        {!cargando && pendientes.length > 0 && (
          <Badge variant="warn">
            {pendientes.length} en revisión
          </Badge>
        )}
      </div>

      {aviso && (
        <p className="text-sm text-status-ok" role="status">
          {aviso}
        </p>
      )}

      {cargando && <p className="text-sm text-muted-foreground">Cargando...</p>}

      {errorCarga && (
        <p className="text-sm text-destructive" role="alert">
          {errorCarga}
        </p>
      )}

      {!cargando && !errorCarga && pendientes.length === 0 && (
        <Card>
          <CardContent className="px-6 py-5 text-sm text-muted-foreground">
            No hay antros esperando revisión.
          </CardContent>
        </Card>
      )}

      {!cargando &&
        pendientes.map(({ club, duenoNombre, documentos, ultimoDocumento }) => {
          const ocupado = procesandoId === club.id;
          const rechazando = rechazandoId === club.id;
          const idMotivo = `motivo-${club.id}`;
          return (
            <Card key={club.id}>
              <CardContent className="flex flex-col gap-4 px-6 py-5 text-sm">
                <div className="flex flex-col gap-0.5">
                  <p className="text-base font-semibold">{club.nombre}</p>
                  <p className="text-muted-foreground">{club.direccion}</p>
                  <p className="text-muted-foreground">
                    Dueño: {duenoNombre ?? "sin dueño registrado"}
                  </p>
                  {ultimoDocumento && (
                    <p className="text-muted-foreground">
                      Documentos subidos el{" "}
                      {formatearFechaVerificacion(ultimoDocumento)}
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <p className="font-medium">Documentos</p>
                  {documentos.length === 0 ? (
                    <p className="text-status-warn">
                      No hay documentos subidos.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {documentos.map((doc) => (
                        <li
                          key={doc.id}
                          className="flex items-center justify-between gap-3"
                        >
                          <span className="min-w-0">
                            {etiquetaDocumento(doc.tipo)}
                          </span>
                          {doc.url ? (
                            <a
                              href={doc.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-shrink-0 font-medium underline underline-offset-4"
                            >
                              Ver
                            </a>
                          ) : (
                            <span className="flex-shrink-0 text-status-err">
                              No disponible
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Los enlaces caducan a los {SEGUNDOS_URL_FIRMADA / 60}{" "}
                    minutos; recarga la página para generar nuevos.
                  </p>
                </div>

                {errorPorClub[club.id] && (
                  <p className="text-destructive" role="alert">
                    {errorPorClub[club.id]}
                  </p>
                )}

                {rechazando ? (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={idMotivo}>Motivo del rechazo</Label>
                    <textarea
                      id={idMotivo}
                      value={motivo}
                      onChange={(e) => {
                        setMotivo(e.target.value);
                        limpiarErrorDe(club.id);
                      }}
                      maxLength={MOTIVO_RECHAZO_MAXIMO}
                      rows={3}
                      required
                      placeholder="Ej. La foto del comprobante no se lee."
                      className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      El dueño verá este texto. Sus documentos se borran y
                      tendrá que subir nuevos.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => handleRechazar(club)}
                        disabled={ocupado}
                      >
                        {ocupado ? "Rechazando..." : "Confirmar rechazo"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setRechazandoId(null)}
                        disabled={ocupado}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() => handleAprobar(club)}
                      disabled={ocupado || procesandoId !== null}
                    >
                      {ocupado ? "Aprobando..." : "Aprobar"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => abrirRechazo(club.id)}
                      disabled={procesandoId !== null}
                    >
                      Rechazar
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
    </section>
  );
}
