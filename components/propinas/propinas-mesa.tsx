"use client";

// Propinas sueltas de una mesa (bloque 8, sql/post-junta-3/81-propinas.sql):
// la que dejan en la mesa aparte del cobro. Van APARTE del consumo y del
// cobro: no cambian el saldo, el cuadre ni la comisión. Solo con la fase 2 y
// la bandera «propinas» del antro (useFase2). Registrar = permiso «cobrar»;
// anular = permiso «anular» (la base lo vuelve a revisar).
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { nuevaClave } from "@/lib/clave";
import { useFase2 } from "@/lib/fase2-contexto";
import { BotonPrincipal, Hoja } from "@/components/caja/hoja";
import { MensajeError, useAccion } from "@/components/caja/accion";
import { HojaMotivo } from "@/components/caja/hojas-mesa";
import { formatearCentavos, horaCorta, montoValido, pesosACentavos, type MesaCuenta, type MetodoPago } from "@/lib/domain/caja";
import { COLUMNAS_PROPINA, type CajaPropina } from "@/lib/domain/propinas";

const CAMPO =
  "h-11 w-full rounded-lg border border-caja-control bg-caja-fondo px-3 text-base text-caja-texto placeholder:text-caja-secundario outline-none focus-visible:border-caja-dorado";
const ETIQUETA = "mb-1 block text-xs text-caja-secundario";
const METODO: Record<MetodoPago, string> = { efectivo: "Efectivo", tarjeta: "Tarjeta", otro: "Otro" };
const CADA_MS = 15_000;

/** Propinas sueltas de una mesa (sesión) o de toda la noche, y los cobros
 *  cuya propina se anuló sola (propinas_cobro_anuladas, de toda la noche).
 *  Se vuelven a leer cada 15 s mientras la pantalla está abierta. Sin
 *  bandera, vacío. */
export function usePropinasSueltas(filtro: { sesionId?: string | null; nocheId?: string | null }, activo: boolean) {
  const [lista, setLista] = useState<CajaPropina[]>([]);
  const [cobrosAnulados, setCobrosAnulados] = useState<ReadonlySet<string>>(new Set());
  const { sesionId = null, nocheId = null } = filtro;
  const recargar = useCallback(async () => {
    if (!activo || (!sesionId && !nocheId)) {
      setLista([]);
      setCobrosAnulados(new Set());
      return;
    }
    const supabase = createClient();
    let q = supabase.from("caja_propinas").select(COLUMNAS_PROPINA).order("registrado_en");
    q = sesionId ? q.eq("sesion_id", sesionId) : q.eq("noche_id", nocheId as string);
    let a = supabase.from("propinas_cobro_anuladas").select("pago_id");
    a = nocheId ? a.eq("noche_id", nocheId) : a.in("pago_id", (await supabase.from("caja_pagos").select("id").eq("sesion_id", sesionId as string)).data?.map((x) => x.id) ?? []);
    const [r1, r2] = await Promise.all([q, a]);
    if (!r1.error) setLista((r1.data ?? []) as CajaPropina[]);
    if (!r2.error) setCobrosAnulados(new Set((r2.data ?? []).map((x) => x.pago_id as string)));
  }, [activo, sesionId, nocheId]);
  useEffect(() => {
    void recargar();
    if (!activo) return;
    const t = setInterval(() => void recargar(), CADA_MS);
    return () => clearInterval(t);
  }, [recargar, activo]);
  return { lista, cobrosAnulados, recargar };
}

/** «Propina sin mesa»: la que se encuentra cuando la mesa ya se cuadró (o la
 *  de la barra). Mismas validaciones en la base (permiso «cobrar», noche
 *  abierta, bandera). Solo con la fase 2 y la bandera «propinas». */
export function PropinaSinMesa({
  nocheId,
  puedeRegistrar,
  sinConexion,
}: {
  nocheId: string | null;
  puedeRegistrar: boolean;
  sinConexion: boolean;
}) {
  const { propinas: activa } = useFase2();
  const accion = useAccion();
  const [abierta, setAbierta] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  if (!activa || !nocheId || !puedeRegistrar) return null;
  const cerrar = () => {
    accion.limpiarError();
    setAbierta(false);
  };
  return (
    <section className="mt-4" aria-label="Propina sin mesa">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-caja-secundario">¿Dejaron propina y la mesa ya se cuadró? Regístrala sin mesa.</p>
        <button type="button" onClick={() => { setAviso(null); setAbierta(true); }} className="-mr-2 h-11 shrink-0 px-2 text-sm font-medium text-caja-dorado">
          + Propina sin mesa
        </button>
      </div>
      {aviso && (
        <p role="status" className="text-xs text-caja-ok">
          {aviso}
        </p>
      )}
      {abierta && (
        <HojaPropina
          titulo="Propina sin mesa"
          cuentas={[]}
          ocupado={accion.ocupado}
          sinConexion={sinConexion}
          error={accion.error}
          onCerrar={cerrar}
          onGuardar={(d) =>
            void accion.ejecutar(
              () =>
                createClient().rpc("caja_registrar_propina", {
                  p_noche_id: nocheId,
                  p_sesion_id: null,
                  p_cuenta_id: null,
                  p_metodo: d.metodo,
                  p_monto_centavos: d.centavos,
                  p_nota: d.nota || null,
                  p_clave: d.clave,
                }),
              () => {
                setAviso(`Propina sin mesa registrada: ${formatearCentavos(d.centavos)}.`);
                cerrar();
              },
            )
          }
        />
      )}
    </section>
  );
}

export function PropinasMesa({
  nocheId,
  sesionId,
  cuentas,
  lista,
  puedeRegistrar,
  puedeAnular,
  sinConexion,
  onCambio,
}: {
  nocheId: string | null;
  sesionId: string;
  cuentas: MesaCuenta[];
  lista: CajaPropina[];
  // Mesa sin cuadrar, noche abierta y permiso de la caja.
  puedeRegistrar: boolean;
  puedeAnular: boolean;
  sinConexion: boolean;
  onCambio: () => Promise<void>;
}) {
  const { propinas: activa } = useFase2();
  const accion = useAccion();
  const [hoja, setHoja] = useState<"nueva" | CajaPropina | null>(null);
  if (!activa || !nocheId) return null;
  const cerrar = () => {
    accion.limpiarError();
    setHoja(null);
  };
  const nombreCuenta = (id: string | null) => (id ? (cuentas.find((c) => c.id === id)?.cliente_nombre ?? "Cuenta") : "De la mesa");
  const vigentes = lista.filter((p) => !p.anulado);
  const total = vigentes.reduce((s, p) => s + Number(p.monto_centavos), 0);

  return (
    <section className="mt-4" aria-label="Propinas de la mesa">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          Propinas aparte {total > 0 && <span className="text-caja-secundario tabular-nums">· {formatearCentavos(total)}</span>}
        </h3>
        {puedeRegistrar && (
          <button type="button" onClick={() => setHoja("nueva")} className="-mr-2 h-11 px-2 text-sm font-medium text-caja-dorado">
            + Registrar propina
          </button>
        )}
      </div>
      {lista.length === 0 ? (
        <p className="text-xs text-caja-secundario">La propina que dejan aparte del cobro. No cambia el saldo ni la comisión.</p>
      ) : (
        <ul className="mt-1 divide-y divide-caja-borde rounded-lg border border-caja-borde bg-caja-superficie text-xs text-caja-secundario">
          {lista.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={p.anulado || !puedeAnular}
                onClick={() => setHoja(p)}
                className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left disabled:cursor-default"
              >
                <span className={cn("min-w-0 break-words", p.anulado && "line-through")}>
                  {horaCorta(p.registrado_en)} · {METODO[p.metodo]} · {nombreCuenta(p.cuenta_id)}
                  {p.nota ? ` · ${p.nota}` : ""}
                  {p.anulado ? ` — ${p.motivo_anulacion}` : ""}
                </span>
                <span className={cn("shrink-0 tabular-nums text-caja-texto", p.anulado && "line-through")}>{formatearCentavos(Number(p.monto_centavos))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hoja === "nueva" && (
        <HojaPropina
          cuentas={cuentas}
          ocupado={accion.ocupado}
          sinConexion={sinConexion}
          error={accion.error}
          onCerrar={cerrar}
          onGuardar={(d) =>
            void accion.ejecutar(
              () =>
                createClient().rpc("caja_registrar_propina", {
                  p_noche_id: nocheId,
                  p_sesion_id: sesionId,
                  p_cuenta_id: d.cuentaId,
                  p_metodo: d.metodo,
                  p_monto_centavos: d.centavos,
                  p_nota: d.nota || null,
                  p_clave: d.clave,
                }),
              async () => {
                await onCambio();
                cerrar();
              },
            )
          }
        />
      )}
      {hoja && hoja !== "nueva" && (
        <HojaMotivo
          abierta
          onCerrar={cerrar}
          titulo="Anular propina"
          descripcion={`${METODO[hoja.metodo]} · ${formatearCentavos(Number(hoja.monto_centavos))}. Queda en el historial con el motivo.`}
          boton="Anular propina"
          ocupado={accion.ocupado}
          sinConexion={sinConexion}
          error={accion.error}
          onConfirmar={(motivo) =>
            void accion.ejecutar(
              () => createClient().rpc("caja_anular_propina", { p_propina_id: hoja.id, p_motivo: motivo }),
              async () => {
                await onCambio();
                cerrar();
              },
            )
          }
        />
      )}
    </section>
  );
}

function HojaPropina({
  titulo = "Registrar propina",
  cuentas,
  ocupado,
  sinConexion,
  error,
  onCerrar,
  onGuardar,
}: {
  titulo?: string;
  cuentas: MesaCuenta[];
  ocupado: boolean;
  sinConexion: boolean;
  error: string | null;
  onCerrar: () => void;
  onGuardar: (d: { metodo: MetodoPago; centavos: number; cuentaId: string | null; nota: string; clave: string }) => void;
}) {
  const [metodo, setMetodo] = useState<MetodoPago>("efectivo");
  const [monto, setMonto] = useState("");
  const [nota, setNota] = useState("");
  // Con una sola cuenta, la propina es de esa cuenta (y de su RP).
  const [cuentaId, setCuentaId] = useState<string | null>(cuentas.length === 1 ? cuentas[0].id : null);
  // La misma clave en cada reintento de esta hoja: no se registra dos veces.
  const [clave] = useState(nuevaClave);
  const cent = pesosACentavos(monto);
  const valido = montoValido(cent);
  return (
    <Hoja
      titulo={titulo}
      abierta
      onCerrar={onCerrar}
      pie={
        <div className="flex flex-col gap-2">
          <MensajeError mensaje={error} />
          <BotonPrincipal
            disabled={ocupado || sinConexion || !valido}
            onClick={() => cent !== null && onGuardar({ metodo, centavos: cent, cuentaId, nota: nota.trim(), clave })}
          >
            {sinConexion ? "Sin conexión" : ocupado ? "Guardando..." : `Registrar ${valido && cent !== null ? formatearCentavos(cent) : "propina"}`}
          </BotonPrincipal>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-caja-secundario">Va aparte: no cambia el saldo de la mesa, el cuadre ni la comisión del RP.</p>
        <div className="grid grid-cols-2 gap-2">
          {(["efectivo", "tarjeta"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetodo(m)}
              aria-pressed={metodo === m}
              className={cn("h-12 rounded-lg border text-base", metodo === m ? "border-caja-dorado text-caja-texto" : "border-caja-control text-caja-secundario")}
            >
              {METODO[m]}
            </button>
          ))}
        </div>
        <label>
          <span className={ETIQUETA}>Propina ($)</span>
          <input data-autofocus value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" placeholder="0.00" className={cn(CAMPO, "text-lg tabular-nums")} />
          {monto.trim() !== "" && !valido && <span className="mt-1 block text-xs text-destructive">Propina no válida (ej. 150).</span>}
        </label>
        {cuentas.length > 1 && (
          <fieldset>
            <legend className={ETIQUETA}>¿De qué cuenta?</legend>
            <div className="flex flex-col gap-1">
              {[{ id: null as string | null, nombre: "De la mesa (sin cuenta)" }, ...cuentas.map((c) => ({ id: c.id as string | null, nombre: c.cliente_nombre }))].map((c) => (
                <button
                  key={c.id ?? "mesa"}
                  type="button"
                  onClick={() => setCuentaId(c.id)}
                  aria-pressed={cuentaId === c.id}
                  className={cn("min-h-11 rounded-lg border px-3 text-left text-sm", cuentaId === c.id ? "border-caja-dorado text-caja-texto" : "border-caja-control text-caja-secundario")}
                >
                  {c.nombre}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        <label>
          <span className={ETIQUETA}>Nota (opcional)</span>
          <input value={nota} onChange={(e) => setNota(e.target.value)} maxLength={200} placeholder="Ej. la dejaron en la mesa" className={CAMPO} />
        </label>
      </div>
    </Hoja>
  );
}
