"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { formatearCentavos } from "@/lib/domain/caja";
import { etiquetaNoche } from "@/lib/fechas";
import { EXTENSIONES_POS, huellaArchivo, leerArchivoPos } from "@/lib/pos/adaptadores";
import { sugerirFormatoFecha } from "@/lib/pos/fecha-hora";
import {
  ajustarMapeo,
  avisosMapeo,
  faltantesMapeo,
  formatosNumeros,
  lineasParaBase,
  muestras,
  normalizarVentas,
  sugerirMapeo,
  type ResultadoNormalizar,
} from "@/lib/pos/mapeo";
import { MOTIVO_SIN_LIGAR } from "@/lib/pos/conciliacion";
import { CAMPOS_POS, type CampoPos, type FormatoPos, type MapeoPos, type TablaPos } from "@/lib/pos/tipos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Importar ventas del POS (CSV o Excel): archivo → mapeo de columnas →
// vista previa (errores, avisos, repetidas y cómo se liga cada venta) →
// confirmar. La base valida todo otra vez e importa TODO o NADA
// (pos_importar). Las ventas del POS no cambian la caja.

export const CLASE_SELECT =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

export interface MapeoGuardado {
  id: string;
  nombre: string;
  config: MapeoPos;
}

interface Candidata {
  cuenta_id: string;
  cliente_nombre: string;
  mesa_numero: string;
}
interface LineaPreparada {
  linea: number;
  repetida: boolean;
  fecha_operacion: string;
  estado: string;
  mesa_numero?: string;
  cuenta_id?: string;
  grupo?: string;
  candidatos?: Candidata[];
}
interface Resultado {
  nuevas: number;
  repetidas: number;
  ligadas: number;
  sin_ligar: number;
  total_centavos: number;
}

type Paso =
  | { paso: "archivo" }
  | { paso: "mapeo"; nombre: string; formato: FormatoPos; hash: string; tabla: TablaPos }
  | { paso: "revision"; nombre: string; formato: FormatoPos; hash: string; tabla: TablaPos; revisado: ResultadoNormalizar; preparadas: Map<number, LineaPreparada>; yaImportado: string | null }
  | { paso: "listo"; resultado: Resultado; noches: string[] };

type Filtro = "error" | "sin_ligar" | "avisos" | "todas";

export function ImportarVentas({ clubId, onImportado }: { clubId: string; onImportado: (noches: string[]) => void }) {
  const [estado, setEstado] = useState<Paso>({ paso: "archivo" });
  const [mapeo, setMapeo] = useState<MapeoPos>({ columnas: {} });
  const [guardados, setGuardados] = useState<MapeoGuardado[]>([]);
  const [mapeoId, setMapeoId] = useState<string | null>(null);
  const [nombreMapeo, setNombreMapeo] = useState("");
  const [asignadas, setAsignadas] = useState<Map<number, string>>(new Map());
  const [aceptoOmitir, setAceptoOmitir] = useState(false);
  const [filtro, setFiltro] = useState<Filtro>("error");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function elegirArchivo(e: ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    e.target.value = "";
    if (!archivo) return;
    setError(null);
    setAviso(null);
    setOcupado(true);
    const bytes = new Uint8Array(await archivo.arrayBuffer());
    const leido = await leerArchivoPos(bytes, archivo.name);
    if (!leido.ok) {
      setOcupado(false);
      return setError(leido.error);
    }
    const hash = await huellaArchivo(bytes);
    const { data, error: e2 } = await createClient().rpc("pos_mapeos_lista", { p_club_id: clubId });
    setOcupado(false);
    if (e2) return setError(mensajeParaUsuario(e2, "No pudimos cargar los mapeos guardados."));
    const lista = ((data ?? []) as MapeoGuardado[]).map((m) => ({ ...m, config: m.config ?? { columnas: {} } }));
    setGuardados(lista);
    const enc = leido.tabla.encabezados;
    // El mapeo guardado más reciente que sirva para este archivo; si no, la sugerencia.
    const sirve = lista.find((m) => faltantesMapeo(ajustarMapeo(m.config, enc), enc).length === 0);
    if (sirve) {
      setMapeo(ajustarMapeo(sirve.config, enc));
      setMapeoId(sirve.id);
      setNombreMapeo(sirve.nombre);
    } else {
      const columnas = sugerirMapeo(enc);
      const fechas = columnas.fecha ? muestras(leido.tabla, columnas.fecha, 50) : [];
      setMapeo({ columnas, formato_fecha: sugerirFormatoFecha(fechas) });
      setMapeoId(null);
      setNombreMapeo("");
    }
    setAsignadas(new Map());
    setAceptoOmitir(false);
    setEstado({ paso: "mapeo", nombre: archivo.name, formato: leido.formato, hash, tabla: leido.tabla });
  }

  function cambiarColumna(campo: CampoPos, columna: string) {
    setMapeoId(null);
    setMapeo((m) => {
      const columnas = { ...m.columnas };
      // Una columna es un solo dato: si ya la tenía otro, se le quita.
      for (const [k, v] of Object.entries(columnas)) if (columna && v === columna) delete columnas[k as CampoPos];
      if (columna) columnas[campo] = columna;
      else delete columnas[campo];
      return { ...m, columnas };
    });
  }

  function aplicarGuardado(id: string) {
    if (estado.paso !== "mapeo") return;
    const m = guardados.find((g) => g.id === id);
    if (!m) return;
    setMapeo(ajustarMapeo(m.config, estado.tabla.encabezados));
    setMapeoId(m.id);
    setNombreMapeo(m.nombre);
  }

  async function guardarMapeo() {
    if (!nombreMapeo.trim()) return setError("Escribe un nombre para el mapeo (por ejemplo, el nombre de tu POS).");
    setOcupado(true);
    setError(null);
    const { data, error: e } = await createClient().rpc("pos_mapeo_guardar", { p_club_id: clubId, p_nombre: nombreMapeo.trim(), p_config: mapeo });
    setOcupado(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo guardar el mapeo."));
    setMapeoId(String(data));
    setAviso(`Mapeo «${nombreMapeo.trim()}» guardado: la próxima vez se elige solo.`);
    const { data: lista } = await createClient().rpc("pos_mapeos_lista", { p_club_id: clubId });
    if (Array.isArray(lista)) setGuardados(lista as MapeoGuardado[]);
  }

  async function revisar() {
    if (estado.paso !== "mapeo") return;
    setError(null);
    setAviso(null);
    const revisado = normalizarVentas(estado.tabla, mapeo);
    if (revisado.errorGeneral) return setError(revisado.errorGeneral);
    if (!revisado.ventas.length) {
      setEstado({ ...estado, paso: "revision", revisado, preparadas: new Map(), yaImportado: null });
      setFiltro("error");
      return;
    }
    setOcupado(true);
    const { data, error: e } = await createClient().rpc("pos_preparar", {
      p_club_id: clubId,
      p_lineas: lineasParaBase(revisado.ventas),
      p_archivo_hash: estado.hash,
    });
    setOcupado(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo revisar el archivo con la caja. Intenta de nuevo."));
    // Las candidatas llegan una vez por grupo (ticket + noche + mesa).
    const r = data as { lineas: LineaPreparada[]; grupos?: Record<string, Candidata[]>; archivo_importado_en: string | null };
    const preparadas = new Map(r.lineas.map((l) => [l.linea, { ...l, candidatos: l.grupo ? r.grupos?.[l.grupo] : undefined }]));
    setAsignadas(new Map());
    setAceptoOmitir(false);
    setFiltro(revisado.conError ? "error" : "sin_ligar");
    setEstado({ ...estado, paso: "revision", revisado, preparadas, yaImportado: r.archivo_importado_en });
  }

  async function importar() {
    if (estado.paso !== "revision") return;
    setOcupado(true);
    setError(null);
    const { data, error: e } = await createClient().rpc("pos_importar", {
      p_club_id: clubId,
      p_archivo_nombre: estado.nombre.slice(0, 200),
      p_archivo_hash: estado.hash,
      p_formato: estado.formato,
      p_mapeo_id: mapeoId,
      p_lineas: lineasParaBase(estado.revisado.ventas, asignadas),
    });
    setOcupado(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo importar. No se guardó nada."));
    setEstado({ paso: "listo", resultado: data as Resultado, noches: estado.revisado.noches });
  }

  const reiniciar = () => {
    setEstado({ paso: "archivo" });
    setError(null);
    setAviso(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {estado.paso === "archivo" && (
        <Card>
          <CardHeader>
            <CardTitle>1. Elige el archivo del POS</CardTitle>
            <CardDescription>
              CSV o Excel (.xlsx), exportado del punto de venta. Una fila por producto vendido (o por ticket). Se lee en tu teléfono; a la base
              solo llegan las ventas ya revisadas.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Label htmlFor="pos-archivo" className="sr-only">
              Archivo del POS
            </Label>
            <Input id="pos-archivo" type="file" accept={EXTENSIONES_POS} onChange={elegirArchivo} disabled={ocupado} className="h-10 pt-2" />
            {ocupado && <p className="text-sm text-muted-foreground">Leyendo el archivo…</p>}
          </CardContent>
        </Card>
      )}

      {estado.paso === "mapeo" && (
        <PasoMapeo
          tabla={estado.tabla}
          nombre={estado.nombre}
          mapeo={mapeo}
          guardados={guardados}
          mapeoId={mapeoId}
          nombreMapeo={nombreMapeo}
          ocupado={ocupado}
          onColumna={cambiarColumna}
          onFormato={(f) => setMapeo((m) => ({ ...m, formato_fecha: f }))}
          onMontos={(f) => {
            setMapeoId(null);
            setMapeo((m) => {
              const nuevo: MapeoPos = { ...m };
              if (f) nuevo.formato_montos = f;
              else delete nuevo.formato_montos;
              return nuevo;
            });
          }}
          onGuardado={aplicarGuardado}
          onNombre={setNombreMapeo}
          onGuardar={guardarMapeo}
          onRevisar={revisar}
          onOtro={reiniciar}
        />
      )}

      {estado.paso === "revision" && (
        <PasoRevision
          nombre={estado.nombre}
          revisado={estado.revisado}
          preparadas={estado.preparadas}
          yaImportado={estado.yaImportado}
          asignadas={asignadas}
          onAsignar={(lineas, cuenta) =>
            setAsignadas((a) => {
              const n = new Map(a);
              for (const l of lineas) {
                if (cuenta) n.set(l, cuenta);
                else n.delete(l);
              }
              return n;
            })
          }
          filtro={filtro}
          onFiltro={setFiltro}
          aceptoOmitir={aceptoOmitir}
          onAceptoOmitir={setAceptoOmitir}
          ocupado={ocupado}
          onImportar={importar}
          onVolver={() => setEstado({ paso: "mapeo", nombre: estado.nombre, formato: estado.formato, hash: estado.hash, tabla: estado.tabla })}
        />
      )}

      {estado.paso === "listo" && (
        <Card>
          <CardHeader>
            <CardTitle>Listo: ventas importadas</CardTitle>
            <CardDescription>Son un registro aparte para comparar: no cambian la caja, comisiones ni nómina.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p data-testid="pos-resultado">
              {estado.resultado.nuevas.toLocaleString("es-MX")} {estado.resultado.nuevas === 1 ? "venta nueva" : "ventas nuevas"} por{" "}
              {formatearCentavos(estado.resultado.total_centavos)}
              {estado.resultado.repetidas > 0 && ` (${estado.resultado.repetidas.toLocaleString("es-MX")} ya estaban y se saltaron)`}.{" "}
              {estado.resultado.ligadas.toLocaleString("es-MX")} ligadas a una cuenta de caja y {estado.resultado.sin_ligar.toLocaleString("es-MX")} sin ligar.
            </p>
            <div className="flex flex-wrap gap-2">
              {estado.noches.length > 0 && (
                <Button type="button" className="h-10" onClick={() => onImportado(estado.noches)}>
                  Ver la conciliación ({etiquetaNoche(estado.noches[estado.noches.length - 1])})
                </Button>
              )}
              <Button type="button" variant="outline" className="h-10" onClick={reiniciar}>
                Importar otro archivo
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {aviso && <p className="text-sm text-status-ok">{aviso}</p>}
      {error && (
        <p role="alert" className="text-sm text-status-err">
          {error}
        </p>
      )}
    </div>
  );
}

function PasoMapeo(props: {
  tabla: TablaPos;
  nombre: string;
  mapeo: MapeoPos;
  guardados: MapeoGuardado[];
  mapeoId: string | null;
  nombreMapeo: string;
  ocupado: boolean;
  onColumna: (c: CampoPos, col: string) => void;
  onFormato: (f: "dmy" | "mdy") => void;
  onMontos: (f: "punto" | "coma" | undefined) => void;
  onGuardado: (id: string) => void;
  onNombre: (t: string) => void;
  onGuardar: () => void;
  onRevisar: () => void;
  onOtro: () => void;
}) {
  const { tabla, mapeo } = props;
  const faltan = faltantesMapeo(mapeo, tabla.encabezados);
  const formatos = formatosNumeros(tabla, mapeo);
  const avisos = avisosMapeo(mapeo);
  return (
    <Card>
      <CardHeader>
        <CardTitle>2. ¿Qué columna es cada dato?</CardTitle>
        <CardDescription className="break-words">
          {props.nombre}: {tabla.filas.length.toLocaleString("es-MX")} filas. Revisa la propuesta; con un mapeo guardado se elige solo.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {tabla.avisos.map((a) => (
          <p key={a} className="text-xs text-muted-foreground">
            {a}
          </p>
        ))}
        {props.guardados.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pos-guardado">Mapeo guardado</Label>
            <select id="pos-guardado" className={CLASE_SELECT} value={props.mapeoId ?? ""} onChange={(e) => props.onGuardado(e.target.value)}>
              <option value="">— Ninguno (ajustado a mano) —</option>
              {props.guardados.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nombre}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {CAMPOS_POS.map((c) => {
            const col = mapeo.columnas[c.campo] ?? "";
            const ej = col ? muestras(tabla, col, 2) : [];
            return (
              <div key={c.campo} className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`pos-campo-${c.campo}`}>
                  {c.etiqueta}
                  {c.nivel === "requerido" && <span className="text-status-err"> *</span>}
                </Label>
                <select id={`pos-campo-${c.campo}`} className={CLASE_SELECT} value={col} onChange={(e) => props.onColumna(c.campo, e.target.value)}>
                  <option value="">— No viene —</option>
                  {tabla.encabezados.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                <span className="truncate text-xs text-muted-foreground">{ej.length ? `Ej.: ${ej.join(" · ")}` : c.ayuda}</span>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pos-formato-fecha">Las fechas vienen como</Label>
          <select
            id="pos-formato-fecha"
            className={CLASE_SELECT}
            value={mapeo.formato_fecha ?? "dmy"}
            onChange={(e) => props.onFormato(e.target.value === "mdy" ? "mdy" : "dmy")}
          >
            <option value="dmy">Día/mes/año (25/11/2026)</option>
            <option value="mdy">Mes/día/año (11/25/2026)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pos-formato-montos">Los montos usan</Label>
          <select
            id="pos-formato-montos"
            className={CLASE_SELECT}
            value={mapeo.formato_montos ?? ""}
            onChange={(e) => props.onMontos(e.target.value === "punto" || e.target.value === "coma" ? e.target.value : undefined)}
          >
            <option value="">
              {formatos.detectado === "punto"
                ? "Automático: punto decimal (1,234.50)"
                : formatos.detectado === "coma"
                  ? "Automático: coma decimal (1.234,50)"
                  : "Automático (según los valores)"}
            </option>
            <option value="punto">Punto decimal (1,234.50)</option>
            <option value="coma">Coma decimal (1.234,50)</option>
          </select>
          {!mapeo.formato_montos && formatos.detectado === "mixto" && (
            <span className="text-xs text-status-warn">Los montos mezclan punto y coma decimal: elige uno o revisa el archivo.</span>
          )}
        </div>
        {avisos.map((a) => (
          <p key={a} role="note" className="text-sm text-status-warn">
            {a}
          </p>
        ))}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pos-nombre-mapeo">Guardar este mapeo para la próxima vez</Label>
          <div className="flex gap-2">
            <Input
              id="pos-nombre-mapeo"
              value={props.nombreMapeo}
              maxLength={60}
              placeholder="Nombre de tu POS"
              onChange={(e) => props.onNombre(e.target.value)}
              className="h-10"
            />
            <Button type="button" variant="outline" className="h-10" disabled={props.ocupado || faltan.length > 0} onClick={props.onGuardar}>
              Guardar
            </Button>
          </div>
        </div>
        {faltan.length > 0 && <p className="text-sm text-status-warn">Falta: {faltan.join(", ")}.</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="h-10" disabled={props.ocupado || faltan.length > 0} onClick={props.onRevisar}>
            {props.ocupado ? "Revisando…" : "3. Revisar ventas"}
          </Button>
          <Button type="button" variant="outline" className="h-10" onClick={props.onOtro}>
            Otro archivo
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const TEXTO_ESTADO: Record<string, string> = { ligada: "Ligada" };

function PasoRevision(props: {
  nombre: string;
  revisado: ResultadoNormalizar;
  preparadas: Map<number, LineaPreparada>;
  yaImportado: string | null;
  asignadas: Map<number, string>;
  onAsignar: (lineas: number[], cuenta: string | null) => void;
  filtro: Filtro;
  onFiltro: (f: Filtro) => void;
  aceptoOmitir: boolean;
  onAceptoOmitir: (v: boolean) => void;
  ocupado: boolean;
  onImportar: () => void;
  onVolver: () => void;
}) {
  const { revisado, preparadas, asignadas } = props;
  const nuevas = revisado.ventas.filter((v) => !preparadas.get(v.linea)?.repetida);
  const repetidas = revisado.ventas.length - nuevas.length;
  const ligadas = nuevas.filter((v) => preparadas.get(v.linea)?.cuenta_id || asignadas.has(v.linea)).length;
  const totalNuevas = nuevas.reduce((a, v) => a + v.totalCentavos, 0);

  // Ventas nuevas sin cuenta, agrupadas por ticket, NOCHE y mesa (los folios
  // de muchos POS empiezan de nuevo cada día), con sus candidatas.
  const grupos = useMemo(() => {
    const m = new Map<
      string,
      { clave: string; ticket: string; noche: string; mesa: string; estado: string; lineas: number[]; total: number; candidatas: Candidata[] }
    >();
    for (const v of revisado.ventas) {
      const p = preparadas.get(v.linea);
      if (!p || p.repetida || p.cuenta_id) continue;
      const k = `${v.ticket}|${p.fecha_operacion}|${v.mesa ?? ""}|${p.estado}`;
      const g = m.get(k) ?? {
        clave: k,
        ticket: v.ticket,
        noche: p.fecha_operacion,
        mesa: p.mesa_numero ?? v.mesa ?? "",
        estado: p.estado,
        lineas: [],
        total: 0,
        candidatas: [],
      };
      g.lineas.push(v.linea);
      g.total += v.totalCentavos;
      for (const c of p.candidatos ?? []) if (!g.candidatas.some((x) => x.cuenta_id === c.cuenta_id)) g.candidatas.push(c);
      m.set(k, g);
    }
    return [...m.values()];
  }, [revisado.ventas, preparadas]);

  const conError = revisado.filas.filter((f) => f.errores.length);
  const conAviso = revisado.filas.filter((f) => !f.errores.length && f.avisos.length);
  const puedeImportar = nuevas.length > 0 && !props.yaImportado && (conError.length === 0 || props.aceptoOmitir);
  const filtros: { id: Filtro; etiqueta: string; n: number }[] = [
    { id: "error", etiqueta: "Con error", n: conError.length },
    { id: "sin_ligar", etiqueta: "Sin ligar", n: grupos.length },
    { id: "avisos", etiqueta: "Avisos", n: conAviso.length },
    { id: "todas", etiqueta: "Todas", n: revisado.ventas.length },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>3. Revisa antes de importar</CardTitle>
        <CardDescription className="break-words">{props.nombre}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3" data-testid="pos-resumen">
          <Dato titulo="Ventas nuevas" valor={nuevas.length.toLocaleString("es-MX")} />
          <Dato titulo="Total nuevo" valor={formatearCentavos(totalNuevas)} />
          <Dato titulo="Ya importadas" valor={repetidas.toLocaleString("es-MX")} />
          <Dato titulo="Ligadas a caja" valor={ligadas.toLocaleString("es-MX")} />
          <Dato titulo="Con error (no entran)" valor={conError.length.toLocaleString("es-MX")} tono={conError.length ? "err" : undefined} />
          <Dato titulo="Noches" valor={revisado.noches.map(etiquetaNoche).join(", ") || "—"} />
        </dl>
        {revisado.ignoradas > 0 && (
          <p className="text-xs text-muted-foreground">
            {revisado.ignoradas === 1 ? "Se ignora 1 fila de totales del reporte." : `Se ignoran ${revisado.ignoradas} filas de totales del reporte.`}
          </p>
        )}
        {props.yaImportado && (
          <p role="alert" className="text-sm text-status-warn">
            Este mismo archivo ya se importó. Para corregirlo, deshaz esa importación en «Importaciones» y vuelve a subirlo.
          </p>
        )}

        <div role="tablist" aria-label="Filtrar líneas" className="flex flex-wrap gap-2">
          {filtros.map((f) => (
            <Button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={props.filtro === f.id}
              variant={props.filtro === f.id ? "default" : "outline"}
              className="h-10"
              onClick={() => props.onFiltro(f.id)}
            >
              {f.etiqueta} ({f.n.toLocaleString("es-MX")})
            </Button>
          ))}
        </div>

        {props.filtro === "error" && <ListaFilas filas={conError} vacio="Ninguna línea con error." tipo="error" />}
        {props.filtro === "avisos" && <ListaFilas filas={conAviso} vacio="Sin avisos." tipo="aviso" />}
        {props.filtro === "sin_ligar" &&
          (grupos.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todas las ventas nuevas quedan ligadas a una cuenta de caja.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {grupos.slice(0, 100).map((g) => {
                const elegida = asignadas.get(g.lineas[0]) ?? "";
                return (
                  <li key={g.clave} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium break-all">
                        Ticket {g.ticket}
                        {g.mesa && ` · Mesa ${g.mesa}`}
                        {revisado.noches.length > 1 && ` · ${etiquetaNoche(g.noche)}`}
                      </span>
                      <span className="tabular-nums">{formatearCentavos(g.total)}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{MOTIVO_SIN_LIGAR[g.estado] ?? g.estado}</span>
                    {g.candidatas.length > 0 ? (
                      <select
                        aria-label={`Cuenta para el ticket ${g.ticket}`}
                        className={CLASE_SELECT}
                        value={elegida}
                        onChange={(e) => props.onAsignar(g.lineas, e.target.value || null)}
                      >
                        <option value="">Dejar sin ligar (se puede asignar después)</option>
                        {g.candidatas.map((c) => (
                          <option key={c.cuenta_id} value={c.cuenta_id}>
                            {c.cliente_nombre} · Mesa {c.mesa_numero}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-muted-foreground">Queda sin ligar; se puede asignar después en la conciliación.</span>
                    )}
                  </li>
                );
              })}
              {grupos.length > 100 && <li className="text-xs text-muted-foreground">y {grupos.length - 100} tickets más…</li>}
            </ul>
          ))}
        {props.filtro === "todas" && (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {revisado.ventas.slice(0, 200).map((v) => {
              const p = preparadas.get(v.linea);
              return (
                <li key={v.linea} className="flex flex-col gap-0.5 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">
                      L{v.linea} · {v.ticket} · {v.producto}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatearCentavos(v.totalCentavos)}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {v.fechaHora.replace("T", " ").slice(0, 16)} · {v.mesa ? `Mesa ${v.mesa}` : "Sin mesa"} ·{" "}
                    {p?.repetida ? "Ya importada" : p?.cuenta_id || asignadas.has(v.linea) ? TEXTO_ESTADO.ligada : "Sin ligar"}
                  </span>
                </li>
              );
            })}
            {revisado.ventas.length > 200 && <li className="py-2 text-xs text-muted-foreground">y {revisado.ventas.length - 200} más…</li>}
          </ul>
        )}

        {conError.length > 0 && nuevas.length > 0 && (
          <label className="flex min-h-10 items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 size-5" checked={props.aceptoOmitir} onChange={(e) => props.onAceptoOmitir(e.target.checked)} />
            <span>
              Importar sin las {conError.length} líneas con error (no se guardan; corrígelas en el archivo y vuelve a subirlo: las que ya entraron no se
              duplican).
            </span>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="h-10" disabled={!puedeImportar || props.ocupado} onClick={props.onImportar}>
            {props.ocupado ? "Importando…" : `Importar ${nuevas.length.toLocaleString("es-MX")} ventas`}
          </Button>
          <Button type="button" variant="outline" className="h-10" onClick={props.onVolver}>
            Cambiar el mapeo
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Dato({ titulo, valor, tono }: { titulo: string; valor: string; tono?: "err" }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted-foreground">{titulo}</dt>
      <dd className={cn("font-semibold tabular-nums break-words", tono === "err" && "text-status-err")}>{valor}</dd>
    </div>
  );
}

function ListaFilas({ filas, vacio, tipo }: { filas: ResultadoNormalizar["filas"]; vacio: string; tipo: "error" | "aviso" }) {
  if (!filas.length) return <p className="text-sm text-muted-foreground">{vacio}</p>;
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {filas.slice(0, 200).map((f) => (
        <li key={f.linea} className="flex items-start gap-2">
          <Badge variant={tipo === "error" ? "err" : "warn"}>Línea {f.linea}</Badge>
          <span className="min-w-0 break-words">{(tipo === "error" ? f.errores : f.avisos).join(" · ")}</span>
        </li>
      ))}
      {filas.length > 200 && <li className="text-xs text-muted-foreground">y {filas.length - 200} más…</li>}
    </ul>
  );
}
