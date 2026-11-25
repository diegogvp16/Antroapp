"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import type { EstadoCorreo, ResumenModoCorreo } from "@/lib/domain/correo";
import { enlaceEnTexto } from "@/lib/domain/invitaciones";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Bandeja de salida de correos (correos_salida, solo el admin la lee por RLS).
// Solo para revisar: aquí no se manda ni se reenvía nada.

interface Fila {
  id: string;
  creado_en: string;
  plantilla: string;
  destinatario: string;
  asunto: string;
  estado: EstadoCorreo;
  motivo: string | null;
  entorno: string;
  club_id: string | null;
  proveedor_id: string | null;
  enviado_en: string | null;
}

type Filtro = "todos" | EstadoCorreo;
const POR_PAGINA = 30;
const COLUMNAS = "id, creado_en, plantilla, destinatario, asunto, estado, motivo, entorno, club_id, proveedor_id, enviado_en";

const ETIQUETA: Record<EstadoCorreo, string> = { archivado: "Archivado", enviado: "Enviado", fallido: "Falló" };
const TONO: Record<EstadoCorreo, "ok" | "err" | "neutral"> = { archivado: "neutral", enviado: "ok", fallido: "err" };
const FILTROS: { clave: Filtro; texto: string }[] = [
  { clave: "todos", texto: "Todos" },
  { clave: "archivado", texto: "Archivados" },
  { clave: "enviado", texto: "Enviados" },
  { clave: "fallido", texto: "Fallidos" },
];

const fechaHora = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function textoModo(m: ResumenModoCorreo): { titulo: string; detalle: string; tono: "ok" | "warn" | "err" } {
  if (m.modo === "apagado") return { titulo: "Apagado", detalle: "No se manda ni se guarda ningún correo.", tono: "err" };
  if (m.modo === "archivo") return { titulo: "Archivo", detalle: "Ningún correo sale: todos se guardan aquí para revisarlos.", tono: "warn" };
  if (!m.llave || !m.remitente) return { titulo: "Enviar, sin llave", detalle: "Falta la llave de Resend o el remitente: todo se archiva.", tono: "warn" };
  if (!m.esProduccion) {
    return {
      titulo: "Enviar, en prueba",
      detalle: `Fuera de producción solo se manda a ${m.listaBlanca} ${m.listaBlanca === 1 ? "correo" : "correos"} de la lista blanca; los demás se archivan.`,
      tono: "warn",
    };
  }
  return { titulo: "Enviar", detalle: "Los correos se mandan y quedan aquí con su resultado.", tono: "ok" };
}

// Invitación archivada (los correos todavía no salen): el admin copia el
// enlace y se lo hace llegar a la persona por otro medio.
function CopiarEnlace({ texto }: { texto: string }) {
  const enlace = enlaceEnTexto(texto);
  const [estado, setEstado] = useState<"listo" | "copiado" | "fallo">("listo");
  if (!enlace) return null;
  async function copiar() {
    try {
      await navigator.clipboard.writeText(enlace!);
      setEstado("copiado");
    } catch {
      setEstado("fallo");
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" className="h-10" onClick={() => void copiar()}>
          Copiar enlace de la invitación
        </Button>
        {estado === "copiado" && (
          <span role="status" className="text-xs text-status-ok">
            Copiado.
          </span>
        )}
        {estado === "fallo" && (
          <span role="alert" className="text-xs text-status-err">
            No se pudo copiar: selecciona el enlace del texto.
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Mándalo solo a la persona invitada: sirve una vez y vence en 72 h. Si hay varios para el mismo correo, solo sirve el más reciente.
      </p>
    </div>
  );
}

export function BandejaCorreos() {
  const [modo, setModo] = useState<ResumenModoCorreo | null>(null);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [filas, setFilas] = useState<Fila[]>([]);
  const [hayMas, setHayMas] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cuerpos, setCuerpos] = useState<Record<string, string>>({});
  const [falloCuerpo, setFalloCuerpo] = useState<string | null>(null);

  // Solo cuenta la respuesta de la última consulta (si se cambia de filtro
  // rápido, una respuesta vieja no pisa la lista nueva).
  const consulta = useRef(0);
  const cargar = useCallback(async (f: Filtro, desde: number) => {
    const esta = ++consulta.current;
    setCargando(true);
    setFallo(null);
    let q = createClient().from("correos_salida").select(COLUMNAS).order("creado_en", { ascending: false });
    if (f !== "todos") q = q.eq("estado", f);
    const { data, error } = await q.range(desde, desde + POR_PAGINA);
    if (esta !== consulta.current) return;
    if (error) {
      setFallo(mensajeParaUsuario(error, "No pudimos cargar los correos."));
    } else {
      const lista = (data ?? []) as Fila[];
      setHayMas(lista.length > POR_PAGINA);
      const pagina = lista.slice(0, POR_PAGINA);
      setFilas((antes) => (desde === 0 ? pagina : [...antes, ...pagina]));
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar(filtro, 0);
  }, [cargar, filtro]);

  useEffect(() => {
    fetch("/api/admin/correos", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m: ResumenModoCorreo | null) => setModo(m))
      .catch(() => setModo(null));
  }, []);

  async function alternar(id: string) {
    setFalloCuerpo(null);
    if (abierto === id) return setAbierto(null);
    setAbierto(id);
    if (cuerpos[id] !== undefined) return;
    const { data, error } = await createClient().from("correos_salida").select("cuerpo").eq("id", id).maybeSingle();
    if (error || !data) setFalloCuerpo(mensajeParaUsuario(error, "No pudimos abrir el correo."));
    else setCuerpos((c) => ({ ...c, [id]: data.cuerpo as string }));
  }

  const m = modo ? textoModo(modo) : null;

  return (
    <div className="flex flex-col gap-5">
      <Card size="sm">
        <CardContent className="flex flex-col gap-1.5 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Modo de envío:</span>
            {m ? <Badge variant={m.tono}>{m.titulo}</Badge> : <span className="text-muted-foreground">sin dato</span>}
            {modo && <span className="text-muted-foreground">· entorno {modo.entorno}</span>}
          </p>
          {m && <p className="text-muted-foreground">{m.detalle}</p>}
          {modo?.avisos.map((a) => (
            <p key={a} className="text-status-warn">
              {a}
            </p>
          ))}
          <p className="text-muted-foreground">
            No aparecen aquí los correos de Supabase (recuperar contraseña y confirmar registro): esos los manda Supabase por su cuenta.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
        {FILTROS.map((f) => (
          <Button
            key={f.clave}
            type="button"
            variant={filtro === f.clave ? "default" : "outline"}
            className="h-10 px-3"
            aria-pressed={filtro === f.clave}
            onClick={() => {
              if (f.clave === filtro) return;
              setAbierto(null);
              setFilas([]);
              setHayMas(false);
              setFiltro(f.clave);
            }}
          >
            {f.texto}
          </Button>
        ))}
      </div>

      {fallo && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-status-err">
            {fallo}
          </p>
          <Button type="button" variant="outline" className="h-10" onClick={() => void cargar(filtro, 0)}>
            Reintentar
          </Button>
        </div>
      )}

      {cargando && filas.length === 0 && !fallo && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!cargando && !fallo && filas.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {filtro === "todos" ? "Todavía no hay correos en la bandeja." : "No hay correos con ese estado."}
        </p>
      )}

      {filas.length > 0 && (
        <Card>
          <CardContent className="flex flex-col divide-y divide-border px-0 py-0">
            {filas.map((f) => {
              const abiertoEste = abierto === f.id;
              return (
                <div key={f.id} className="flex flex-col">
                  <button
                    type="button"
                    className="flex min-h-14 w-full flex-col gap-1 px-4 py-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    aria-expanded={abiertoEste}
                    onClick={() => void alternar(f.id)}
                  >
                    <span className="flex w-full items-start justify-between gap-2">
                      <span className="min-w-0 break-words font-medium">{f.asunto}</span>
                      <Badge variant={TONO[f.estado]} className="shrink-0">
                        {ETIQUETA[f.estado]}
                      </Badge>
                    </span>
                    <span className="min-w-0 break-all text-xs text-muted-foreground">
                      {fechaHora.format(new Date(f.creado_en))} · {f.destinatario}
                    </span>
                  </button>
                  {abiertoEste && (
                    <div className="flex flex-col gap-2 bg-muted/50 px-4 py-3 text-sm">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">Para</dt>
                        <dd className="break-all">{f.destinatario}</dd>
                        <dt className="text-muted-foreground">Tipo</dt>
                        <dd className="break-all">{f.plantilla}</dd>
                        <dt className="text-muted-foreground">Entorno</dt>
                        <dd>{f.entorno}</dd>
                        {f.motivo && (
                          <>
                            <dt className="text-muted-foreground">Motivo</dt>
                            <dd className="break-words">{f.motivo}</dd>
                          </>
                        )}
                        {f.enviado_en && (
                          <>
                            <dt className="text-muted-foreground">Enviado</dt>
                            <dd>{fechaHora.format(new Date(f.enviado_en))}</dd>
                          </>
                        )}
                        {f.proveedor_id && (
                          <>
                            <dt className="text-muted-foreground">Id en Resend</dt>
                            <dd className="break-all">{f.proveedor_id}</dd>
                          </>
                        )}
                      </dl>
                      {cuerpos[f.id] !== undefined ? (
                        <>
                          {f.estado === "archivado" && f.plantilla.startsWith("invitacion") && <CopiarEnlace texto={cuerpos[f.id]} />}
                          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-sans text-sm">
                            {cuerpos[f.id] || "(sin texto)"}
                          </pre>
                        </>
                      ) : falloCuerpo ? (
                        <p role="alert" className="text-status-err">
                          {falloCuerpo}
                        </p>
                      ) : (
                        <p className="text-muted-foreground">Cargando el texto…</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {hayMas && (
        <Button type="button" variant="outline" className="h-10 self-start" disabled={cargando} onClick={() => void cargar(filtro, filas.length)}>
          {cargando ? "Cargando…" : "Ver más"}
        </Button>
      )}
    </div>
  );
}
