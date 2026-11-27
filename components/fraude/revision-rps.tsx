"use client";

// Revisión de RPs (antifraude): alertas por antro con filtros, detalle con
// evidencia y acciones (descartar / confirmar / volver a revisar) con nota
// obligatoria, y la configuración de reglas. La usan el gerente
// (/staff/revision), el dueño y el dueño de grupo (/dueno/revision) y el
// admin (/admin/revision). La base vuelve a revisar permiso y bandera en
// cada llamada (sql/post-junta-3/30-antifraude-rps.sql).
//
// Al abrir solo se LISTAN las alertas guardadas; buscar nuevas es un botón
// (la base deja una búsqueda cada 2 minutos por antro).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ESTADOS_ALERTA,
  NOMBRE_ESTADO,
  NOMBRE_REGLA,
  REGLAS_FRAUDE,
  enmascararTexto,
  esEstadoAlerta,
  esReglaFraude,
  explicarRegla,
  transicionesDe,
  validarNota,
  type EstadoAlerta,
  type ReglaFraude,
} from "@/lib/domain/fraude";
import {
  POR_PAGINA,
  cambiarAlerta,
  detalleAlerta,
  detectarAlertas,
  listarAlertas,
  misAntrosRevision,
  rpsDeAlertas,
  ultimaDeteccion,
  type AlertaDetalle,
  type AlertaLista,
  type AntroRevision,
  type ResumenDeteccion,
  type UltimaDeteccion,
} from "@/lib/fraude";
import { etiquetaNoche, nocheOperativaEn, sumarDiasISO } from "@/lib/fechas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EvidenciaAlerta, formatoFechaHora } from "./evidencia-alerta";
import { ReglasFraude } from "./reglas-fraude";

const SELECT = "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";
const VARIANTE_ESTADO: Record<EstadoAlerta, "warn" | "neutral" | "err"> = { revisar: "warn", descartada: "neutral", confirmada: "err" };
const ACCION: Record<EstadoAlerta, string> = { descartada: "Descartar", confirmada: "Confirmar", revisar: "Volver a revisar" };
const NOCHES_POR_DEFECTO = 14;

function ventanaTexto(a: { regla: ReglaFraude; ventana_inicio: string; ventana_fin: string }) {
  if (a.ventana_inicio !== a.ventana_fin) return `Semana ${etiquetaNoche(a.ventana_inicio)} – ${etiquetaNoche(a.ventana_fin)}`;
  return a.regla === "cliente_repetido" ? `Llegó el ${etiquetaNoche(a.ventana_inicio)}` : `Noche del ${etiquetaNoche(a.ventana_inicio)}`;
}

function EstadoBadge({ estado, yaNoAplica }: { estado: EstadoAlerta; yaNoAplica?: boolean }) {
  return (
    <>
      <Badge variant={VARIANTE_ESTADO[estado]}>{NOMBRE_ESTADO[estado]}</Badge>
      {yaNoAplica && estado === "revisar" && <Badge variant="neutral">Ya no se cumple</Badge>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Detalle de una alerta
// ---------------------------------------------------------------------------
function DetalleAlerta({ alertaId, zona, onVolver }: { alertaId: string; zona: string; onVolver: () => void }) {
  const [alerta, setAlerta] = useState<AlertaDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notaTexto, setNotaTexto] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const fechaHora = formatoFechaHora(zona);

  const cargar = useCallback(async () => {
    const r = await detalleAlerta(alertaId);
    if (!r.ok) {
      setError(r.mensaje);
      return;
    }
    setError(null);
    setAlerta(r.datos);
  }, [alertaId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function cambiar(estado: EstadoAlerta) {
    const invalida = validarNota(notaTexto);
    if (invalida) {
      setAviso(invalida);
      return;
    }
    setGuardando(true);
    setAviso(null);
    const r = await cambiarAlerta(alertaId, estado, notaTexto.trim());
    setGuardando(false);
    if (!r.ok) {
      setAviso(r.mensaje);
      return;
    }
    setNotaTexto("");
    await cargar();
  }

  const volver = (
    <Button type="button" variant="outline" className="h-10 self-start" onClick={onVolver}>
      ← Volver a la lista
    </Button>
  );
  if (error) {
    return (
      <div className="flex flex-col gap-3">
        {volver}
        <p className="text-sm break-words text-destructive" role="alert">{error}</p>
        <Button type="button" variant="outline" className="h-10 self-start" onClick={cargar}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (!alerta) {
    return (
      <div className="flex flex-col gap-3">
        {volver}
        <p className="text-sm text-muted-foreground">Cargando alerta...</p>
      </div>
    );
  }
  const regla = alerta.regla;
  const parametros = (alerta.evidencia.parametros ?? {}) as Record<string, number>;
  const rpNombre = alerta.rp_nombre ?? (typeof alerta.evidencia.rp_nombre === "string" ? alerta.evidencia.rp_nombre : null);

  return (
    <div className="flex flex-col gap-4">
      {volver}
      <Card size="sm">
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 text-lg font-semibold break-words">{NOMBRE_REGLA[regla]}</h2>
            <EstadoBadge estado={alerta.estado} yaNoAplica={Boolean(alerta.ya_no_aplica_en)} />
          </div>
          <p className="text-sm text-muted-foreground">
            {ventanaTexto(alerta)}
            {rpNombre ? ` · RP: ${rpNombre}` : ""}
          </p>
          {alerta.ya_no_aplica_en && alerta.estado === "revisar" && (
            <p className="text-sm text-status-warn" role="status">
              En la búsqueda del {fechaHora(alerta.ya_no_aplica_en)} esto ya no se cumplía (cambiaron los datos o los
              umbrales). Abajo está la evidencia de cuando sí se cumplía.
            </p>
          )}
          <p className="text-sm font-medium break-words">{alerta.resumen}</p>
          <EvidenciaAlerta regla={regla} evidencia={alerta.evidencia} zona={zona} />
          <details className="text-sm">
            <summary className="flex min-h-10 cursor-pointer items-center font-medium">Cómo se calcula</summary>
            <p className="text-muted-foreground">{explicarRegla(regla, parametros)}</p>
            <p className="mt-2 text-muted-foreground">
              Una alerta solo señala un caso para revisar; no prueba un abuso. Revísalo con el RP y el equipo antes de
              decidir.
            </p>
          </details>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardContent className="flex flex-col gap-3 px-4">
          <h3 className="font-semibold">Tu revisión</h3>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nota_revision">Nota (obligatoria)</Label>
            <textarea
              id="nota_revision"
              rows={3}
              maxLength={1000}
              className="min-h-20 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
              placeholder="Qué revisaste y por qué decides esto"
              value={notaTexto}
              onChange={(e) => setNotaTexto(e.target.value)}
            />
            <span className="text-xs text-muted-foreground">Los teléfonos que escribas se guardan como ******1234.</span>
          </div>
          {aviso && (
            <p className="text-sm break-words text-destructive" role="alert">{aviso}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {transicionesDe(alerta.estado).map((destino) => (
              <Button
                key={destino}
                type="button"
                variant={destino === "confirmada" ? "destructive" : "outline"}
                className="h-10"
                disabled={guardando}
                onClick={() => cambiar(destino)}
              >
                {ACCION[destino]}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">Historial</h3>
        <ul className="flex flex-col text-sm">
          <li className="border-b border-border py-2">
            Detectada · {fechaHora(alerta.creada_en)}
            {alerta.actualizada_en !== alerta.creada_en && (
              <span className="block text-xs text-muted-foreground">Evidencia actualizada · {fechaHora(alerta.actualizada_en)}</span>
            )}
          </li>
          {alerta.cambios.map((c, i) => (
            <li key={i} className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0">
              <span className="font-medium">
                {NOMBRE_ESTADO[c.de]} → {NOMBRE_ESTADO[c.a]}
              </span>
              <span className="break-words">«{enmascararTexto(c.nota)}»</span>
              <span className="text-xs text-muted-foreground">
                {c.hecho_por_nombre ?? "Administración"} · {fechaHora(c.hecho_en)}
              </span>
              <details>
                <summary className="flex min-h-10 cursor-pointer items-center text-xs font-medium">
                  Evidencia con la que se decidió
                </summary>
                <p className="mb-2 text-xs break-words">{c.resumen}</p>
                <EvidenciaAlerta regla={regla} evidencia={c.evidencia} zona={zona} />
              </details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alertas de un antro
// ---------------------------------------------------------------------------
function textoResumen(r: ResumenDeteccion): string[] {
  const suma = (k: "nuevas" | "actualizadas" | "ya_no_aplican") => REGLAS_FRAUDE.reduce((s, x) => s + (r.reglas[x]?.[k] ?? 0), 0);
  const nuevas = suma("nuevas"), actualizadas = suma("actualizadas"), yaNo = suma("ya_no_aplican");
  const lineas = [
    `Revisado del ${etiquetaNoche(r.desde)} al ${etiquetaNoche(r.hasta)}: ${nuevas} alerta(s) nueva(s)` +
      `${actualizadas ? `, ${actualizadas} con evidencia nueva` : ""}${yaNo ? `, ${yaNo} que ya no se cumplen` : ""}.`,
  ];
  const apagadas = REGLAS_FRAUDE.filter((k) => r.reglas[k] && !r.reglas[k].activa).map((k) => NOMBRE_REGLA[k]);
  if (apagadas.length) lineas.push(`Apagadas en este antro: ${apagadas.join(", ")}.`);
  const ilegibles = r.telefonos?.ilegibles ?? 0;
  const sinTel = r.telefonos?.sin_telefono ?? 0;
  if (ilegibles || sinTel) {
    lineas.push(
      `Cliente repetido no pudo revisar ${ilegibles + sinTel} reserva(s) de RP: ${ilegibles} con teléfono que no se entiende y ${sinTel} sin teléfono.`,
    );
  }
  const sinMuestra = r.reglas.consumo_atipico?.semanas_sin_muestra ?? [];
  if (r.reglas.consumo_atipico?.activa && sinMuestra.length) {
    lineas.push(`Consumo atípico: ${sinMuestra.length} semana(s) sin cuentas suficientes para calcular la mediana del antro; esas semanas no se revisaron.`);
  }
  return lineas;
}

type Filtros = { estado: EstadoAlerta | ""; regla: ReglaFraude | ""; rp: string; desde: string; hasta: string };

function AlertasAntro({ antro }: { antro: AntroRevision }) {
  const hoy = nocheOperativaEn(antro.zona_horaria);
  const [filtros, setFiltros] = useState<Filtros>({
    estado: "revisar",
    regla: "",
    rp: "",
    desde: sumarDiasISO(hoy, -(NOCHES_POR_DEFECTO - 1)),
    hasta: hoy,
  });
  const [rps, setRps] = useState<{ rp_id: string; nombre: string }[]>([]);
  const [alertas, setAlertas] = useState<AlertaLista[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [errorBusqueda, setErrorBusqueda] = useState<string | null>(null);
  const [ultima, setUltima] = useState<UltimaDeteccion | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const ultimaPeticion = useRef(0);
  const fechaHora = formatoFechaHora(antro.zona_horaria);

  const cambiarFiltro = (cambio: Partial<Filtros>) => setFiltros((f) => ({ ...f, ...cambio }));
  const consulta = (f: Filtros) => ({
    estado: f.estado || null,
    regla: f.regla || null,
    rpId: f.rp || null,
    desde: f.desde || null,
    hasta: f.hasta || null,
  });

  // Lista (primera página). No busca alertas nuevas.
  const listar = useCallback(async () => {
    const n = ++ultimaPeticion.current;
    setErrorLista(null);
    const [l, r] = await Promise.all([listarAlertas(antro.club_id, consulta(filtros)), rpsDeAlertas(antro.club_id)]);
    if (n !== ultimaPeticion.current) return;
    if (!l.ok) {
      setErrorLista(l.mensaje);
      return;
    }
    const datos = l.datos ?? [];
    setAlertas(datos);
    setTotal(datos.length ? Number(datos[0].total) : 0);
    if (r.ok) setRps(r.datos ?? []);
  }, [antro.club_id, filtros]);

  async function verMas() {
    if (!alertas) return;
    setCargandoMas(true);
    const l = await listarAlertas(antro.club_id, consulta(filtros), alertas.length);
    setCargandoMas(false);
    if (!l.ok) {
      setErrorLista(l.mensaje);
      return;
    }
    const nuevas = (l.datos ?? []).filter((a) => !alertas.some((b) => b.id === a.id));
    setAlertas([...alertas, ...nuevas]);
    if (l.datos?.length) setTotal(Number(l.datos[0].total));
  }

  const cargarUltima = useCallback(async () => {
    const u = await ultimaDeteccion(antro.club_id);
    if (u.ok) setUltima(u.datos);
  }, [antro.club_id]);

  useEffect(() => {
    listar();
  }, [listar]);
  useEffect(() => {
    cargarUltima();
  }, [cargarUltima]);

  async function buscar() {
    if (!filtros.desde || !filtros.hasta || filtros.desde > filtros.hasta) {
      setErrorBusqueda("Elige un rango de noches válido.");
      return;
    }
    setBuscando(true);
    setErrorBusqueda(null);
    const d = await detectarAlertas(antro.club_id, filtros.desde, filtros.hasta);
    setBuscando(false);
    if (!d.ok) {
      setErrorBusqueda(d.mensaje);
      return;
    }
    await Promise.all([listar(), cargarUltima()]);
  }

  if (abierta) {
    return (
      <DetalleAlerta
        alertaId={abierta}
        zona={antro.zona_horaria}
        onVolver={() => {
          setAbierta(null);
          listar();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="fraude_desde">Desde la noche</Label>
          <Input
            id="fraude_desde"
            type="date"
            className="h-10"
            value={filtros.desde}
            max={filtros.hasta}
            onChange={(e) => cambiarFiltro({ desde: e.target.value })}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="fraude_hasta">Hasta la noche</Label>
          <Input
            id="fraude_hasta"
            type="date"
            className="h-10"
            value={filtros.hasta}
            min={filtros.desde}
            max={sumarDiasISO(hoy, 1)}
            onChange={(e) => cambiarFiltro({ hasta: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Button type="button" className="h-10 w-full" disabled={buscando} onClick={buscar}>
          {buscando ? "Buscando alertas..." : "Buscar alertas nuevas en estas noches"}
        </Button>
        <p className="text-xs text-muted-foreground">
          {ultima
            ? `Última búsqueda: ${fechaHora(ultima.hecho_en)}${ultima.hecho_por_nombre ? ` por ${ultima.hecho_por_nombre}` : ""} (del ${etiquetaNoche(ultima.desde)} al ${etiquetaNoche(ultima.hasta)}). Se puede buscar una vez cada 2 minutos.`
            : "Todavía nadie ha buscado alertas en este antro. Se puede buscar una vez cada 2 minutos."}
        </p>
      </div>
      {errorBusqueda && (
        <p className="text-sm break-words text-destructive" role="alert">{errorBusqueda}</p>
      )}
      {ultima?.resumen && !errorBusqueda && (
        <div className="flex flex-col gap-1 text-sm text-muted-foreground" role="status">
          {textoResumen(ultima.resumen).map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="fraude_estado">Estado</Label>
          <select
            id="fraude_estado"
            className={SELECT}
            value={filtros.estado}
            onChange={(e) => cambiarFiltro({ estado: esEstadoAlerta(e.target.value) ? e.target.value : "" })}
          >
            <option value="">Todos</option>
            {ESTADOS_ALERTA.map((e) => (
              <option key={e} value={e}>{NOMBRE_ESTADO[e]}</option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="fraude_regla">Regla</Label>
          <select
            id="fraude_regla"
            className={SELECT}
            value={filtros.regla}
            onChange={(e) => cambiarFiltro({ regla: esReglaFraude(e.target.value) ? e.target.value : "" })}
          >
            <option value="">Todas</option>
            {REGLAS_FRAUDE.map((r) => (
              <option key={r} value={r}>{NOMBRE_REGLA[r]}</option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="fraude_rp">RP</Label>
          <select id="fraude_rp" className={SELECT} value={filtros.rp} onChange={(e) => cambiarFiltro({ rp: e.target.value })}>
            <option value="">Todos</option>
            {rps.map((r) => (
              <option key={r.rp_id} value={r.rp_id}>{r.nombre}</option>
            ))}
          </select>
        </div>
      </div>

      {errorLista && (
        <div className="flex flex-col gap-2">
          <p className="text-sm break-words text-destructive" role="alert">{errorLista}</p>
          <Button type="button" variant="outline" className="h-10 self-start" onClick={listar}>
            Reintentar
          </Button>
        </div>
      )}
      {!errorLista && alertas === null && <p className="text-sm text-muted-foreground">Cargando alertas...</p>}
      {!errorLista && alertas !== null && alertas.length === 0 && (
        <p className="text-sm text-muted-foreground">No hay alertas con estos filtros en esas noches.</p>
      )}
      {!errorLista && alertas !== null && alertas.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Mostrando {alertas.length} de {total} alerta(s).
          </p>
          <ul className="flex flex-col gap-3" aria-label="Alertas">
            {alertas.map((a) => (
              <li key={a.id}>
                <Card size="sm">
                  <CardContent className="flex flex-col gap-2 px-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 font-semibold break-words">{NOMBRE_REGLA[a.regla]}</span>
                      <EstadoBadge estado={a.estado} yaNoAplica={Boolean(a.ya_no_aplica_en)} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {ventanaTexto(a)}
                      {a.rp_nombres.length > 0 ? ` · ${a.rp_nombres.join(", ")}` : ""}
                    </p>
                    <p className="text-sm break-words">{a.resumen}</p>
                    {a.revisada_en && (
                      <p className="text-xs text-muted-foreground">
                        Revisada por {a.revisada_por_nombre ?? "Administración"} · {fechaHora(a.revisada_en)}
                      </p>
                    )}
                    <Button type="button" variant="outline" className="h-10 self-start" onClick={() => setAbierta(a.id)}>
                      Ver detalle
                    </Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
          {alertas.length < total && (
            <Button type="button" variant="outline" className="h-10 w-full" disabled={cargandoMas} onClick={verMas}>
              {cargandoMas ? "Cargando..." : `Ver ${Math.min(POR_PAGINA, total - alertas.length)} más`}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

function RevisionAntro({ antro }: { antro: AntroRevision }) {
  const [vista, setVista] = useState<"alertas" | "reglas">("alertas");
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Secciones">
        {(["alertas", "reglas"] as const).map((v) => (
          <Button
            key={v}
            type="button"
            role="tab"
            aria-selected={vista === v}
            variant={vista === v ? "default" : "outline"}
            className="h-10 w-full"
            onClick={() => setVista(v)}
          >
            {v === "alertas" ? "Alertas" : "Reglas y umbrales"}
          </Button>
        ))}
      </div>
      {vista === "alertas" ? <AlertasAntro antro={antro} /> : <ReglasFraude clubId={antro.club_id} zona={antro.zona_horaria} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------
type Estado =
  | { tipo: "cargando" }
  | { tipo: "error"; mensaje: string }
  | { tipo: "sin_permiso" }
  | { tipo: "inactiva" }
  | { tipo: "listo"; antros: AntroRevision[] };

export function RevisionRps({ volverHref }: { volverHref: string }) {
  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });
  const [clubId, setClubId] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setEstado({ tipo: "cargando" });
    const r = await misAntrosRevision();
    if (!r.ok) {
      setEstado({ tipo: "error", mensaje: r.mensaje });
      return;
    }
    const todos = r.datos ?? [];
    // Sin ningún antro: la cuenta no puede revisar (dada de baja, contraseña
    // temporal u otro rol). Con antros pero ninguno encendido: no está activa.
    if (todos.length === 0) {
      setEstado({ tipo: "sin_permiso" });
      return;
    }
    const antros = todos.filter((a) => a.activa);
    if (antros.length === 0) {
      setEstado({ tipo: "inactiva" });
      return;
    }
    setClubId((actual) => (actual && antros.some((a) => a.club_id === actual) ? actual : antros[0].club_id));
    setEstado({ tipo: "listo", antros });
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const antros = estado.tipo === "listo" ? estado.antros : [];
  const antro = antros.find((a) => a.club_id === clubId) ?? null;

  return (
    <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
      <Link
        href={volverHref}
        className="inline-flex min-h-10 w-fit items-center text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        ← Panel
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="break-words text-2xl font-semibold tracking-tight">
          Revisión de RPs{antro && antros.length === 1 ? ` · ${antro.nombre}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          Casos que conviene revisar: clientes que pasan de un RP a otro, ráfagas de reservas y consumos fuera de lo
          normal. Los RPs no ven esta pantalla.
        </p>
      </div>

      {estado.tipo === "cargando" && <p className="text-sm text-muted-foreground">Cargando...</p>}
      {estado.tipo === "error" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm break-words text-destructive" role="alert">{estado.mensaje}</p>
          <Button type="button" variant="outline" className="h-10 self-start" onClick={cargar}>
            Reintentar
          </Button>
        </div>
      )}
      {estado.tipo === "sin_permiso" && (
        <Card size="sm">
          <CardContent className="px-4 text-sm">
            Tu cuenta no tiene permiso para revisar RPs en este momento. Si te pidieron cambiar la contraseña, cámbiala
            y vuelve a entrar; si te dieron de baja, habla con el dueño del antro.
          </CardContent>
        </Card>
      )}
      {estado.tipo === "inactiva" && (
        <Card size="sm">
          <CardContent className="px-4 text-sm">
            La revisión de RPs no está activa para tu antro. La enciende AntroApp por antro.
          </CardContent>
        </Card>
      )}
      {antros.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fraude_antro">Antro</Label>
          <select id="fraude_antro" className={SELECT} value={clubId ?? ""} onChange={(e) => setClubId(e.target.value)}>
            {antros.map((a) => (
              <option key={a.club_id} value={a.club_id}>{a.nombre}</option>
            ))}
          </select>
        </div>
      )}
      {/* key: al cambiar de antro se reinicia todo (no se mezclan datos). */}
      {antro && <RevisionAntro key={antro.club_id} antro={antro} />}
    </div>
  );
}
