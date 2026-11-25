"use client";

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { nuevaClave } from "@/lib/clave";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MAX_BYTES_CSV } from "@/lib/domain/lector-csv";
import { ETIQUETA_ROL_INVITADO, rolesQuePuedeInvitar, type RolInvitable } from "@/lib/domain/invitaciones";
import { enlaceWhatsApp } from "@/lib/domain/rp-reservas";
import {
  MAX_PERSONAL_CSV,
  leerPersonalCsv,
  mensajeInvitacion,
  textoEnlaces,
  type FilaPersonal,
  type ResultadoImportarPersonal,
} from "@/lib/domain/importar-personal";

// Invitar en lote desde un CSV (B1b): una invitación por persona, todas con
// el mismo rol. Primero se revisa (vista previa y errores por línea) y luego
// se manda todo junto: la base guarda todas o ninguna
// (invitaciones_importar). No se crean cuentas ni contraseñas: cada quien
// elige la suya con su enlace. Si el correo no sale (hoy los correos se
// archivan), los enlaces se muestran aquí para entregarlos a mano. Si se
// pierden (mala señal, o salir de la pantalla), «Volver a sacar los enlaces»
// los cambia por otros y los vuelve a mostrar: solo quien importó, hasta 3
// veces en 24 horas (invitaciones_reemitir_lote, sql/post-junta-2/24).

type Revision = { filas: FilaPersonal[]; errores: string[]; loteId: string; rol: RolInvitable };
// Un lote de las últimas 24 h hecho por quien está viendo.
type LoteReciente = { id: string; rol: RolInvitable; total: number; hecho_en: string; reemisiones: number };

const MAX_REEMISIONES = 3;
const hora = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function ImportarPersonal({
  clubId,
  nombreClub,
  miRol,
  onListo,
}: {
  clubId: string;
  nombreClub: string;
  miRol: string;
  onListo?: () => void;
}) {
  const roles = rolesQuePuedeInvitar(miRol);
  const [rol, setRol] = useState<RolInvitable>(roles.includes("rp") ? "rp" : (roles[0] ?? "rp"));
  const [texto, setTexto] = useState("");
  const [revision, setRevision] = useState<Revision | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<(ResultadoImportarPersonal & { rol: RolInvitable }) | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  // Lote guardado cuyos enlaces no llegaron a esta pantalla (respuesta
  // perdida o tokens fallidos): se ofrece sacarlos otra vez.
  const [sinEnlaces, setSinEnlaces] = useState<{ loteId: string; rol: RolInvitable } | null>(null);
  const [recientes, setRecientes] = useState<LoteReciente[] | null>(null);
  const [errorRecientes, setErrorRecientes] = useState<string | null>(null);
  const [confirmarLote, setConfirmarLote] = useState<string | null>(null);
  const [reemitiendo, setReemitiendo] = useState<string | null>(null);
  const puedeImportar = roles.length > 0;

  const cargarRecientes = useCallback(async () => {
    const sb = createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return setRecientes([]);
    const { data, error: e } = await sb
      .from("invitacion_lotes")
      .select("id, rol, total, hecho_en, reemisiones")
      .eq("club_id", clubId)
      .eq("hecho_por", user.id)
      .gt("hecho_en", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("hecho_en", { ascending: false })
      .limit(10);
    if (e) {
      setErrorRecientes(mensajeParaUsuario(e, "No pudimos cargar tus importaciones."));
      return;
    }
    setErrorRecientes(null);
    setRecientes((data ?? []) as LoteReciente[]);
  }, [clubId]);

  useEffect(() => {
    if (puedeImportar) cargarRecientes();
  }, [cargarRecientes, puedeImportar]);

  if (!puedeImportar) return null;

  function cambiarTexto(t: string) {
    setTexto(t);
    setRevision(null);
    setError(null);
  }

  async function leerArchivo(e: ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    e.target.value = "";
    if (!archivo) return;
    if (archivo.size > MAX_BYTES_CSV) return setError("El archivo es muy grande (máximo 500 KB).");
    cambiarTexto(await archivo.text());
  }

  function revisar() {
    setResultado(null);
    setError(null);
    // Una clave por lista revisada: si se reintenta el envío de ESTA lista,
    // la base no duplica nada.
    setRevision({ ...leerPersonalCsv(texto), loteId: nuevaClave(), rol });
  }

  async function importar() {
    if (!revision || revision.errores.length || revision.filas.length === 0) return;
    setGuardando(true);
    setError(null);
    try {
      const r = await fetch("/api/equipo/importar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ club_id: clubId, rol: revision.rol, lote_id: revision.loteId, filas: revision.filas }),
      });
      const c = (await r.json().catch(() => ({}))) as Partial<ResultadoImportarPersonal> & { error?: string; guardado?: boolean };
      if (!r.ok || c.ok !== true) {
        setError(c.error ?? "No se pudo importar la lista. No se guardó nada; intenta de nuevo.");
        if (c.guardado) {
          // Se guardó pero sin enlaces: la lista ya no se vuelve a mandar.
          setSinEnlaces({ loteId: revision.loteId, rol: revision.rol });
          setRevision(null);
          setTexto("");
          onListo?.();
          cargarRecientes();
        }
        return;
      }
      setResultado({ ...(c as ResultadoImportarPersonal), rol: revision.rol });
      setSinEnlaces(c.repetido ? { loteId: revision.loteId, rol: revision.rol } : null);
      setRevision(null);
      setTexto("");
      onListo?.();
      cargarRecientes();
    } catch {
      setError("Sin conexión. Revisa tu internet y vuelve a tocar «Invitar»: si la lista ya se había guardado, no se duplica.");
    } finally {
      setGuardando(false);
    }
  }

  async function reemitir(loteId: string, rolLote: RolInvitable) {
    setReemitiendo(loteId);
    setError(null);
    try {
      const r = await fetch("/api/equipo/importar/reemitir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lote_id: loteId }),
      });
      const c = (await r.json().catch(() => ({}))) as Partial<ResultadoImportarPersonal> & { error?: string };
      if (!r.ok || c.ok !== true) {
        setError(c.error ?? "No se pudieron sacar los enlaces. Intenta de nuevo.");
        return;
      }
      setResultado({ ...(c as ResultadoImportarPersonal), rol: rolLote });
      setSinEnlaces(null);
      onListo?.();
    } catch {
      setError("Sin conexión. Revisa tu internet e intenta de nuevo.");
    } finally {
      setReemitiendo(null);
      setConfirmarLote(null);
      cargarRecientes();
    }
  }

  // Botón «Volver a sacar los enlaces» con su confirmación (los enlaces
  // anteriores dejan de servir).
  function botonReemitir(loteId: string, rolLote: RolInvitable, etiqueta = "Volver a sacar los enlaces") {
    if (confirmarLote !== loteId) {
      return (
        <Button type="button" variant="outline" className="h-10 self-start" disabled={reemitiendo !== null} onClick={() => setConfirmarLote(loteId)}>
          {etiqueta}
        </Button>
      );
    }
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <p className="text-sm">
          Se hacen enlaces nuevos para las invitaciones que siguen pendientes y se vuelven a mandar los correos. Los enlaces que ya entregaste de esta lista dejan
          de servir.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="h-10" disabled={reemitiendo !== null} onClick={() => reemitir(loteId, rolLote)}>
            {reemitiendo === loteId ? "Sacando enlaces…" : "Sí, sacar enlaces nuevos"}
          </Button>
          <Button type="button" variant="ghost" className="h-10" disabled={reemitiendo !== null} onClick={() => setConfirmarLote(null)}>
            Cancelar
          </Button>
        </div>
      </div>
    );
  }

  async function copiar(clave: string, contenido: string) {
    try {
      await navigator.clipboard.writeText(contenido);
      setCopiado(clave);
    } catch {
      setCopiado(null);
    }
  }

  const etiquetaRol = ETIQUETA_ROL_INVITADO[revision?.rol ?? rol];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invitar en lote (CSV)</CardTitle>
        <CardDescription>
          Una línea por persona: <strong>nombre, correo, teléfono</strong> (el teléfono es opcional). Hasta {MAX_PERSONAL_CSV} por archivo, todos con el
          mismo rol. No se crean contraseñas: a cada quien le llega su invitación para elegir la suya.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-6 pb-6">
        {roles.length > 1 ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Rol para toda la lista</legend>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => (
                <Button
                  key={r}
                  type="button"
                  variant={rol === r ? "default" : "outline"}
                  className="h-10 min-w-20"
                  aria-pressed={rol === r}
                  onClick={() => {
                    setRol(r);
                    setRevision(null);
                  }}
                >
                  {ETIQUETA_ROL_INVITADO[r]}
                </Button>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="text-xs text-muted-foreground">Todos entran como RP. A staff y gerentes los invita el dueño.</p>
        )}
        {/* Botón propio: el del navegador sale en inglés («Choose File»). */}
        <label className={buttonVariants({ variant: "outline", className: "h-10 cursor-pointer self-start focus-within:ring-3 focus-within:ring-ring/50" })}>
          Elegir archivo (.csv)
          <input id="lote-archivo" type="file" accept=".csv,.txt,text/csv" className="sr-only" onChange={leerArchivo} />
        </label>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lote-texto">O pega la lista</Label>
          <textarea
            id="lote-texto"
            className="min-h-28 w-full rounded-lg border border-input bg-background px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder={"nombre,correo,teléfono\nAna López,ana@example.com,55 1234 5678\nLuis Pérez,luis@example.com"}
            value={texto}
            onChange={(e) => cambiarTexto(e.target.value)}
          />
        </div>
        <Button type="button" variant="outline" className="h-10 self-start" disabled={!texto.trim()} onClick={revisar}>
          Revisar
        </Button>

        {revision && (
          <div className="flex flex-col gap-2 text-sm">
            {revision.errores.length > 0 ? (
              <>
                <p className="font-medium text-status-err">
                  {revision.errores.length === 1 ? "Hay 1 línea por corregir" : `Hay ${revision.errores.length} líneas por corregir`}. No se invita a nadie hasta
                  que todas estén bien.
                </p>
                <ul role="alert" className="flex flex-col gap-1 text-status-err">
                  {revision.errores.slice(0, 20).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                  {revision.errores.length > 20 && <li>…y {revision.errores.length - 20} más.</li>}
                </ul>
              </>
            ) : (
              <p>
                {revision.filas.length} {revision.filas.length === 1 ? "persona lista" : "personas listas"} para invitar como {etiquetaRol}:
              </p>
            )}
            {revision.filas.length > 0 && (
              <ul className="flex max-h-60 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="Vista previa">
                {revision.filas.slice(0, 50).map((f) => (
                  <li key={f.correo} className="flex flex-col px-3 py-1.5">
                    <span className="truncate">{f.nombre}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {f.correo}
                      {f.telefono ? ` · ${f.telefono}` : ""}
                    </span>
                  </li>
                ))}
                {revision.filas.length > 50 && <li className="px-3 py-1.5 text-muted-foreground">…y {revision.filas.length - 50} más.</li>}
              </ul>
            )}
            <Button
              type="button"
              className="h-10 self-start"
              disabled={guardando || revision.errores.length > 0 || revision.filas.length === 0}
              onClick={importar}
            >
              {guardando ? "Invitando…" : `Invitar a ${revision.filas.length} como ${etiquetaRol}`}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        )}
        {sinEnlaces && botonReemitir(sinEnlaces.loteId, sinEnlaces.rol)}

        {resultado && (
          <div className="flex flex-col gap-3 text-sm">
            <p role="status" className="text-status-ok">
              {resultado.repetido
                ? `Esta lista ya se había importado (${resultado.creadas} invitaciones). No se duplicó nada. Si no te llegaron los enlaces, sácalos otra vez.`
                : resultado.reemitido
                  ? `Enlaces nuevos para ${resultado.enlaces.length + resultado.correos.enviados} invitaciones pendientes.` +
                    (resultado.correos.enviados ? ` ${resultado.correos.enviados} salieron por correo.` : "")
                  : `Listo: ${resultado.creadas} ${resultado.creadas === 1 ? "invitación creada" : "invitaciones creadas"}.` +
                    (resultado.correos.enviados ? ` ${resultado.correos.enviados} salieron por correo.` : "")}
            </p>
            {resultado.enlaces.length > 0 && (
              <section className="flex flex-col gap-2" aria-label="Enlaces para entregar">
                <div className="rounded-lg border border-status-warn/40 bg-status-warn/10 p-3">
                  <strong>
                    {resultado.enlaces.length === resultado.creadas
                      ? "Los correos todavía no salen."
                      : `${resultado.enlaces.length} correos no salieron.`}
                  </strong>{" "}
                  Entrega cada enlace a su persona por un medio privado (WhatsApp). Si sales de aquí sin entregarlos, en «Tus importaciones de las últimas 24
                  horas» puedes sacarlos otra vez (hasta {MAX_REEMISIONES} veces).
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 self-start"
                  onClick={() => copiar("todo", textoEnlaces(resultado.enlaces))}
                >
                  {copiado === "todo" ? "Copiado" : `Copiar los ${resultado.enlaces.length} enlaces (para una hoja de cálculo)`}
                </Button>
                <ul className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {resultado.enlaces.map((e) => {
                    const mensaje = mensajeInvitacion({ nombre: e.nombre, club: nombreClub || "el antro", rol: resultado.rol, enlace: e.enlace });
                    const wa = enlaceWhatsApp(e.telefono, mensaje);
                    return (
                      <li key={e.correo} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{e.nombre}</span>
                          <span className="truncate text-xs text-muted-foreground">{e.correo}</span>
                        </span>
                        <span className="flex gap-2">
                          {wa && (
                            <Button render={<a href={wa} target="_blank" rel="noopener noreferrer" />} nativeButton={false} variant="outline" className="h-10">
                              WhatsApp
                            </Button>
                          )}
                          <Button type="button" variant="ghost" className="h-10" onClick={() => copiar(e.correo, mensaje)}>
                            {copiado === e.correo ? "Copiado" : "Copiar"}
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}

        {errorRecientes && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-status-err">
              {errorRecientes}
            </p>
            <Button type="button" variant="outline" className="h-10" onClick={cargarRecientes}>
              Reintentar
            </Button>
          </div>
        )}
        {!errorRecientes && recientes && recientes.length > 0 && (
          <section className="flex flex-col gap-2 border-t border-border pt-3 text-sm" aria-label="Tus importaciones de las últimas 24 horas">
            <h3 className="font-medium">Tus importaciones de las últimas 24 horas</h3>
            <ul className="flex flex-col gap-2">
              {recientes.map((l) => (
                <li key={l.id} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2">
                  <span>
                    {l.total} {l.total === 1 ? "persona" : "personas"} como {ETIQUETA_ROL_INVITADO[l.rol]} ·{" "}
                    <span className="text-muted-foreground">{hora.format(new Date(l.hecho_en))}</span>
                  </span>
                  {l.id === sinEnlaces?.loteId ? null : l.reemisiones < MAX_REEMISIONES ? (
                    botonReemitir(l.id, l.rol)
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Ya sacaste sus enlaces {MAX_REEMISIONES} veces. Para alguien en particular, usa «Reenviar» en la lista de invitaciones.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
