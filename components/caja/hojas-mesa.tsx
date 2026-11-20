"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
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
  type ProductoReciente,
  type ReservaSentable,
} from "@/lib/domain/caja";

const CAMPO =
  "h-11 w-full rounded-lg border border-caja-borde bg-caja-fondo px-3 text-base text-caja-texto placeholder:text-caja-secundario outline-none focus-visible:border-caja-dorado";
const ETIQUETA = "mb-1 block text-xs text-caja-secundario";

// ---------------------------------------------------------------------------
// Agregar consumo. No hay catálogo: productos ya vendidos esta noche (con su
// precio) y un concepto con precio libre. Cada renglón se guarda como
// "N × producto" con su total.
// ---------------------------------------------------------------------------
export interface RenglonNuevo {
  cantidad: number;
  producto: string;
  unitario: number; // centavos
}

export function HojaConsumo({
  abierta,
  onCerrar,
  productos,
  cuentas,
  ocupado,
  error,
  onAgregar,
}: {
  abierta: boolean;
  onCerrar: () => void;
  productos: ProductoReciente[];
  cuentas: MesaCuenta[];
  ocupado: boolean;
  error: string | null;
  onAgregar: (renglones: RenglonNuevo[], cuentaId: string) => void;
}) {
  const [busqueda, setBusqueda] = useState("");
  const [cantidades, setCantidades] = useState<Record<string, number>>({});
  const [concepto, setConcepto] = useState("");
  const [precio, setPrecio] = useState("");
  const [cantidadLibre, setCantidadLibre] = useState(1);
  const [cuentaId, setCuentaId] = useState<string>(cuentas[0]?.id ?? "");

  const clave = (p: ProductoReciente) => `${p.producto}|${p.unitario}`;
  const filtrados = productos.filter((p) => p.producto.toLowerCase().includes(busqueda.trim().toLowerCase()));
  const precioCent = pesosACentavos(precio);
  const libreValido = concepto.trim().length > 0 && montoValido(precioCent);

  const renglones: RenglonNuevo[] = useMemo(() => {
    const r: RenglonNuevo[] = productos
      .filter((p) => (cantidades[clave(p)] ?? 0) > 0)
      .map((p) => ({ cantidad: cantidades[clave(p)], producto: p.producto, unitario: p.unitario }));
    if (libreValido && precioCent !== null) r.push({ cantidad: cantidadLibre, producto: concepto.trim(), unitario: precioCent });
    return r;
  }, [productos, cantidades, libreValido, precioCent, cantidadLibre, concepto]);
  const total = renglones.reduce((s, r) => s + r.cantidad * r.unitario, 0);

  function cerrar() {
    setCantidades({});
    setConcepto("");
    setPrecio("");
    setCantidadLibre(1);
    setBusqueda("");
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
          <BotonPrincipal disabled={ocupado || renglones.length === 0 || !cuentaId} onClick={() => onAgregar(renglones, cuentaId)}>
            {ocupado ? "Agregando..." : `Agregar a la mesa · ${formatearCentavos(total)}`}
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
                    cuentaId === c.id ? "border-caja-dorado text-caja-texto" : "border-caja-borde text-caja-secundario",
                  )}
                >
                  {c.cliente_nombre}
                </button>
              ))}
            </div>
          </div>
        )}

        {productos.length > 0 && (
          <div className="flex flex-col gap-2">
            <label className="relative block">
              <span className="sr-only">Buscar producto</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-caja-secundario" />
              <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Buscar en lo vendido esta noche" className={cn(CAMPO, "pl-9")} />
            </label>
            <ul className="flex flex-col divide-y divide-caja-borde">
              {filtrados.map((p) => (
                <li key={clave(p)} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{p.producto}</span>
                    <span className="text-xs tabular-nums text-caja-secundario">{formatearCentavos(p.unitario)}</span>
                  </span>
                  <Contador
                    etiqueta={p.producto}
                    valor={cantidades[clave(p)] ?? 0}
                    onCambio={(n) => setCantidades((prev) => ({ ...prev, [clave(p)]: n }))}
                  />
                </li>
              ))}
              {filtrados.length === 0 && <li className="py-2 text-sm text-caja-secundario">Nada vendido con ese nombre esta noche.</li>}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{productos.length > 0 ? "Otro concepto" : "Concepto y precio"}</span>
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
      </div>
    </Hoja>
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
  error,
  onCobrar,
}: {
  abierta: boolean;
  onCerrar: () => void;
  saldo: number;
  ocupado: boolean;
  error: string | null;
  onCobrar: (metodo: MetodoPago, centavos: number, referencia: string) => void;
}) {
  const [metodo, setMetodo] = useState<MetodoPago>("efectivo");
  const [monto, setMonto] = useState(centavosATexto(saldo));
  const [referencia, setReferencia] = useState("");
  const cent = pesosACentavos(monto);
  const valido = montoValido(cent);
  return (
    <Hoja
      titulo="Cobrar"
      abierta={abierta}
      onCerrar={onCerrar}
      pie={
        <div className="flex flex-col gap-2">
          <MensajeError mensaje={error} />
          <BotonPrincipal disabled={ocupado || !valido} onClick={() => cent !== null && onCobrar(metodo, cent, referencia)}>
            {ocupado ? "Cobrando..." : `Cobrar ${valido && cent !== null ? formatearCentavos(cent) : ""}`}
          </BotonPrincipal>
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
              className={cn("h-12 rounded-lg border text-base", metodo === m ? "border-caja-dorado text-caja-texto" : "border-caja-borde text-caja-secundario")}
            >
              {m === "efectivo" ? "Efectivo" : "Tarjeta"}
            </button>
          ))}
        </div>
        <label>
          <span className={ETIQUETA}>Monto ($) · saldo {formatearCentavos(saldo)}</span>
          <input value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" className={cn(CAMPO, "text-lg tabular-nums")} />
        </label>
        {cent !== null && cent > saldo && <p className="text-xs text-caja-aviso">Es más que el saldo de la mesa.</p>}
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
  error,
  onRecibir,
}: {
  abierta: boolean;
  onCerrar: () => void;
  titulo: string;
  reservas: ReservaSentable[];
  nombres: Record<string, string>;
  ocupado: boolean;
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
            disabled={ocupado || !listo}
            onClick={() => onRecibir(modo === "reserva" && reservaId ? { reservaId } : { nombre: nombre.trim(), personas })}
          >
            {ocupado ? "Sentando..." : "Sentar en la mesa"}
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
              className={cn("h-11 rounded-lg border text-sm", modo === m ? "border-caja-dorado text-caja-texto" : "border-caja-borde text-caja-secundario")}
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
  error,
  onConfirmar,
}: {
  abierta: boolean;
  onCerrar: () => void;
  titulo: string;
  descripcion: string;
  boton: string;
  ocupado: boolean;
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
          <BotonPrincipal tono="aviso" disabled={ocupado || !motivoValido(motivo)} onClick={() => onConfirmar(motivo.trim())}>
            {ocupado ? "Guardando..." : boton}
          </BotonPrincipal>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-caja-secundario">{descripcion}</p>
        <label>
          <span className={ETIQUETA}>Motivo (obligatorio, mínimo {MIN_MOTIVO} letras)</span>
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={300} placeholder="Ej. capturado dos veces" className={CAMPO} />
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
  cerrarAntes,
  ocupado,
  error,
  onCuadrar,
}: {
  abierta: boolean;
  onCerrar: () => void;
  consumo: number;
  cobrado: number;
  cerrarAntes: boolean;
  ocupado: boolean;
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
          <BotonPrincipal disabled={ocupado} onClick={() => onCuadrar(notas)}>
            {ocupado ? "Cuadrando..." : `Cuadrar mesa · ${formatearCentavos(consumo)}`}
          </BotonPrincipal>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex justify-between"><span className="text-caja-secundario">Consumo</span><span className="tabular-nums">{formatearCentavos(consumo)}</span></div>
        <div className="flex justify-between"><span className="text-caja-secundario">Cobrado</span><span className="tabular-nums">{formatearCentavos(cobrado)}</span></div>
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
