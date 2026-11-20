"use client";

import { useState } from "react";
import { ArrowLeft, ChevronDown, Lock, MoreHorizontal } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { BotonPrincipal } from "@/components/caja/hoja";
import { MensajeError, useAccion } from "@/components/caja/accion";
import { HojaCobro, HojaConsumo, HojaCuadrar, HojaMotivo, HojaRecibir, type RenglonNuevo } from "@/components/caja/hojas-mesa";
import {
  armarConcepto,
  formatearCentavos,
  horaCorta,
  leerRenglon,
  nombreMesa,
  productosDeLaNoche,
  resumenSesion,
  type CajaConsumo,
  type CajaPago,
  type DatosCaja,
  type MesaSesion,
  type MetodoPago,
  type PermisosCaja,
  type ResumenMesa,
} from "@/lib/domain/caja";

type HojaAbierta = "consumo" | "cobro" | "recibir" | "cuadrar" | "reabrir" | null;
type Anulacion = { tipo: "consumo"; fila: CajaConsumo } | { tipo: "pago"; fila: CajaPago } | null;

const ESTADO: Record<ResumenMesa["estado"], { texto: string; clase: string }> = {
  libre: { texto: "Libre", clase: "text-caja-secundario" },
  abierta: { texto: "Abierta", clase: "text-caja-dorado" },
  por_cuadrar: { texto: "Por cuadrar", clase: "text-caja-aviso" },
  cuadrada: { texto: "Cuadrada", clase: "text-caja-secundario" },
};

export function DetalleMesa({
  m,
  datos,
  permisos,
  esGerente,
  nocheCerrada,
  onVolver,
  onCambio,
}: {
  m: ResumenMesa;
  datos: DatosCaja;
  permisos: PermisosCaja;
  esGerente: boolean;
  nocheCerrada: boolean;
  onVolver: () => void;
  onCambio: () => Promise<void>;
}) {
  const accion = useAccion();
  const [hoja, setHoja] = useState<HojaAbierta>(null);
  const [anulacion, setAnulacion] = useState<Anulacion>(null);
  const [menu, setMenu] = useState(false);
  const [verAnulados, setVerAnulados] = useState(false);

  const sesion = m.estado === "cuadrada" ? null : m.sesion; // grupo actual (abierto o por cuadrar)
  const cuadradosNoche = m.estado === "cuadrada" && m.sesion ? [...m.anteriores, m.sesion] : m.anteriores;
  const consumos = sesion ? datos.consumos.filter((c) => c.sesion_id === sesion.id) : [];
  const pagos = sesion ? datos.pagos.filter((p) => p.sesion_id === sesion.id) : [];
  const vigentes = consumos.filter((c) => !c.anulado);
  const anulados = consumos.filter((c) => c.anulado);
  const abierta = m.estado === "abierta" && !nocheCerrada;
  const puedeRecibir = (m.estado === "libre" || m.estado === "cuadrada") && permisos.abrir_mesa && !nocheCerrada;

  const cerrarHoja = () => {
    setHoja(null);
    setAnulacion(null);
    accion.limpiarError();
  };
  const tras = async () => {
    await onCambio();
    cerrarHoja();
  };
  const rpc = createClient();

  async function recibir(op: { reservaId: string } | { nombre: string; personas: number }) {
    let sesionId = abierta ? m.sesion?.id ?? null : null;
    if (!sesionId) {
      const r = await rpc.rpc("caja_abrir_mesa", { p_mesa_id: m.mesa.id });
      if (r.error) {
        await accion.ejecutar(async () => r);
        return;
      }
      sesionId = r.data as string;
    }
    await accion.ejecutar(
      () =>
        rpc.rpc(
          "caja_sentar_cliente",
          "reservaId" in op
            ? { p_sesion_id: sesionId, p_reservation_id: op.reservaId }
            : { p_sesion_id: sesionId, p_cliente_nombre: op.nombre, p_personas: op.personas },
        ),
      tras,
    );
  }

  async function agregar(renglones: RenglonNuevo[], cuentaId: string) {
    // Un cargo por renglón ("N × producto" con su total). Se detiene en el
    // primer error y deja ver lo que sí entró.
    for (const r of renglones) {
      const ok = await accion.ejecutar(() =>
        rpc.rpc("caja_registrar_consumo", {
          p_cuenta_id: cuentaId,
          p_monto_centavos: r.cantidad * r.unitario,
          p_concepto: armarConcepto(r.cantidad, r.producto),
        }),
      );
      if (!ok) {
        await onCambio();
        return;
      }
    }
    await tras();
  }

  async function cobrar(metodo: MetodoPago, centavos: number, referencia: string) {
    if (!sesion) return;
    await accion.ejecutar(
      () => rpc.rpc("caja_registrar_pago", { p_sesion_id: sesion.id, p_cuenta_id: null, p_metodo: metodo, p_monto_centavos: centavos, p_referencia: referencia || null }),
      tras,
    );
  }

  async function cerrarMesa() {
    if (!sesion) return;
    await accion.ejecutar(() => rpc.rpc("caja_cerrar_mesa", { p_sesion_id: sesion.id }), onCambio);
  }

  async function cuadrar(notas: string) {
    if (!sesion) return;
    if (sesion.estado === "abierta") {
      const ok = await accion.ejecutar(() => rpc.rpc("caja_cerrar_mesa", { p_sesion_id: sesion.id }));
      if (!ok) return;
    }
    await accion.ejecutar(() => rpc.rpc("caja_cuadrar_mesa", { p_sesion_id: sesion.id, p_notas: notas || null }), tras);
  }

  async function anular(motivo: string) {
    if (!anulacion) return;
    await accion.ejecutar(
      () =>
        anulacion.tipo === "consumo"
          ? rpc.rpc("caja_anular_consumo", { p_consumo_id: anulacion.fila.id, p_motivo: motivo })
          : rpc.rpc("caja_anular_pago", { p_pago_id: anulacion.fila.id, p_motivo: motivo }),
      tras,
    );
  }

  async function reabrir(motivo: string) {
    if (!sesion) return;
    await accion.ejecutar(() => rpc.rpc("caja_reabrir_mesa", { p_sesion_id: sesion.id, p_motivo: motivo }), tras);
  }

  // ---------- Botón principal según el paso ----------
  let principal: { texto: string; accion: () => void; tono?: "dorado" | "aviso" } | null = null;
  let nota: string | null = null;
  if (nocheCerrada) nota = "La noche ya está cerrada.";
  else if (puedeRecibir) principal = { texto: m.estado === "cuadrada" ? "Recibir nuevo grupo" : "Recibir grupo", accion: () => setHoja("recibir") };
  else if (m.estado === "abierta" && m.cuentas.length === 0 && permisos.abrir_mesa) principal = { texto: "Sentar cliente", accion: () => setHoja("recibir") };
  else if (m.estado === "abierta" && m.saldo > 0) {
    if (permisos.cobrar) principal = { texto: `Cobrar ${formatearCentavos(m.saldo)}`, accion: () => setHoja("cobro") };
  } else if (m.estado === "abierta" && m.consumo === 0 && m.cobrado === 0) {
    // Grupo recién sentado: lo siguiente es consumir, no cuadrar.
    if (permisos.registrar_consumo) principal = { texto: "Agregar consumo", accion: () => setHoja("consumo") };
  } else if (m.estado === "abierta") {
    if (permisos.cuadrar_mesa) principal = { texto: "Cuadrar mesa", accion: () => setHoja("cuadrar") };
    else if (permisos.cerrar_mesa) principal = { texto: "Cerrar mesa", accion: () => void cerrarMesa() };
  } else if (m.estado === "por_cuadrar") {
    if (permisos.cuadrar_mesa) principal = { texto: "Cuadrar mesa", tono: "aviso", accion: () => setHoja("cuadrar") };
    else nota = "Pagada y cerrada. Falta que el gerente la cuadre.";
  }

  const porMetodo = (metodo: MetodoPago) => pagos.filter((p) => p.metodo === metodo);
  const totalMetodo = (metodo: MetodoPago) => porMetodo(metodo).filter((p) => !p.anulado).reduce((s, p) => s + p.monto_centavos, 0);
  const acciones = [
    abierta && permisos.abrir_mesa && m.cuentas.length > 0 && { texto: "Sentar a otro cliente", hacer: () => setHoja("recibir") },
    abierta && permisos.cerrar_mesa && m.saldo <= 0 && permisos.cuadrar_mesa && { texto: "Solo cerrar (cuadrar después)", hacer: () => void cerrarMesa() },
    m.estado === "por_cuadrar" && esGerente && permisos.reabrir_mesa && !nocheCerrada && { texto: "Abrir otra vez…", hacer: () => setHoja("reabrir") },
  ].filter(Boolean) as { texto: string; hacer: () => void }[];

  return (
    <div className="flex min-h-[calc(100dvh-1rem)] flex-col">
      {/* Barra superior */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={onVolver} aria-label="Volver a las mesas" className="-ml-2 flex size-11 items-center justify-center rounded-md text-caja-secundario hover:text-caja-texto">
          <ArrowLeft className="size-5" />
        </button>
        <span className="rounded-md border border-caja-borde px-2 py-1 text-xs">{nombreMesa(m.mesa.numero)}</span>
        <span className={cn("text-sm", ESTADO[m.estado].clase)}>{ESTADO[m.estado].texto}</span>
        {acciones.length > 0 && (
          <div className="relative ml-auto">
            <button type="button" onClick={() => setMenu((v) => !v)} aria-expanded={menu} aria-label="Más acciones" className="flex size-11 items-center justify-center rounded-md text-caja-secundario hover:text-caja-texto">
              <MoreHorizontal className="size-5" />
            </button>
            {menu && (
              <ul className="absolute right-0 z-20 mt-1 w-60 rounded-lg border border-caja-borde bg-caja-superficie py-1">
                {acciones.map((a) => (
                  <li key={a.texto}>
                    <button
                      type="button"
                      onClick={() => {
                        setMenu(false);
                        a.hacer();
                      }}
                      className="flex h-11 w-full items-center px-3 text-left text-sm hover:bg-caja-fondo"
                    >
                      {a.texto}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Cliente y saldo */}
      {sesion ? (
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-[21px] font-semibold leading-tight">
              {m.cliente ?? "Sin cliente"}
              {m.otrosClientes > 0 && <span className="text-caja-secundario"> +{m.otrosClientes}</span>}
            </p>
            <p className="mt-0.5 text-sm text-caja-secundario">
              {m.personas > 0 ? `${m.personas} personas` : "—"} · {m.rps.length ? `RP ${m.rps.join(", ")}` : "Sin RP"}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs text-caja-secundario">Saldo</p>
            <p className={cn("text-[21px] font-semibold tabular-nums leading-tight", m.saldo > 0 ? "text-caja-dorado" : "text-caja-ok")}>{formatearCentavos(m.saldo)}</p>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[21px] font-semibold leading-tight text-caja-secundario">{m.estado === "cuadrada" ? "Mesa libre (cuadrada)" : "Mesa libre"}</p>
      )}
      {sesion && (
        <p className="mt-1 text-sm text-caja-secundario tabular-nums">
          Consumo <span className="text-caja-texto">{formatearCentavos(m.consumo)}</span> · Cobrado <span className="text-caja-texto">{formatearCentavos(m.cobrado)}</span>
        </p>
      )}

      {/* Grupos ya cuadrados esta noche: colapsados y bloqueados */}
      {cuadradosNoche.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {cuadradosNoche.map((s, i) => (
            <GrupoCuadrado key={s.id} numero={i + 1} sesion={s} datos={datos} />
          ))}
          <p className="text-xs text-caja-secundario tabular-nums">
            Total de la mesa en la noche: <span className="text-caja-texto">{formatearCentavos(m.consumoNoche)}</span>
          </p>
        </div>
      )}

      {sesion && (
        <>
          {/* Consumo */}
          <section className="mt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Consumo</h3>
              {abierta && permisos.registrar_consumo && m.cuentas.length > 0 && (
                <button type="button" onClick={() => setHoja("consumo")} className="-mr-2 h-11 px-2 text-sm font-medium text-caja-dorado">
                  + Agregar consumo
                </button>
              )}
            </div>
            {vigentes.length === 0 ? (
              <p className="py-2 text-sm text-caja-secundario">Sin consumo todavía.</p>
            ) : (
              <ul className="divide-y divide-caja-borde rounded-lg border border-caja-borde bg-caja-superficie">
                {vigentes.map((c) => {
                  const r = leerRenglon(c.concepto, c.monto_centavos);
                  const tocable = abierta && permisos.anular;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        disabled={!tocable}
                        onClick={() => setAnulacion({ tipo: "consumo", fila: c })}
                        className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm disabled:cursor-default"
                      >
                        <span className="min-w-0 truncate">
                          {r.cantidad} × {r.producto}
                          <span className="text-caja-secundario"> · {formatearCentavos(r.unitario)}</span>
                        </span>
                        <span className="shrink-0 tabular-nums">{formatearCentavos(r.total)}</span>
                      </button>
                    </li>
                  );
                })}
                <li className="flex items-center justify-between px-3 py-2 text-sm font-medium">
                  <span>Total</span>
                  <span className="tabular-nums">{formatearCentavos(m.consumo)}</span>
                </li>
              </ul>
            )}
            {anulados.length > 0 && (
              <div className="mt-1">
                <button type="button" onClick={() => setVerAnulados((v) => !v)} className="flex h-11 items-center gap-1 text-xs text-caja-secundario">
                  <ChevronDown className={cn("size-3.5 transition-transform", verAnulados && "rotate-180")} />
                  {anulados.length === 1 ? "1 cargo anulado" : `${anulados.length} cargos anulados`}
                </button>
                {verAnulados && (
                  <ul className="flex flex-col gap-1 text-xs text-caja-secundario">
                    {anulados.map((c) => {
                      const r = leerRenglon(c.concepto, c.monto_centavos);
                      return (
                        <li key={c.id}>
                          <span className="line-through">
                            {r.cantidad} × {r.producto} · {formatearCentavos(r.total)}
                          </span>{" "}
                          — {c.motivo_anulacion}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* Cobros por forma de pago */}
          {pagos.length > 0 && (
            <section className="mt-4">
              <h3 className="mb-1 text-sm font-medium">Cobros</h3>
              <div className="flex flex-col gap-2">
                {(["efectivo", "tarjeta", "otro"] as const)
                  .filter((mt) => porMetodo(mt).length > 0)
                  .map((mt) => (
                    <div key={mt} className="rounded-lg border border-caja-borde bg-caja-superficie">
                      <div className="flex items-center justify-between px-3 py-2 text-sm">
                        <span>{mt === "efectivo" ? "Efectivo" : mt === "tarjeta" ? "Tarjeta" : "Otro"}</span>
                        <span className="tabular-nums">{formatearCentavos(totalMetodo(mt))}</span>
                      </div>
                      <ul className="divide-y divide-caja-borde border-t border-caja-borde text-xs text-caja-secundario">
                        {porMetodo(mt).map((p) => (
                          <li key={p.id}>
                            <button
                              type="button"
                              disabled={p.anulado || !(abierta && permisos.anular)}
                              onClick={() => setAnulacion({ tipo: "pago", fila: p })}
                              className="flex min-h-11 w-full items-center justify-between px-3 text-left disabled:cursor-default"
                            >
                              <span className={cn(p.anulado && "line-through")}>
                                {horaCorta(p.registrado_en)}
                                {p.referencia ? ` · ${p.referencia}` : ""}
                                {p.anulado ? ` — ${p.motivo_anulacion}` : ""}
                              </span>
                              <span className={cn("tabular-nums", p.anulado && "line-through")}>{formatearCentavos(p.monto_centavos)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Acción principal fija abajo */}
      <div className="sticky bottom-0 mt-auto bg-caja-fondo pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {hoja === null && <MensajeError mensaje={accion.error} />}
        {principal ? (
          <BotonPrincipal tono={principal.tono} disabled={accion.ocupado} onClick={principal.accion}>
            {accion.ocupado && hoja === null ? "Guardando..." : principal.texto}
          </BotonPrincipal>
        ) : (
          nota && <p className="text-center text-sm text-caja-secundario">{nota}</p>
        )}
      </div>

      {hoja === "recibir" && (
        <HojaRecibir
          abierta
          onCerrar={cerrarHoja}
          titulo={`${puedeRecibir && m.estado === "cuadrada" ? "Recibir nuevo grupo" : "Sentar cliente"} · ${nombreMesa(m.mesa.numero)}`}
          reservas={datos.reservasSentables}
          nombres={datos.nombres}
          ocupado={accion.ocupado}
          error={accion.error}
          onRecibir={(op) => void recibir(op)}
        />
      )}
      {hoja === "consumo" && (
        <HojaConsumo
          abierta
          onCerrar={cerrarHoja}
          productos={productosDeLaNoche(datos.consumos)}
          cuentas={m.cuentas}
          ocupado={accion.ocupado}
          error={accion.error}
          onAgregar={(r, cuenta) => void agregar(r, cuenta)}
        />
      )}
      {hoja === "cobro" && (
        <HojaCobro abierta onCerrar={cerrarHoja} saldo={m.saldo} ocupado={accion.ocupado} error={accion.error} onCobrar={(mt, c, ref) => void cobrar(mt, c, ref)} />
      )}
      {hoja === "cuadrar" && (
        <HojaCuadrar
          abierta
          onCerrar={cerrarHoja}
          consumo={m.consumo}
          cobrado={m.cobrado}
          cerrarAntes={m.estado === "abierta"}
          ocupado={accion.ocupado}
          error={accion.error}
          onCuadrar={(n) => void cuadrar(n)}
        />
      )}
      {hoja === "reabrir" && (
        <HojaMotivo
          abierta
          onCerrar={cerrarHoja}
          titulo="Abrir otra vez la mesa"
          descripcion="La mesa vuelve a abierta para corregir cargos o cobros. Queda en la bitácora con tu nombre y el motivo."
          boton="Abrir otra vez"
          ocupado={accion.ocupado}
          error={accion.error}
          onConfirmar={(mo) => void reabrir(mo)}
        />
      )}
      {anulacion && (
        <HojaMotivo
          abierta
          onCerrar={cerrarHoja}
          titulo={anulacion.tipo === "consumo" ? "Anular cargo" : "Anular cobro"}
          descripcion={
            anulacion.tipo === "consumo"
              ? `${(() => {
                  const r = leerRenglon(anulacion.fila.concepto, anulacion.fila.monto_centavos);
                  return `${r.cantidad} × ${r.producto} · ${formatearCentavos(r.total)}`;
                })()}. No se borra: queda tachado con el motivo.`
              : `${formatearCentavos(anulacion.fila.monto_centavos)} a las ${horaCorta(anulacion.fila.registrado_en)}. No se borra: queda tachado con el motivo.`
          }
          boton={`Anular ${formatearCentavos(anulacion.fila.monto_centavos)}`}
          ocupado={accion.ocupado}
          error={accion.error}
          onConfirmar={(mo) => void anular(mo)}
        />
      )}
    </div>
  );
}

// Grupo ya cuadrado: colapsado y bloqueado; se puede ver, nunca cambiar.
function GrupoCuadrado({ numero, sesion, datos }: { numero: number; sesion: MesaSesion; datos: DatosCaja }) {
  const [abierto, setAbierto] = useState(false);
  const cuentas = datos.cuentas.filter((c) => c.sesion_id === sesion.id);
  const r = resumenSesion(sesion.id, datos.consumos, datos.pagos);
  const consumos = datos.consumos.filter((c) => c.sesion_id === sesion.id && !c.anulado);
  return (
    <div className="rounded-lg border border-caja-borde bg-caja-superficie/60">
      <button type="button" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto} className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm text-caja-secundario">
        <Lock className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caja-texto/80">
            Grupo {numero} · {cuentas[0]?.cliente_nombre ?? "Sin cliente"}
          </span>
          <span className="block text-xs">Cuadrado · no se modifica</span>
        </span>
        <span className="tabular-nums text-caja-texto">{formatearCentavos(r.consumido)}</span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", abierto && "rotate-180")} />
      </button>
      {abierto && (
        <ul className="border-t border-caja-borde px-3 py-2 text-xs text-caja-secundario">
          {consumos.map((c) => {
            const x = leerRenglon(c.concepto, c.monto_centavos);
            return (
              <li key={c.id} className="flex justify-between gap-2 py-0.5">
                <span className="truncate">
                  {x.cantidad} × {x.producto}
                </span>
                <span className="tabular-nums">{formatearCentavos(x.total)}</span>
              </li>
            );
          })}
          <li className="mt-1 flex justify-between gap-2">
            <span>Cobrado</span>
            <span className="tabular-nums">{formatearCentavos(r.cobrado)}</span>
          </li>
        </ul>
      )}
    </div>
  );
}
