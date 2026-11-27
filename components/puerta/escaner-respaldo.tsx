"use client";

// Escáner de la puerta con respaldo (bandera `escaner_respaldo`). Con la
// bandera apagada el panel usa su escáner de siempre y este no se monta.
//
// Lo mismo que el escáner de siempre (cámara, linterna, ficha, "Confirmar
// entrada"), más:
//  - código a mano: el código corto del boleto (6 caracteres) o el código o
//    enlace completo pegado. Con señal va a la base (puerta_escanear_codigo
//    o puerta_escanear), por el mismo camino que la cámara;
//  - sin señal: valida contra la copia de esta noche guardada en el teléfono
//    (lib/puerta-respaldo.ts), guarda la entrada como "pendiente de enviar" y
//    se manda sola al volver la señal (components/puerta/envio-puerta.tsx).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Html5Qrcode } from "html5-qrcode";
import { CloudOff, KeyRound } from "lucide-react";
import { BotonLinterna } from "@/components/boton-linterna";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import { esErrorDeRed, mensajeParaUsuario, type ErrorBase } from "@/lib/errores-base";
import { conLimite } from "@/lib/domain/caja-cola";
import {
  buscarPorCodigo,
  buscarPorHuella,
  copiaVencida,
  copiaVieja,
  crearEntrada,
  leerCodigoEscrito,
  type ReservaCopia,
} from "@/lib/domain/puerta-respaldo";
import { guardarEntrada, huellaDe, marcarEntroEnCopia } from "@/lib/puerta-respaldo";
import { enviarPendientesPuerta, useCopiaPuerta, useEntradasPuerta, useSesionUsuario } from "@/lib/use-puerta-respaldo";
import { useEnLinea } from "@/lib/use-en-linea";

// Id propio: nunca comparte elemento con el lector del escáner de siempre.
const LECTOR_ID = "qr-reader-respaldo";
const LIMITE_PUERTA_MS = 10_000;

// Varias reservas de esta noche con el mismo código corto (lo dice la base,
// con el nombre recortado): se elige viendo la identificación.
interface Opcion {
  reservation_id: string;
  nombre: string;
  personas: number;
}
function leerOpciones(data: unknown): Opcion[] | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.ambiguo !== true || !Array.isArray(d.opciones)) return null;
  const xs = (d.opciones as Record<string, unknown>[]).filter(
    (o) => typeof o?.reservation_id === "string" && typeof o?.nombre === "string" && typeof o?.personas === "number",
  );
  return xs.map((o) => ({ reservation_id: o.reservation_id as string, nombre: o.nombre as string, personas: o.personas as number }));
}

interface Ficha {
  reservation_id: string;
  cliente_nombre: string;
  personas: number;
  source: "organica" | "rp";
  rp_nombre: string | null;
}

type Origen = "camara" | "codigo";
type Modo = "en_linea" | "sin_senal";

type Estado =
  | { f: "escaneando" }
  | { f: "buscando" }
  | { f: "error"; mensaje: string }
  | { f: "varias"; reservas: ReservaCopia[]; origen: Origen }
  | { f: "opciones"; codigo: string; opciones: Opcion[] }
  | { f: "lista"; ficha: Ficha; modo: Modo; origen: Origen; error?: string }
  | { f: "confirmada"; ficha: Ficha; modo: Modo };

function leerFicha(data: unknown): Ficha | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.reservation_id !== "string" || typeof d.cliente_nombre !== "string" || typeof d.personas !== "number") return null;
  return {
    reservation_id: d.reservation_id,
    cliente_nombre: d.cliente_nombre,
    personas: d.personas,
    source: d.source === "rp" ? "rp" : "organica",
    rp_nombre: typeof d.rp_nombre === "string" ? d.rp_nombre : null,
  };
}

function fichaDeCopia(r: ReservaCopia): Ficha {
  return {
    reservation_id: r.reservation_id,
    cliente_nombre: r.cliente_nombre ?? "—",
    personas: r.personas,
    source: r.source,
    rp_nombre: r.rp_nombre,
  };
}

const personas = (n: number) => `${n} ${n === 1 ? "persona" : "personas"}`;
const hora = (iso: string) => new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Respuesta de supabase-js con límite: con mala señal no se queda girando.
type Resp = { data: unknown; error: ErrorBase };
function llamar(p: PromiseLike<{ data: unknown; error: unknown }>): Promise<Resp> {
  return conLimite(
    Promise.resolve(p).then(
      ({ data, error }) => ({ data, error: error as ErrorBase }),
      (e: unknown) => ({ data: null, error: { message: e instanceof Error ? e.message : "fetch failed" } }),
    ),
    LIMITE_PUERTA_MS,
    { data: null, error: { message: "timeout" } },
  );
}

export function EscanerRespaldo({
  clubId,
  onCerrar,
  onEntrada,
}: {
  clubId: string;
  onCerrar: () => void;
  onEntrada: () => void;
}) {
  const enLinea = useEnLinea();
  const { usuarioId } = useSesionUsuario();
  const { copia } = useCopiaPuerta({ usuarioId, clubId, activa: true, listo: true });
  const { entradas, persistente } = useEntradasPuerta(usuarioId);
  const [estado, setEstado] = useState<Estado>({ f: "escaneando" });
  const [confirmando, setConfirmando] = useState(false);
  const [codigo, setCodigo] = useState("");
  const [errorCodigo, setErrorCodigo] = useState<string | null>(null);
  const [camaraError, setCamaraError] = useState<string | null>(null);
  const [camaraLista, setCamaraLista] = useState(false);
  const lectorRef = useRef<Html5Qrcode | null>(null);
  const candado = useRef(false);
  // El lector llama siempre a la versión de este render (copia y cola al día).
  const alLeerRef = useRef<(texto: string) => void>(() => {});

  // ---------- Buscar ----------

  async function buscarLocal(
    entrada: { tipo: "qr"; qr: string } | { tipo: "corto"; codigo: string },
    origen: Origen,
  ): Promise<Estado> {
    const ahora = new Date();
    if (!copia) return { f: "error", mensaje: "Sin señal y sin copia de la noche en este teléfono: no se puede validar. Espera la señal o confirma desde otro teléfono." };
    if (copiaVencida(copia, ahora)) return { f: "error", mensaje: "La copia de la noche ya venció. Con señal se baja la nueva." };
    let b;
    if (entrada.tipo === "qr") {
      const h = await huellaDe(entrada.qr);
      if (!h) return { f: "error", mensaje: "Este navegador no permite validar sin señal. Espera la señal." };
      b = buscarPorHuella(copia, h);
    } else b = buscarPorCodigo(copia, entrada.codigo);
    if (b.tipo === "no_encontrada")
      return {
        f: "error",
        mensaje: `No está en la copia de esta noche (de las ${hora(copia.generadaEn)}). Puede ser de otro antro u otra noche, o una reserva hecha después${copia.truncada ? " (y la copia no trae todas las de la noche)" : ""}. Sin señal no se puede validar.`,
      };
    if (b.tipo === "varias") return { f: "varias", reservas: b.reservas, origen };
    return revisarLocal(b.reserva, origen);
  }

  function revisarLocal(r: ReservaCopia, origen: Origen): Estado {
    if (r.entro) return { f: "error", mensaje: `Esta reserva ya entró${r.entrada_en ? ` a las ${hora(r.entrada_en)}` : ""}.` };
    const previa = entradas.find((x) => x.reservationId === r.reservation_id && x.estado !== "rechazada");
    if (previa)
      return {
        f: "error",
        mensaje:
          previa.estado === "pendiente"
            ? `Ya la registraste en este teléfono a las ${hora(previa.escaneadoEn)}. Está pendiente de enviar: no la confirmes otra vez.`
            : `Esta reserva ya entró${previa.entradaEn ? ` a las ${hora(previa.entradaEn)}` : ""}.`,
      };
    return { f: "lista", ficha: fichaDeCopia(r), modo: "sin_senal", origen };
  }

  async function buscar(entrada: { tipo: "qr"; qr: string } | { tipo: "corto"; codigo: string }, origen: Origen) {
    setEstado({ f: "buscando" });
    if (navigator.onLine) {
      const supabase = createClient();
      const r =
        entrada.tipo === "qr"
          ? await llamar(supabase.rpc("puerta_escanear", { p_qr: entrada.qr }))
          : await llamar(supabase.rpc("puerta_escanear_codigo", { p_club_id: clubId, p_codigo: entrada.codigo }));
      if (!r.error) {
        const opciones = entrada.tipo === "corto" ? leerOpciones(r.data) : null;
        if (entrada.tipo === "corto" && opciones && opciones.length > 1) {
          setEstado({ f: "opciones", codigo: entrada.codigo, opciones });
          return;
        }
        const ficha = leerFicha(r.data);
        setEstado(ficha ? { f: "lista", ficha, modo: "en_linea", origen } : { f: "error", mensaje: "No pudimos leer la reserva. Intenta de nuevo." });
        return;
      }
      if (!esErrorDeRed(r.error)) {
        setEstado({ f: "error", mensaje: mensajeParaUsuario(r.error, "No pudimos leer el código. Intenta de nuevo.") });
        return;
      }
      // Sin respuesta: se valida con la copia del teléfono.
    }
    setEstado(await buscarLocal(entrada, origen));
  }

  // Con señal y código repetido: la elegida pasa por la base otra vez (que
  // revisa que coincida con el código, el antro y la noche).
  async function elegirOpcion(codigoCorto: string, reservationId: string) {
    setEstado({ f: "buscando" });
    const r = await llamar(
      createClient().rpc("puerta_escanear_codigo", { p_club_id: clubId, p_codigo: codigoCorto, p_reservation_id: reservationId }),
    );
    const ficha = r.error ? null : leerFicha(r.data);
    if (ficha) setEstado({ f: "lista", ficha, modo: "en_linea", origen: "codigo" });
    else
      setEstado({
        f: "error",
        mensaje: r.error ? mensajeParaUsuario(r.error, "No pudimos leer el código. Intenta de nuevo.") : "No pudimos leer la reserva. Intenta de nuevo.",
      });
  }

  alLeerRef.current = (texto: string) => {
    if (candado.current) return;
    candado.current = true;
    lectorRef.current?.pause(true);
    void buscar({ tipo: "qr", qr: texto.trim() }, "camara");
  };

  function siguiente() {
    candado.current = false;
    setEstado({ f: "escaneando" });
    try {
      lectorRef.current?.resume();
    } catch {
      // el lector no estaba en pausa
    }
  }

  function buscarCodigo(e: React.FormEvent) {
    e.preventDefault();
    const c = leerCodigoEscrito(codigo);
    if (c.tipo === "invalido") {
      setErrorCodigo(c.motivo);
      return;
    }
    setErrorCodigo(null);
    candado.current = true;
    try {
      lectorRef.current?.pause(true);
    } catch {
      // la cámara no está corriendo
    }
    void buscar(c.tipo === "completo" ? { tipo: "qr", qr: c.qr } : { tipo: "corto", codigo: c.codigo }, "codigo");
  }

  // ---------- Confirmar ----------

  async function guardarSinSenal(ficha: Ficha, origen: Origen) {
    if (!usuarioId) {
      setEstado({ f: "lista", ficha, modo: "sin_senal", origen, error: "No se encontró tu sesión en este teléfono. Vuelve a entrar con señal." });
      return;
    }
    await guardarEntrada(
      crearEntrada(
        { usuarioId, clubId, reservationId: ficha.reservation_id, clienteNombre: ficha.cliente_nombre, personas: ficha.personas, origen },
        crypto.randomUUID(),
        new Date(),
        copia?.venceEn ?? null,
      ),
    );
    setEstado({ f: "confirmada", ficha, modo: "sin_senal" });
    // Si la red ya volvió, sale de una vez.
    if (navigator.onLine) void enviarPendientesPuerta(usuarioId).catch(() => {});
  }

  async function confirmar(ficha: Ficha, modo: Modo, origen: Origen) {
    setConfirmando(true);
    try {
      if (modo === "sin_senal") return await guardarSinSenal(ficha, origen);
      const r = await llamar(createClient().rpc("puerta_confirmar_entrada", { p_reservation_id: ficha.reservation_id }));
      if (r.error && esErrorDeRed(r.error)) {
        // Se fue la señal entre la ficha y el botón: se guarda en el teléfono
        // (si la base sí alcanzó a guardarla, al enviarla dirá "ya estaba").
        return await guardarSinSenal(ficha, origen);
      }
      if (r.error) {
        setEstado({ f: "lista", ficha, modo, origen, error: mensajeParaUsuario(r.error, "No pudimos confirmar la entrada. Intenta de nuevo.") });
        return;
      }
      setEstado({ f: "confirmada", ficha, modo: "en_linea" });
      if (usuarioId) void marcarEntroEnCopia(usuarioId, clubId, ficha.reservation_id).catch(() => {});
      onEntrada();
    } catch (e) {
      console.error("Error confirmando entrada:", e);
      setEstado({ f: "lista", ficha, modo, origen, error: "Ocurrió un error. Intenta de nuevo." });
    } finally {
      setConfirmando(false);
    }
  }

  // ---------- Cámara (igual que el escáner de siempre) ----------

  useEffect(() => {
    let cancelado = false;
    let lector: Html5Qrcode | null = null;
    const arranque = import("html5-qrcode")
      .then(({ Html5Qrcode: Lector }) => {
        if (cancelado) return;
        lector = new Lector(LECTOR_ID);
        lectorRef.current = lector;
        return lector.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (t) => alLeerRef.current(t), undefined);
      })
      .then(() => {
        if (!cancelado && lector) setCamaraLista(true);
      })
      .catch((err) => {
        console.error("Error iniciando la cámara:", err);
        if (!cancelado)
          setCamaraError(
            navigator.onLine
              ? "No pudimos acceder a la cámara. Revisa los permisos del navegador o escribe el código del boleto."
              : "No se pudo abrir la cámara sin señal. Escribe el código del boleto.",
          );
      });
    return () => {
      cancelado = true;
      // Se apaga cuando termina de arrancar: stop() a media arrancada falla y
      // la cámara se quedaba prendida.
      void arranque
        .then(() => {
          const activo = lector;
          if (activo) return activo.stop().then(() => activo.clear());
        })
        .catch(() => {});
      lectorRef.current = null;
      setCamaraLista(false);
    };
  }, []);

  // ---------- Pantalla ----------

  const viejaOVencida = copia && (copiaVieja(copia, new Date()) || copiaVencida(copia, new Date()));
  const porEntrar = copia ? copia.reservas.filter((r) => !r.entro).length : 0;

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        {!enLinea && (
          <div
            role="status"
            data-prueba="puerta-sin-senal"
            className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
              copia ? "border-status-warn/40 bg-status-warn/10" : "border-status-err/40 bg-status-err/10"
            }`}
          >
            <CloudOff className={`mt-0.5 size-4 shrink-0 ${copia ? "text-status-warn" : "text-status-err"}`} aria-hidden="true" />
            <p className="min-w-0 flex-1">
              <span className="font-medium">Sin señal.</span>{" "}
              {copia
                ? `Se valida con la copia de las ${hora(copia.generadaEn)} (${porEntrar} por entrar). Las entradas se guardan en este teléfono y se envían solas al volver la señal.`
                : "No hay copia de la noche en este teléfono: no se puede validar hasta que vuelva la señal."}
              {copia && viejaOVencida && <span className="block text-xs text-muted-foreground">La copia es vieja: las reservas hechas después no aparecen.</span>}
              {copia?.truncada && (
                <span className="block text-xs text-status-err" data-prueba="copia-truncada">
                  La noche tiene {copia.total} reservas y la copia trae {copia.reservas.length}: algunas no aparecen sin señal.
                </span>
              )}
              {!persistente && (
                <span className="block text-xs text-status-err">Este navegador no deja guardar: si cierras la app se pierde lo guardado.</span>
              )}
            </p>
          </div>
        )}

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Escanear QR</CardTitle>
            <CardDescription>Apunta la cámara al código QR de la reserva.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 px-4 pb-6 sm:px-6">
            {/* El lector se queda montado: al seguir escaneando se reanuda. */}
            <div className={estado.f === "escaneando" && !camaraError ? "flex flex-col gap-3" : "hidden"}>
              <div id={LECTOR_ID} className="w-full overflow-hidden rounded-lg" />
              <BotonLinterna escaner={lectorRef} listo={camaraLista} />
            </div>

            {camaraError && estado.f === "escaneando" && (
              <p className="text-sm text-destructive" role="alert">
                {camaraError}
              </p>
            )}

            {estado.f === "buscando" && (
              <p className="text-sm text-muted-foreground" role="status">
                Buscando la reserva…
              </p>
            )}

            {estado.f === "error" && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-destructive" role="alert">
                  {estado.mensaje}
                </p>
                <Button type="button" className="h-11" onClick={siguiente}>
                  Escanear siguiente
                </Button>
              </div>
            )}

            {estado.f === "varias" && (
              <div className="flex flex-col gap-3">
                <p className="text-sm" role="alert">
                  Hay {estado.reservas.length} reservas con ese código en la copia del teléfono. Revisa la identificación y elige:
                </p>
                {estado.reservas.map((r) => (
                  <Button
                    key={r.reservation_id}
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 justify-start whitespace-normal py-2 text-left"
                    onClick={() => setEstado(revisarLocal(r, estado.origen))}
                  >
                    {r.cliente_nombre ?? "Ya entró"} · {personas(r.personas)}
                  </Button>
                ))}
                <Button type="button" variant="outline" className="h-11" onClick={siguiente}>
                  Cancelar
                </Button>
              </div>
            )}

            {estado.f === "opciones" && (
              <div className="flex flex-col gap-3" data-prueba="opciones-codigo">
                <p className="text-sm" role="alert">
                  Hay {estado.opciones.length} reservas de esta noche con ese código. Revisa la identificación y elige:
                </p>
                {estado.opciones.map((o) => (
                  <Button
                    key={o.reservation_id}
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 justify-start whitespace-normal py-2 text-left"
                    onClick={() => void elegirOpcion(estado.codigo, o.reservation_id)}
                  >
                    {o.nombre} · {personas(o.personas)}
                  </Button>
                ))}
                <Button type="button" variant="outline" className="h-11" onClick={siguiente}>
                  Cancelar
                </Button>
              </div>
            )}

            {estado.f === "lista" && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1 text-sm">
                  <p className="break-words text-base font-medium">{estado.ficha.cliente_nombre}</p>
                  <p className="text-muted-foreground">{personas(estado.ficha.personas)}</p>
                  <p className="break-words text-muted-foreground">
                    {estado.ficha.source === "rp" ? `RP: ${estado.ficha.rp_nombre ?? "—"}` : "Orgánica"}
                  </p>
                  {estado.modo === "sin_senal" && (
                    <p className="mt-1 rounded-md border border-status-warn/40 bg-status-warn/10 px-2 py-1 text-status-warn" data-prueba="ficha-sin-senal">
                      Sin señal: validada con la copia del teléfono. Al confirmar queda pendiente de enviar.
                    </p>
                  )}
                </div>
                {estado.error && (
                  <p className="text-sm text-destructive" role="alert">
                    {estado.error}
                  </p>
                )}
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full text-base"
                  onClick={() => confirmar(estado.ficha, estado.modo, estado.origen)}
                  disabled={confirmando}
                >
                  {confirmando ? "Confirmando..." : estado.modo === "sin_senal" ? "Confirmar entrada (sin señal)" : "Confirmar entrada"}
                </Button>
                <Button type="button" variant="outline" className="h-11" onClick={siguiente} disabled={confirmando}>
                  Escanear siguiente
                </Button>
              </div>
            )}

            {estado.f === "confirmada" && (
              <div className="flex flex-col gap-3">
                {estado.modo === "en_linea" ? (
                  <p className="break-words text-sm text-status-ok">
                    ¡Entrada confirmada! {estado.ficha.cliente_nombre} · {personas(estado.ficha.personas)}
                  </p>
                ) : (
                  <p className="break-words text-sm text-status-warn" data-prueba="entrada-pendiente">
                    Entrada guardada en este teléfono, pendiente de enviar: {estado.ficha.cliente_nombre} ·{" "}
                    {personas(estado.ficha.personas)}. Se envía sola al volver la señal.
                  </p>
                )}
                <Button type="button" className="h-11" onClick={siguiente}>
                  Escanear siguiente
                </Button>
                {estado.modo === "en_linea" && (
                  <Button render={<Link href="/staff/caja" />} nativeButton={false} variant="outline" className="h-11">
                    Sentar en mesa
                  </Button>
                )}
              </div>
            )}

            <form onSubmit={buscarCodigo} className="flex flex-col gap-2 rounded-md border border-border p-3" noValidate>
              <Label htmlFor="codigo-boleto" className="flex items-center gap-2">
                <KeyRound className="size-4" aria-hidden="true" />
                ¿No lee el QR? Escribe el código del boleto
              </Label>
              <div className="flex gap-2">
                <Input
                  id="codigo-boleto"
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  placeholder="Ej. A3F 9C2"
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={120}
                  className="h-11 min-w-0 flex-1 font-mono uppercase placeholder:normal-case"
                  aria-invalid={errorCodigo ? true : undefined}
                  aria-describedby="codigo-boleto-ayuda"
                />
                <Button type="submit" className="h-11 shrink-0" disabled={estado.f === "buscando" || confirmando}>
                  Buscar
                </Button>
              </div>
              <p id="codigo-boleto-ayuda" className="text-xs text-muted-foreground">
                Son los 6 caracteres debajo del QR del boleto. También puedes pegar el enlace del boleto.
              </p>
              {errorCodigo && (
                <p className="text-sm text-destructive" role="alert">
                  {errorCodigo}
                </p>
              )}
            </form>

            <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">El QR no garantiza la entrada.</p>

            <Button type="button" variant="outline" className="h-11" onClick={onCerrar}>
              Cerrar escáner
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
