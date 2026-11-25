"use client";

import { useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { nuevaClave } from "@/lib/clave";
import { FASE2_ACTIVA } from "@/lib/fase2";
import { bajoStock, categorias, filtrarCatalogo, textoExistencias } from "@/lib/domain/inventario";
import { BotonPrincipal, Contador, Hoja } from "@/components/caja/hoja";
import { MensajeError } from "@/components/caja/accion";
import {
  formatearCentavos,
  montoValido,
  motivoValido,
  pesosACentavos,
  centavosATexto,
  MIN_MOTIVO,
  type MesaCuenta,
  type MetodoPago,
  type Producto,
  type ProductoReciente,
  type ReservaSentable,
} from "@/lib/domain/caja";

const CAMPO =
  "h-11 w-full rounded-lg border border-caja-control bg-caja-fondo px-3 text-base text-caja-texto placeholder:text-caja-secundario outline-none focus-visible:border-caja-dorado";
const ETIQUETA = "mb-1 block text-xs text-caja-secundario";

// ---------------------------------------------------------------------------
// Agregar consumo. No hay catálogo: productos ya vendidos esta noche (con su
// precio) y un concepto con precio libre. Cada renglón se guarda como
// "N × producto" con su total.
// ---------------------------------------------------------------------------
interface RenglonCaptura {
  cantidad: number;
  producto: string;
  unitario: number; // centavos
  // Fase 2: si viene del catálogo, la base pone precio y concepto y descuenta existencias.
  producto_id?: string;
}
// Con su clave de idempotencia: la misma en cada reintento de esta hoja.
export type RenglonNuevo = RenglonCaptura & { clave: string };

// Lo que se puede agregar con −/+: un producto del catálogo (fase 2) o algo
// ya vendido esta noche (sin catálogo).
interface Opcion {
  clave: string;
  nombre: string;
  unitario: number;
  productoId?: string;
  existencias?: number;
  bajo?: boolean;
}

export function HojaConsumo({
  abierta,
  onCerrar,
  productos,
  catalogo = [],
  cuentas,
  ocupado,
  sinConexion,
  error,
  onAgregar,
}: {
  abierta: boolean;
  onCerrar: () => void;
  productos: ProductoReciente[];
  // Fase 2: catálogo del antro. Vacío (o bandera apagada) = como antes.
  catalogo?: Producto[];
  cuentas: MesaCuenta[];
  ocupado: boolean;
  sinConexion: boolean;
  error: string | null;
  onAgregar: (renglones: RenglonNuevo[], cuentaId: string) => void;
}) {
  const conCatalogo = FASE2_ACTIVA && catalogo.length > 0;
  const [busqueda, setBusqueda] = useState("");
  const [categoria, setCategoria] = useState<string | null>(null);
  const [cantidades, setCantidades] = useState<Record<string, number>>({});
  const [concepto, setConcepto] = useState("");
  const [precio, setPrecio] = useState("");
  const [cantidadLibre, setCantidadLibre] = useState(1);
  const [cuentaId, setCuentaId] = useState<string>(cuentas[0]?.id ?? "");
  const [verLibre, setVerLibre] = useState(!conCatalogo);

  // Todas las opciones (para armar los renglones) y las visibles (filtro).
  const opciones: Opcion[] = useMemo(
    () =>
      conCatalogo
        ? catalogo
            .filter((p) => p.activo)
            .map((p) => ({ clave: `p:${p.id}`, nombre: p.nombre, unitario: p.precio_centavos, productoId: p.id, existencias: p.existencias, bajo: bajoStock(p) }))
        : productos.map((p) => ({ clave: `${p.producto}|${p.unitario}`, nombre: p.producto, unitario: p.unitario })),
    [conCatalogo, catalogo, productos],
  );
  const visibles: Opcion[] = useMemo(() => {
    if (!conCatalogo) return opciones.filter((o) => o.nombre.toLowerCase().includes(busqueda.trim().toLowerCase()));
    const ids = new Set(filtrarCatalogo(catalogo, categoria, busqueda).map((p) => `p:${p.id}`));
    return opciones.filter((o) => ids.has(o.clave)).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  }, [conCatalogo, opciones, catalogo, categoria, busqueda]);
  const listaCategorias = useMemo(() => (conCatalogo ? categorias(catalogo.filter((p) => p.activo)) : []), [conCatalogo, catalogo]);

  const precioCent = pesosACentavos(precio);
  const libreValido = concepto.trim().length > 0 && montoValido(precioCent);

  const renglones: RenglonCaptura[] = useMemo(() => {
    const r: RenglonCaptura[] = opciones
      .filter((o) => (cantidades[o.clave] ?? 0) > 0)
      .map((o) => ({ cantidad: cantidades[o.clave], producto: o.nombre, unitario: o.unitario, producto_id: o.productoId }));
    if (libreValido && precioCent !== null) r.push({ cantidad: cantidadLibre, producto: concepto.trim(), unitario: precioCent });
    return r;
  }, [opciones, cantidades, libreValido, precioCent, cantidadLibre, concepto]);
  const total = renglones.reduce((s, r) => s + r.cantidad * r.unitario, 0);

  // Una clave por renglón (cuenta + producto + precio) mientras la hoja siga
  // abierta: si la respuesta se pierde y se vuelve a tocar, la base reconoce
  // lo que ya había entrado y no lo duplica.
  const claves = useRef(new Map<string, string>());
  function enviar() {
    onAgregar(
      renglones.map((r) => {
        const k = `${cuentaId}|${r.producto_id ?? r.producto}|${r.unitario}`;
        let c = claves.current.get(k);
        if (!c) {
          c = nuevaClave();
          claves.current.set(k, c);
        }
        return { ...r, clave: c };
      }),
      cuentaId,
    );
  }

  function cerrar() {
    setCantidades({});
    setConcepto("");
    setPrecio("");
    setCantidadLibre(1);
    setBusqueda("");
    setCategoria(null);
    onCerrar();
  }

  return (
    <Hoja
      titulo="Agregar consumo"
      abierta={abierta}
      onCerrar={cerrar}
      pie={
        <div className="flex flex-col gap-2">
          <MensajeError mensaje={error} />
          {sinConexion && <AvisoSinRed />}
          <BotonPrincipal disabled={ocupado || renglones.length === 0 || !cuentaId} onClick={enviar}>
            {ocupado ? "Agregando..." : `${sinConexion ? "Guardar en el teléfono" : "Agregar a la mesa"} · ${formatearCentavos(total)}`}
          </BotonPrincipal>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {cuentas.length > 1 && (
          <div>
            <span className={ETIQUETA}>¿De quién es? (cada RP cobra sobre lo de su cliente)</span>
            <div className="flex flex-wrap gap-2">
              {cuentas.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCuentaId(c.id)}
                  className={cn(
                    "h-11 rounded-lg border px-3 text-sm",
                    cuentaId === c.id ? "border-caja-dorado text-caja-texto" : "border-caja-control text-caja-secundario",
                  )}
                >
                  {c.cliente_nombre}
                </button>
              ))}
            </div>
          </div>
        )}

        {conCatalogo && (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label="Categorías">
            {[null, ...listaCategorias].map((c) => (
              <button
                key={c ?? "todas"}
                type="button"
                onClick={() => setCategoria(c)}
                aria-pressed={categoria === c}
                className={cn(
                  "h-11 shrink-0 rounded-lg border px-3 text-sm",
                  categoria === c ? "border-caja-dorado text-caja-texto" : "border-caja-control text-caja-secundario",
                )}
              >
                {c ?? "Todo"}
              </button>
            ))}
          </div>
        )}

        {opciones.length > 0 && (
          <div className="flex flex-col gap-2">
            <label className="relative block">
              <span className="sr-only">Buscar producto</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-caja-secundario" />
              <input
                type="search"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder={conCatalogo ? "Buscar en el catálogo" : "Buscar en lo vendido esta noche"}
                className={cn(CAMPO, "pl-9")}
              />
            </label>
            <ul className="flex flex-col divide-y divide-caja-borde">
              {visibles.map((o) => {
                const n = cantidades[o.clave] ?? 0;
                const excede = o.existencias !== undefined && n > Math.max(0, o.existencias);
                return (
                  <li key={o.clave} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{o.nombre}</span>
                      <span className="text-xs tabular-nums text-caja-secundario">
                        {formatearCentavos(o.unitario)}
                        {o.existencias !== undefined && (
                          <span className={cn(o.bajo || excede ? "text-caja-aviso" : undefined)}>
                            {" · "}
                            {textoExistencias({ existencias: o.existencias })}
                          </span>
                        )}
                      </span>
                    </span>
                    <Contador etiqueta={o.nombre} valor={n} onCambio={(v) => setCantidades((prev) => ({ ...prev, [o.clave]: v }))} />
                  </li>
                );
              })}
              {visibles.length === 0 && (
                <li className="py-2 text-sm text-caja-secundario">
                  {conCatalogo ? "Nada en el catálogo con ese nombre." : "Nada vendido con ese nombre esta noche."}
                </li>
              )}
            </ul>
          </div>
        )}

        {conCatalogo && !verLibre ? (
          <button type="button" onClick={() => setVerLibre(true)} className="h-11 w-fit text-sm text-caja-secundario underline underline-offset-2">
            Otro concepto (fuera del catálogo)
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{opciones.length > 0 ? "Otro concepto" : "Concepto y precio"}</span>
            {conCatalogo && <span className="text-xs text-caja-secundario">No descuenta inventario.</span>}
            <input value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Ej. Botella de tequila" maxLength={100} aria-label="Concepto" className={CAMPO} />
            <div className="flex items-end gap-3">
              <label className="flex-1">
                <span className={ETIQUETA}>Precio unitario ($)</span>
                <input value={precio} onChange={(e) => setPrecio(e.target.value)} inputMode="decimal" placeholder="0.00" className={cn(CAMPO, "tabular-nums")} />
              </label>
              <Contador etiqueta="Cantidad" minimo={1} valor={cantidadLibre} onCambio={setCantidadLibre} />
            </div>
            {precio && !montoValido(precioCent) && <p className="text-xs text-destructive">Precio no válido (ej. 1250.50).</p>}
          </div>
        )}
      </div>
    </Hoja>
  );
}

// Sin señal, consumo y cobro se guardan en el teléfono (cola de caja) y se
// mandan solos al volver: nada se pierde aunque se cierre la app.
function AvisoSinRed() {
  return (
    <p className="text-xs text-caja-aviso" role="status">
      Sin señal: se guarda en este teléfono y se envía solo al volver la señal.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Cobrar: por forma de pago, a toda la mesa.
// ---------------------------------------------------------------------------
export function HojaCobro({
  abierta,
  onCerrar,
  saldo,
  ocupado,
  sinConexion,
  error,
  onCobrar,
}: {
  abierta: boolean;
  onCerrar: () => void;
  saldo: number;
  ocupado: boolean;
  sinConexion: boolean;
  error: string | null;
  // saldoVisto: el saldo con el que se armó el cobro. La base lo compara con
  // el real y rechaza si otro staff ya cobró o agregó consumo.
  // propina: fase 2 (0 sin la bandera); va aparte del monto.
  onCobrar: (metodo: MetodoPago, centavos: number, referencia: string, clave: string, saldoVisto: number, propina: number) => void;
}) {
  const [metodo, setMetodo] = useState<MetodoPago>("efectivo");
  const [monto, setMonto] = useState(centavosATexto(saldo));
  const [referencia, setReferencia] = useState("");
  // La misma clave en cada reintento de esta hoja: un cobro que sí entró
  // (aunque se perdiera la respuesta) no se cobra dos veces.
  const [clave] = useState(nuevaClave);
  const [saldoBase, setSaldoBase] = useState(saldo);
  const [propina, setPropina] = useState("");
  const propinaCent = propina.trim() === "" ? 0 : pesosACentavos(propina);
  const propinaValida = propinaCent !== null && propinaCent >= 0;
  const cent = pesosACentavos(monto);
  const valido = montoValido(cent);
  const saldoCambio = saldo !== saldoBase;
  return (
    <Hoja
      titulo="Cobrar"
      abierta={abierta}
      onCerrar={onCerrar}
      pie={
        <div className="flex flex-col gap-2">
          {/* Si el saldo cambió, el aviso de arriba explica qué pasó. */}
          {!saldoCambio && <MensajeError mensaje={error} />}
          {sinConexion && !saldoCambio && <AvisoSinRed />}
          {saldoCambio && saldo <= 0 ? (
            <BotonPrincipal onClick={onCerrar}>Listo</BotonPrincipal>
          ) : (
            <BotonPrincipal
              disabled={ocupado || !valido || saldoCambio || !propinaValida}
              onClick={() => cent !== null && onCobrar(metodo, cent, referencia, clave, saldoBase, FASE2_ACTIVA ? (propinaCent ?? 0) : 0)}
            >
              {ocupado
                ? "Cobrando..."
                : `${sinConexion ? "Guardar cobro" : "Cobrar"} ${valido && cent !== null ? formatearCentavos(cent) : ""}`}
            </BotonPrincipal>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2">
          {(["efectivo", "tarjeta"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetodo(m)}
              aria-pressed={metodo === m}
              className={cn("h-12 rounded-lg border text-base", metodo === m ? "border-caja-dorado text-caja-texto" : "border-caja-control text-caja-secundario")}
            >
              {m === "efectivo" ? "Efectivo" : "Tarjeta"}
            </button>
          ))}
        </div>
        <label>
          <span className={ETIQUETA}>Monto ($) · saldo {formatearCentavos(saldoBase)}</span>
          <input value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" className={cn(CAMPO, "text-lg tabular-nums")} />
        </label>
        {saldoCambio && (
          <div className="flex flex-col gap-2 rounded-lg border border-caja-aviso/60 p-3 text-sm" role="status">
            {saldo <= 0 ? (
              <p>
                <span className="font-semibold">La mesa ya quedó pagada.</span> Se registró un cobro mientras cobrabas (puede ser el tuyo, si
                se perdió la respuesta). No hace falta cobrar otra vez.
              </p>
            ) : (
              <p>
                El saldo de la mesa ahora es <span className="font-semibold tabular-nums">{formatearCentavos(saldo)}</span>: se registró un
                cobro o consumo mientras cobrabas (puede ser el tuyo, si se perdió la respuesta). Revisa los cobros antes de volver a cobrar.
              </p>
            )}
            {saldo > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSaldoBase(saldo);
                  setMonto(centavosATexto(saldo));
                }}
                className="h-11 w-fit rounded-md border border-caja-control px-3"
              >
                Cobrar el saldo nuevo · {formatearCentavos(saldo)}
              </button>
            )}
          </div>
        )}
        {!saldoCambio && cent !== null && cent > saldoBase && <p className="text-xs text-caja-aviso">Es más que el saldo de la mesa.</p>}
        {FASE2_ACTIVA && (
          <label>
            <span className={ETIQUETA}>Propina ($, opcional) · va aparte: no cambia el saldo ni la comisión</span>
            <input value={propina} onChange={(e) => setPropina(e.target.value)} inputMode="decimal" placeholder="0.00" className={cn(CAMPO, "tabular-nums")} />
            {!propinaValida && <span className="mt-1 block text-xs text-destructive">Propina no válida (ej. 150).</span>}
          </label>
        )}
        {metodo === "tarjeta" && (
          <label>
            <span className={ETIQUETA}>Referencia (opcional)</span>
            <input value={referencia} onChange={(e) => setReferencia(e.target.value)} maxLength={60} placeholder="Últimos 4 dígitos o folio" className={CAMPO} />
          </label>
        )}
      </div>
    </Hoja>
  );
}

// ---------------------------------------------------------------------------
// Recibir grupo: con reserva (entrada confirmada en la puerta) o sin reserva.
// ---------------------------------------------------------------------------
export function HojaRecibir({
  abierta,
  onCerrar,
  titulo,
  reservas,
  nombres,
  ocupado,
  sinConexion,
  error,
  onRecibir,
}: {
  abierta: boolean;
  onCerrar: () => void;
  titulo: string;
  reservas: ReservaSentable[];
  nombres: Record<string, string>;
  ocupado: boolean;
  sinConexion: boolean;
  error: string | null;
  onRecibir: (opcion: { reservaId: string } | { nombre: string; personas: number }) => void;
}) {
  const [modo, setModo] = useState<"reserva" | "sin">(reservas.length > 0 ? "reserva" : "sin");
  const [reservaId, setReservaId] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [personas, setPersonas] = useState(2);
  const listo = modo === "reserva" ? !!reservaId : nombre.trim().length > 0;
  return (
    <Hoja
      titulo={titulo}
      abierta={abierta}
      onCerrar={onCerrar}
      pie={
        <div className="flex flex-col gap-2">
          <MensajeError mensaje={error} />
          <BotonPrincipal
            disabled={ocupado || sinConexion || !listo}
            onClick={() => onRecibir(modo === "reserva" && reservaId ? { reservaId } : { nombre: nombre.trim(), personas })}
          >
            {sinConexion ? "Sin conexión" : ocupado ? "Sentando..." : "Sentar en la mesa"}
          </BotonPrincipal>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["reserva", `Con reserva (${reservas.length})`],
              ["sin", "Sin reserva"],
            ] as const
          ).map(([m, t]) => (
            <button
              key={m}
              type="button"
              onClick={() => setModo(m)}
              aria-pressed={modo === m}
              className={cn("h-11 rounded-lg border text-sm", modo === m ? "border-caja-dorado text-caja-texto" : "border-caja-control text-caja-secundario")}
            >
              {t}
            </button>
          ))}
        </div>
        {modo === "reserva" ? (
          reservas.length === 0 ? (
            <p className="text-sm text-caja-secundario">No hay reservas con entrada confirmada sin mesa. Confirma la entrada en el panel.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {reservas.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setReservaId(r.id)}
                    aria-pressed={reservaId === r.id}
                    className={cn(
                      "flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left",
                      reservaId === r.id ? "border-caja-dorado" : "border-caja-borde",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{r.cliente_nombre}</span>
                      <span className="text-xs text-caja-secundario">
                        {r.personas} pers. · {r.rp_id ? `RP ${nombres[r.rp_id] ?? ""}` : "Orgánica"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="flex items-end gap-3">
            <label className="flex-1">
              <span className={ETIQUETA}>Nombre</span>
              <input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={120} placeholder="Nombre del cliente" className={CAMPO} />
            </label>
            <Contador etiqueta="Personas" minimo={1} valor={personas} onCambio={setPersonas} />
          </div>
        )}
      </div>
    </Hoja>
  );
}

// ---------------------------------------------------------------------------
// Motivo obligatorio: anular un cargo o un pago, o reabrir la mesa.
// ---------------------------------------------------------------------------
export function HojaMotivo({
  abierta,
  onCerrar,
  titulo,
  descripcion,
  boton,
  ocupado,
  sinConexion,
  error,
  onConfirmar,
}: {
  abierta: boolean;
  onCerrar: () => void;
  titulo: string;
  descripcion: string;
  boton: string;
  ocupado: boolean;
  sinConexion: boolean;
  error: string | null;
  onConfirmar: (motivo: string) => void;
}) {
  const [motivo, setMotivo] = useState("");
  return (
    <Hoja
      titulo={titulo}
      abierta={abierta}
      onCerrar={() => {
        setMotivo("");
        onCerrar();
      }}
      pie={
        <div className="flex flex-col gap-2">
          <MensajeError mensaje={error} />
          <BotonPrincipal tono="aviso" disabled={ocupado || sinConexion || !motivoValido(motivo)} onClick={() => onConfirmar(motivo.trim())}>
            {sinConexion ? "Sin conexión" : ocupado ? "Guardando..." : boton}
          </BotonPrincipal>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-caja-secundario">{descripcion}</p>
        <label>
          <span className={ETIQUETA}>Motivo (obligatorio, mínimo {MIN_MOTIVO} letras)</span>
          <input data-autofocus value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={300} placeholder="Ej. capturado dos veces" className={CAMPO} />
        </label>
      </div>
    </Hoja>
  );
}

// ---------------------------------------------------------------------------
// Cuadrar mesa (gerente): aquí nacen las comisiones de los RPs.
// ---------------------------------------------------------------------------
export function HojaCuadrar({
  abierta,
  onCerrar,
  consumo,
  cobrado,
  propinas = 0,
  cerrarAntes,
  ocupado,
  sinConexion,
  error,
  onCuadrar,
}: {
  abierta: boolean;
  onCerrar: () => void;
  consumo: number;
  cobrado: number;
  propinas?: number;
  cerrarAntes: boolean;
  ocupado: boolean;
  sinConexion: boolean;
  error: string | null;
  onCuadrar: (notas: string) => void;
}) {
  const [notas, setNotas] = useState("");
  return (
    <Hoja
      titulo="Cuadrar mesa"
      abierta={abierta}
      onCerrar={onCerrar}
      pie={
        <div className="flex flex-col gap-2">
          <MensajeError mensaje={error} />
          <BotonPrincipal disabled={ocupado || sinConexion} onClick={() => onCuadrar(notas)}>
            {sinConexion ? "Sin conexión" : ocupado ? "Cuadrando..." : `Cuadrar mesa · ${formatearCentavos(consumo)}`}
          </BotonPrincipal>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex justify-between"><span className="text-caja-secundario">Consumo</span><span className="tabular-nums">{formatearCentavos(consumo)}</span></div>
        <div className="flex justify-between"><span className="text-caja-secundario">Cobrado</span><span className="tabular-nums">{formatearCentavos(cobrado)}</span></div>
        {propinas > 0 && (
          <div className="flex justify-between">
            <span className="text-caja-secundario">Propinas (aparte, no son de la comisión)</span>
            <span className="tabular-nums">{formatearCentavos(propinas)}</span>
          </div>
        )}
        <p className="text-xs text-caja-secundario">
          {cerrarAntes ? "Se cierra la mesa y se cuadra. " : ""}Al cuadrar nacen las comisiones de los RPs y la mesa queda definitiva; ya no se puede reabrir.
        </p>
        <label>
          <span className={ETIQUETA}>Notas (opcional)</span>
          <input value={notas} onChange={(e) => setNotas(e.target.value)} maxLength={300} className={CAMPO} />
        </label>
      </div>
    </Hoja>
  );
}
