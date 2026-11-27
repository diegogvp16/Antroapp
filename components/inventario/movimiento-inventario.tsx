"use client";

// Movimientos de inventario de un producto (bloque 8,
// sql/post-junta-3/80-inventario.sql): entrada de mercancía, merma y conteo
// físico, cada uno con su clave (un reintento con mala señal no mueve dos
// veces). Solo gerente o dueño y solo con la bandera «inventario»: la base
// lo revisa en cada llamada.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MensajeError, useAccion } from "@/components/caja/accion";
import { createClient } from "@/lib/supabase/client";
import { nuevaClave } from "@/lib/clave";
import { cn } from "@/lib/utils";
import { formatearCentavos, pesosACentavos, type Producto } from "@/lib/domain/caja";
import {
  errorMovimiento,
  esTipoMovimiento,
  leerEntero,
  textoDiferencia,
  textoExistencias,
  TIPO_MOVIMIENTO_LABEL,
} from "@/lib/domain/inventario";
import { mensajeParaUsuario } from "@/lib/errores-base";

type Tipo = "entrada" | "merma" | "conteo";
const TIPOS: { tipo: Tipo; texto: string }[] = [
  { tipo: "entrada", texto: "Entrada" },
  { tipo: "merma", texto: "Merma" },
  { tipo: "conteo", texto: "Conteo" },
];
const MOTIVOS_MERMA = ["Se rompió", "Se derramó", "Caducó", "Cortesía"];

export function MovimientoInventario({
  producto,
  onGuardado,
  onCancelar,
}: {
  producto: Producto;
  onGuardado: () => Promise<void> | void;
  onCancelar: () => void;
}) {
  const [tipo, setTipo] = useState<Tipo>("entrada");
  const [cantidad, setCantidad] = useState("");
  const [costo, setCosto] = useState("");
  const [referencia, setReferencia] = useState("");
  const [motivo, setMotivo] = useState("");
  const [clave, setClave] = useState(nuevaClave);
  // Lo que decía el sistema al abrir el conteo: si mientras cuentas se vende
  // algo, la base no lo absorbe en la diferencia (inventario_conteo).
  const [vistas, setVistas] = useState(producto.existencias);
  const { ocupado, error, ejecutar, limpiarError } = useAccion();
  const id = producto.id;

  const cambiarTipo = (t: Tipo) => {
    setTipo(t);
    setCantidad("");
    setMotivo("");
    setClave(nuevaClave());
    setVistas(producto.existencias);
    limpiarError();
  };

  const captura =
    tipo === "conteo"
      ? { tipo, contado: cantidad, motivo, existencias: vistas }
      : tipo === "merma"
        ? { tipo, cantidad, motivo }
        : { tipo, cantidad };
  const falta = errorMovimiento(captura);
  const costoCent = costo.trim() === "" ? null : pesosACentavos(costo);
  const costoValido = costo.trim() === "" || costoCent !== null;
  const n = leerEntero(cantidad);
  const dif = tipo === "conteo" && n !== null ? n - vistas : null;

  async function guardar() {
    if (falta || !costoValido || n === null) return;
    const rpc = createClient();
    await ejecutar(
      () =>
        tipo === "entrada"
          ? rpc.rpc("inventario_entrada", {
              p_producto_id: id,
              p_cantidad: n,
              p_costo_centavos: costoCent,
              p_referencia: referencia.trim() || null,
              p_clave: clave,
            })
          : tipo === "merma"
            ? rpc.rpc("inventario_merma", { p_producto_id: id, p_cantidad: n, p_motivo: motivo.trim(), p_clave: clave })
            : rpc.rpc("inventario_conteo", {
                p_producto_id: id,
                p_contado: n,
                p_motivo: motivo.trim() || null,
                p_clave: clave,
                p_existencias_vistas: vistas,
              }),
      onGuardado,
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void guardar();
      }}
    >
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Tipo de movimiento">
        {TIPOS.map((t) => (
          <Button key={t.tipo} type="button" variant={tipo === t.tipo ? "default" : "outline"} className="h-11" aria-pressed={tipo === t.tipo} onClick={() => cambiarTipo(t.tipo)}>
            {t.texto}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {tipo === "entrada" && "Llegó mercancía: se suma a las existencias."}
        {tipo === "merma" && "Se perdió producto (se rompió, se derramó…): se resta con su motivo."}
        {tipo === "conteo" &&
          `Conteo físico: al empezar, el sistema decía ${vistas}. Lo que se venda mientras cuentas no se cuenta como diferencia.`}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`mov-n-${id}`}>{tipo === "conteo" ? "¿Cuántas hay?" : "Cantidad"}</Label>
          <Input id={`mov-n-${id}`} value={cantidad} onChange={(e) => setCantidad(e.target.value)} inputMode="numeric" autoComplete="off" />
          {dif !== null && <span className={cn("text-xs", dif === 0 ? "text-status-ok" : "text-status-warn")}>{textoDiferencia(dif)}</span>}
        </div>
        {tipo === "entrada" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`mov-c-${id}`}>Costo total ($, opcional)</Label>
            <Input id={`mov-c-${id}`} value={costo} onChange={(e) => setCosto(e.target.value)} inputMode="decimal" placeholder="Ej. 1800" />
            {!costoValido && <span className="text-xs text-destructive">Costo no válido (ej. 1800 o 1800.50).</span>}
          </div>
        )}
      </div>
      {tipo === "entrada" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`mov-r-${id}`}>Referencia (opcional)</Label>
          <Input id={`mov-r-${id}`} value={referencia} onChange={(e) => setReferencia(e.target.value)} maxLength={120} placeholder="Factura o proveedor" />
        </div>
      )}
      {tipo !== "entrada" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`mov-m-${id}`}>Motivo{tipo === "conteo" ? " (obligatorio si no cuadra)" : ""}</Label>
          <Input id={`mov-m-${id}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={300} placeholder={tipo === "merma" ? "Ej. se rompió en la barra" : "Ej. conteo de cierre"} />
          {tipo === "merma" && (
            <div className="flex flex-wrap gap-2">
              {MOTIVOS_MERMA.map((m) => (
                <Button key={m} type="button" variant="outline" className="h-11" onClick={() => setMotivo(m)}>
                  {m}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {cantidad.trim() !== "" && falta && <p className="text-xs text-muted-foreground">{falta}</p>}
      <MensajeError mensaje={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-11" disabled={!!falta || !costoValido || ocupado}>
          {ocupado ? "Guardando..." : tipo === "entrada" ? `Sumar ${n ?? ""}` : tipo === "merma" ? `Restar ${n ?? ""}` : "Guardar conteo"}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={onCancelar} disabled={ocupado}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

type FilaHistorial = {
  id: string;
  tipo: string;
  cantidad: number;
  existencias_despues: number;
  motivo: string | null;
  referencia: string | null;
  costo_centavos: number | null;
  contado: number | null;
  concepto: string | null;
  hecho_por_nombre: string | null;
  hecho_en: string;
};

const formatoFecha = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// Historial de un producto: del más reciente al más viejo, con el saldo que
// quedó después de cada movimiento.
export function HistorialProducto({ producto, onCerrar }: { producto: Producto; onCerrar: () => void }) {
  const [filas, setFilas] = useState<FilaHistorial[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    createClient()
      .rpc("inventario_historial", { p_producto_id: producto.id, p_limite: 100 })
      .then(({ data, error: e }) => {
        if (!vivo) return;
        if (e) setError(mensajeParaUsuario(e, "No pudimos cargar el historial. Intenta de nuevo."));
        else setFilas((data ?? []) as FilaHistorial[]);
      });
    return () => {
      vivo = false;
    };
  }, [producto.id]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {textoExistencias(producto)}. Últimos 100 movimientos; el saldo es lo que quedó después de cada uno.
      </p>
      <MensajeError mensaje={error} />
      {filas === null && !error && <p className="text-sm text-muted-foreground">Cargando…</p>}
      {filas && filas.length === 0 && <p className="text-sm text-muted-foreground">Sin movimientos todavía.</p>}
      {filas && filas.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border text-sm">
          {filas.map((f) => (
            <li key={f.id} className="flex flex-col gap-0.5 px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{esTipoMovimiento(f.tipo) ? TIPO_MOVIMIENTO_LABEL[f.tipo] : f.tipo}</span>
                <span className={cn("tabular-nums", f.cantidad < 0 ? "text-status-err" : f.cantidad > 0 ? "text-status-ok" : "text-muted-foreground")}>
                  {f.cantidad > 0 ? `+${f.cantidad}` : f.cantidad} → {f.existencias_despues}
                </span>
              </div>
              <span className="break-words text-xs text-muted-foreground">
                {formatoFecha.format(new Date(f.hecho_en))}
                {f.hecho_por_nombre ? ` · ${f.hecho_por_nombre}` : ""}
                {f.concepto ? ` · ${f.concepto}` : ""}
                {f.tipo === "conteo" && f.contado !== null ? ` · contadas ${f.contado}` : ""}
                {f.referencia ? ` · ${f.referencia}` : ""}
                {f.costo_centavos !== null ? ` · costo ${formatearCentavos(Number(f.costo_centavos))}` : ""}
                {f.motivo && f.tipo !== "venta" ? ` · ${f.motivo}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="ghost" className="h-11 w-fit" onClick={onCerrar}>
        Cerrar historial
      </Button>
    </div>
  );
}
