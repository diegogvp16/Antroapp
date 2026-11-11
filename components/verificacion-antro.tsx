"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  BUCKET_VERIFICACION,
  DOCUMENTOS,
  TIPOS_ARCHIVO_ACEPTADOS,
  etiquetaDocumento,
  faltanRequeridos,
  formatearFechaVerificacion,
  puedeEditarDocumentos,
  rutaDocumento,
  validarArchivo,
  type TipoDocumento,
} from "@/lib/verificacion";
import type { Club, VerificacionDocumento } from "@/types";

interface VerificacionAntroProps {
  club: Club;
  // Recarga el club en el panel para que el cambio de estado se refleje.
  onCambioEstado: () => unknown;
}

export function VerificacionAntro({ club, onCambioEstado }: VerificacionAntroProps) {
  const estado = club.estado_verificacion;

  const [documentos, setDocumentos] = useState<VerificacionDocumento[]>([]);
  const [cargandoDocs, setCargandoDocs] = useState(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState<TipoDocumento | null>(null);
  const [errorPorTipo, setErrorPorTipo] = useState<
    Partial<Record<TipoDocumento, string>>
  >({});
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    async function cargar() {
      setCargandoDocs(true);
      setErrorCarga(null);
      const supabase = createClient();
      const { data, error } = await supabase
        .from("verificacion_documentos")
        .select("id, club_id, tipo, storage_path, created_at")
        .eq("club_id", club.id)
        .order("created_at", { ascending: true });

      if (cancelado) return;
      if (error) {
        console.error("Error cargando documentos de verificación:", error);
        setErrorCarga("No pudimos cargar tus documentos. Recarga la página.");
      } else {
        // SAFETY: la tabla tiene check constraint sobre `tipo`, así que el
        // valor siempre es uno de TIPOS_DOCUMENTO.
        setDocumentos((data ?? []) as VerificacionDocumento[]);
      }
      setCargandoDocs(false);
    }

    cargar();
    return () => {
      cancelado = true;
    };
  }, [club.id, estado]);

  const tiposSubidos = new Set(documentos.map((d) => d.tipo));
  const faltantes = faltanRequeridos(tiposSubidos);

  async function handleArchivo(tipo: TipoDocumento, e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const archivo = input.files?.[0];
    if (!archivo) return;

    setErrorPorTipo((prev) => ({ ...prev, [tipo]: undefined }));
    const problema = validarArchivo(archivo);
    if (problema) {
      setErrorPorTipo((prev) => ({ ...prev, [tipo]: problema }));
      input.value = "";
      return;
    }

    setSubiendo(tipo);
    const supabase = createClient();
    const ruta = rutaDocumento(club.id, tipo, archivo);
    try {
      const { error: uploadError } = await supabase.storage
        .from(BUCKET_VERIFICACION)
        .upload(ruta, archivo, { contentType: archivo.type, upsert: false });
      if (uploadError) throw uploadError;

      const { data: fila, error: insertError } = await supabase
        .from("verificacion_documentos")
        .insert({ club_id: club.id, tipo, storage_path: ruta })
        .select("id, club_id, tipo, storage_path, created_at")
        .single();

      if (insertError) {
        // El archivo ya subió pero no quedó registrado: se borra para no
        // dejar basura huérfana en el bucket.
        await supabase.storage.from(BUCKET_VERIFICACION).remove([ruta]);
        throw insertError;
      }

      // SAFETY: mismo check constraint sobre `tipo` que en la carga inicial.
      setDocumentos((prev) => [...prev, fila as VerificacionDocumento]);
    } catch (err) {
      console.error("Error subiendo documento de verificación:", err);
      setErrorPorTipo((prev) => ({
        ...prev,
        [tipo]: "No pudimos subir el archivo. Intenta de nuevo.",
      }));
    } finally {
      setSubiendo(null);
      input.value = "";
    }
  }

  async function handleEnviar() {
    setErrorEnvio(null);
    if (faltantes.length > 0) {
      setErrorEnvio("Sube los documentos requeridos antes de enviar.");
      return;
    }
    setEnviando(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from("clubs")
        .update({ estado_verificacion: "en_revision" })
        .eq("id", club.id);
      if (error) throw error;
      await onCambioEstado();
    } catch (err) {
      console.error("Error enviando a revisión:", err);
      setErrorEnvio("No pudimos enviar tu antro a revisión. Intenta de nuevo.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Verificación de tu antro</h2>
        {estado === "verificado" && <Badge variant="ok">Antro verificado</Badge>}
        {estado === "en_revision" && <Badge variant="warn">En revisión</Badge>}
        {estado === "rechazado" && <Badge variant="err">Rechazado</Badge>}
        {estado === "borrador" && <Badge variant="neutral">Pendiente</Badge>}
      </div>

      {estado === "verificado" && (
        <Card>
          <CardContent className="px-6 py-5 text-sm">
            <p className="font-medium">Tu antro está verificado.</p>
            {club.verificado_en && (
              <p className="text-muted-foreground">
                Aprobado el {formatearFechaVerificacion(club.verificado_en)}.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {estado === "en_revision" && (
        <Card>
          <CardContent className="flex flex-col gap-3 px-6 py-5 text-sm">
            <p className="font-medium">
              Tu antro está en revisión. Te avisaremos cuando sea aprobado.
            </p>
            <ListaDocumentos documentos={documentos} cargando={cargandoDocs} />
          </CardContent>
        </Card>
      )}

      {puedeEditarDocumentos(estado) && (
        <Card>
          <CardContent className="flex flex-col gap-5 px-6 py-6">
            {estado === "rechazado" && (
              <div
                role="alert"
                className="rounded-md border border-status-err/30 bg-status-err/8 px-4 py-3 text-sm text-status-err"
              >
                <p className="font-semibold">Tu verificación fue rechazada.</p>
                {club.motivo_rechazo && <p>Motivo: {club.motivo_rechazo}</p>}
                <p>Vuelve a subir los documentos corregidos.</p>
              </div>
            )}

            {estado === "borrador" && (
              <p className="text-sm text-muted-foreground">
                Para publicar tu antro necesitamos confirmar que es real. Sube
                los documentos y envíalos a revisión.
              </p>
            )}

            {errorCarga && (
              <p className="text-sm text-destructive" role="alert">
                {errorCarga}
              </p>
            )}

            {DOCUMENTOS.map((doc) => {
              const subido = tiposSubidos.has(doc.tipo);
              const id = `verif-${doc.tipo}`;
              return (
                <div key={doc.tipo} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor={id}>
                      {doc.etiqueta}
                      {!doc.requerido && (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          (opcional)
                        </span>
                      )}
                    </Label>
                    {subido && <Badge variant="ok">Subido</Badge>}
                  </div>
                  <input
                    id={id}
                    type="file"
                    accept={TIPOS_ARCHIVO_ACEPTADOS}
                    disabled={subiendo !== null || cargandoDocs}
                    onChange={(e) => handleArchivo(doc.tipo, e)}
                    className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium disabled:opacity-50"
                  />
                  {subiendo === doc.tipo && (
                    <p className="text-xs text-muted-foreground">Subiendo...</p>
                  )}
                  {errorPorTipo[doc.tipo] && (
                    <p className="text-xs text-destructive" role="alert">
                      {errorPorTipo[doc.tipo]}
                    </p>
                  )}
                </div>
              );
            })}

            <p className="text-xs text-muted-foreground">
              Imagen o PDF, máximo 10 MB. Los documentos son privados: solo
              los ve el equipo de AntroApp.
            </p>

            {errorEnvio && (
              <p className="text-sm text-destructive" role="alert">
                {errorEnvio}
              </p>
            )}

            <Button
              type="button"
              onClick={handleEnviar}
              disabled={faltantes.length > 0 || enviando || subiendo !== null}
            >
              {enviando ? "Enviando..." : "Enviar a revisión"}
            </Button>
            {faltantes.length > 0 && !cargandoDocs && (
              <p className="text-xs text-muted-foreground">
                Falta: {faltantes.map(etiquetaDocumento).join(" y ")}.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function ListaDocumentos({
  documentos,
  cargando,
}: {
  documentos: VerificacionDocumento[];
  cargando: boolean;
}) {
  if (cargando) {
    return <p className="text-muted-foreground">Cargando documentos...</p>;
  }
  if (documentos.length === 0) return null;

  const tipos = Array.from(new Set(documentos.map((d) => d.tipo)));
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground">Documentos enviados:</p>
      <ul className="flex flex-col gap-0.5">
        {tipos.map((tipo) => (
          <li key={tipo}>{etiquetaDocumento(tipo)}</li>
        ))}
      </ul>
    </div>
  );
}
