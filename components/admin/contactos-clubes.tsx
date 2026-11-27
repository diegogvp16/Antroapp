"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Admin: bandeja de los contactos que dejan los antros en /para-clubes
// (contactos_clubes_admin, contacto_club_marcar, contacto_club_borrar en
// sql/post-junta-3/50-para-clubes.sql). Solo el admin los lee: la base lo
// exige, no solo esta pantalla. No se manda ningún correo.

type EstadoContacto = "nuevo" | "atendido" | "descartado";
interface Contacto {
  id: string;
  nombre: string;
  club_nombre: string;
  ciudad: string;
  correo: string;
  telefono: string | null;
  mensaje: string | null;
  estado: EstadoContacto;
  atendido_por_nombre: string | null;
  atendido_en: string | null;
  creado_en: string;
  total: number;
}

const POR_PAGINA = 50;

const FILTROS: { valor: EstadoContacto | null; etiqueta: string }[] = [
  { valor: "nuevo", etiqueta: "Nuevos" },
  { valor: "atendido", etiqueta: "Atendidos" },
  { valor: "descartado", etiqueta: "Descartados" },
  { valor: null, etiqueta: "Todos" },
];
const ETIQUETA: Record<EstadoContacto, { texto: string; variante: "warn" | "ok" | "neutral" }> = {
  nuevo: { texto: "Nuevo", variante: "warn" },
  atendido: { texto: "Atendido", variante: "ok" },
  descartado: { texto: "Descartado", variante: "neutral" },
};
const fecha = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Mexico_City" });

export function ContactosClubes() {
  const [filtro, setFiltro] = useState<EstadoContacto | null>("nuevo");
  const [filas, setFilas] = useState<Contacto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [conteo, setConteo] = useState<Partial<Record<EstadoContacto, number>>>({});
  const [cargandoMas, setCargandoMas] = useState(false);

  // Primera página del filtro (o la siguiente, si «mas»). Los conteos por
  // estado se piden aparte: la bandeja trae a lo más 50 por vez.
  const cargar = useCallback(async (estado: EstadoContacto | null, desde = 0) => {
    const supabase = createClient();
    const [{ data, error: e }, c] = await Promise.all([
      supabase.rpc("contactos_clubes_admin", { p_estado: estado, p_limite: POR_PAGINA, p_desde: desde }),
      supabase.rpc("contactos_clubes_conteo"),
    ]);
    if (e) {
      setError(e.code === "PGRST202" ? "La base todavía no tiene los contactos de antros (falta el SQL 50 de post-junta-3)." : mensajeParaUsuario(e));
      setFilas([]);
      return;
    }
    setError(null);
    const nuevas = (data ?? []) as Contacto[];
    setFilas((prev) => (desde === 0 ? nuevas : [...(prev ?? []), ...nuevas]));
    setTotal((t) => (nuevas[0] ? Number(nuevas[0].total) : desde === 0 ? 0 : t));
    if (!c.error) setConteo(Object.fromEntries(((c.data ?? []) as { estado: EstadoContacto; total: number }[]).map((x) => [x.estado, Number(x.total)])));
  }, []);

  async function verMas() {
    setCargandoMas(true);
    await cargar(filtro, filas?.length ?? 0);
    setCargandoMas(false);
  }
  const todos = (conteo.nuevo ?? 0) + (conteo.atendido ?? 0) + (conteo.descartado ?? 0);

  useEffect(() => {
    void cargar(filtro);
  }, [cargar, filtro]);

  async function marcar(c: Contacto, estado: EstadoContacto) {
    setOcupado(c.id);
    setAviso(null);
    const { error: e } = await createClient().rpc("contacto_club_marcar", { p_id: c.id, p_estado: estado });
    setOcupado(null);
    if (e) return setAviso(mensajeParaUsuario(e));
    setAviso(`«${c.club_nombre}» quedó como ${ETIQUETA[estado].texto.toLowerCase()}.`);
    await cargar(filtro);
  }

  async function borrar(c: Contacto) {
    if (!window.confirm(`¿Borrar para siempre los datos de «${c.nombre}» (${c.club_nombre})? Úsalo si la persona pidió que se borren.`)) return;
    setOcupado(c.id);
    setAviso(null);
    const { error: e } = await createClient().rpc("contacto_club_borrar", { p_id: c.id });
    setOcupado(null);
    if (e) return setAviso(mensajeParaUsuario(e));
    setAviso(`Se borraron los datos de «${c.club_nombre}».`);
    await cargar(filtro);
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="Filtrar por estado" className="flex flex-wrap gap-2">
        {FILTROS.map((f) => (
          <Button
            key={f.etiqueta}
            variant={filtro === f.valor ? "default" : "outline"}
            className="h-10"
            aria-pressed={filtro === f.valor}
            onClick={() => setFiltro(f.valor)}
          >
            {f.etiqueta} ({f.valor ? (conteo[f.valor] ?? 0) : todos})
          </Button>
        ))}
      </div>

      {aviso && (
        <p role="status" className="text-sm text-muted-foreground">
          {aviso}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-status-err">
          {error}
        </p>
      )}

      {filas === null ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : filas.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">No hay contactos {filtro ? `con estado «${ETIQUETA[filtro].texto.toLowerCase()}»` : "todavía"}.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {filas.map((c) => (
            <li key={c.id}>
              <Card>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <h2 className="text-base font-semibold break-words">{c.club_nombre}</h2>
                      <p className="text-sm text-muted-foreground">
                        {c.ciudad} · {fecha.format(new Date(c.creado_en))}
                      </p>
                    </div>
                    <Badge variant={ETIQUETA[c.estado].variante}>{ETIQUETA[c.estado].texto}</Badge>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Nombre</dt>
                    <dd className="break-words">{c.nombre}</dd>
                    <dt className="text-muted-foreground">Correo</dt>
                    <dd className="break-all">
                      <a href={`mailto:${c.correo}`} className="underline underline-offset-4">
                        {c.correo}
                      </a>
                    </dd>
                    {c.telefono && (
                      <>
                        <dt className="text-muted-foreground">Teléfono</dt>
                        <dd>
                          <a href={`tel:${c.telefono}`} className="underline underline-offset-4">
                            {c.telefono}
                          </a>
                        </dd>
                      </>
                    )}
                  </dl>
                  {c.mensaje && <p className="whitespace-pre-line break-words rounded-md bg-muted px-3 py-2 text-sm">{c.mensaje}</p>}
                  {c.atendido_en && (
                    <p className="text-xs text-muted-foreground">
                      {ETIQUETA[c.estado].texto} el {fecha.format(new Date(c.atendido_en))}
                      {c.atendido_por_nombre ? ` por ${c.atendido_por_nombre}` : ""}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {c.estado !== "atendido" && (
                      <Button className="h-10" disabled={ocupado === c.id} onClick={() => void marcar(c, "atendido")}>
                        Marcar atendido
                      </Button>
                    )}
                    {c.estado !== "descartado" && (
                      <Button variant="outline" className="h-10" disabled={ocupado === c.id} onClick={() => void marcar(c, "descartado")}>
                        Descartar
                      </Button>
                    )}
                    {c.estado !== "nuevo" && (
                      <Button variant="outline" className="h-10" disabled={ocupado === c.id} onClick={() => void marcar(c, "nuevo")}>
                        Volver a nuevo
                      </Button>
                    )}
                    <Button variant="ghost" className="h-10 text-status-err" disabled={ocupado === c.id} onClick={() => void borrar(c)}>
                      Borrar datos
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {filas && filas.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Mostrando {filas.length} de {total}
          </p>
          {filas.length < total && (
            <Button variant="outline" className="h-10" disabled={cargandoMas} onClick={() => void verMas()}>
              {cargandoMas ? "Cargando…" : `Ver ${Math.min(POR_PAGINA, total - filas.length)} más`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
