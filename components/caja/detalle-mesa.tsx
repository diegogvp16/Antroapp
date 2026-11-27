"use client";

import { useState } from "react";
import { ArrowLeft, ChevronDown, CloudUpload, Lock, MoreHorizontal } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useFase2 } from "@/lib/fase2-contexto";
import { totalPropinas } from "@/lib/domain/propinas";
import { PropinaSinMesa, PropinasMesa, usePropinasSueltas } from "@/components/propinas/propinas-mesa";
import { BotonPrincipal } from "@/components/caja/hoja";
import { MensajeError, useAccion } from "@/components/caja/accion";
import { HojaCobro, HojaConsumo, HojaCuadrar, HojaMotivo, HojaRecibir, type RenglonNuevo } from "@/components/caja/hojas-mesa";
import { AvisoColaMesa } from "@/components/caja/cola-caja";
import { textoPorEnviar, type MovimientoPendiente, type NuevoMovimiento } from "@/lib/domain/caja-cola";
import type { ResultadoEnvio } from "@/lib/use-cola-caja";
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
  sinConexion,
  movimientos = [],
  onEnviar,
  onDescartar,
  onEnviarAhora,
  enviandoCola = false,
  onVolver,
  onCambio,
}: {
  // Con lo pendiente de enviar ya sumado (consumo, cobrado y saldo).
  m: ResumenMesa;
  datos: DatosCaja;
  permisos: PermisosCaja;
  esGerente: boolean;
  nocheCerrada: boolean;
  sinConexion: boolean;
  // Cola de caja de esta mesa (pendientes y rechazados).
  movimientos?: MovimientoPendiente[];
  // Guarda en el teléfono y manda a la base (lib/use-cola-caja.ts).
  onEnviar: (nuevos: Omit<NuevoMovimiento, "clubId">[]) => Promise<ResultadoEnvio>;
  onDescartar: (claves: string[]) => void;
  // Mandar ya lo que esté en la cola (sin esperar el siguiente reintento).
  onEnviarAhora?: () => void;
  // La cola se está mandando en este momento.
  enviandoCola?: boolean;
  onVolver: () => void;
  onCambio: () => Promise<void>;
}) {
  const accion = useAccion();
  const [hoja, setHoja] = useState<HojaAbierta>(null);
  const [anulacion, setAnulacion] = useState<Anulacion>(null);
  const [menu, setMenu] = useState(false);
  const [verAnulados, setVerAnulados] = useState(false);
  // "Guardado en este teléfono…" después de capturar sin señal.
  const [avisoCola, setAvisoCola] = useState<string | null>(null);

  const sesion = m.estado === "cuadrada" ? null : m.sesion; // grupo actual (abierto o por cuadrar)
  const cuadradosNoche = m.estado === "cuadrada" && m.sesion ? [...m.anteriores, m.sesion] : m.anteriores;
  const consumos = sesion ? datos.consumos.filter((c) => c.sesion_id === sesion.id) : [];
  const pagos = sesion ? datos.pagos.filter((p) => p.sesion_id === sesion.id) : [];
  const vigentes = consumos.filter((c) => !c.anulado);
  // Fase 2: propinas del grupo actual (aparte del cobro y del saldo): las del
  // cobro y las sueltas. Solo con la bandera «propinas» del antro.
  const fase2 = useFase2();
  const sueltas = usePropinasSueltas({ sesionId: sesion?.id ?? null, nocheId: datos.noche?.id ?? null }, fase2.propinas && !!sesion);
  const propinasMesa = fase2.propinas ? totalPropinas(pagos, sueltas.lista, sueltas.cobrosAnulados).total : 0;
  const anulados = consumos.filter((c) => c.anulado);
  // Lo capturado de este grupo que todavía no llega a la base.
  const porEnviarConsumos = sesion ? movimientos.filter((x) => x.estado === "pendiente" && x.sesionId === sesion.id && x.tipo !== "pago") : [];
  const porEnviarPagos = sesion ? movimientos.filter((x) => x.estado === "pendiente" && x.sesionId === sesion.id && x.tipo === "pago") : [];
  // Cerrar o cuadrar con algo de este grupo todavía en el teléfono: la base
  // cerraría la mesa sin eso y al llegar lo rechazaría ("la mesa ya está
  // cerrada"): un consumo que nunca se cobra o un cobro que no aparece. Por
  // eso primero se envía y después se cierra.
  const pendientesGrupo = porEnviarConsumos.length + porEnviarPagos.length;
  // m trae lo pendiente sumado; esto es lo que ya está en la base, que es lo
  // que de verdad se cierra y se cuadra.
  const consumoEnBase = m.consumo - porEnviarConsumos.reduce((s, x) => s + x.montoCentavos, 0);
  const cobradoEnBase = m.cobrado - porEnviarPagos.reduce((s, x) => s + x.montoCentavos, 0);
  const avisoPrimeroEnviar = `Para cerrar o cuadrar, primero tiene${pendientesGrupo === 1 ? "" : "n"} que llegar a la base ${
    pendientesGrupo === 1 ? "el movimiento de esta mesa que sigue" : `los ${pendientesGrupo} movimientos de esta mesa que siguen`
  } en este teléfono.`;
  const abierta = m.estado === "abierta" && !nocheCerrada;
  const puedeRecibir = (m.estado === "libre" || m.estado === "cuadrada") && permisos.abrir_mesa && !nocheCerrada;

  const cerrarHoja = () => {
    setAvisoCola(null);
    setHoja(null);
    setAnulacion(null);
    accion.limpiarError();
  };
  const tras = async () => {
    await onCambio();
    cerrarHoja();
  };
  const rpc = createClient();

  // Consumos y cobros pasan por la cola de caja: se guardan en el teléfono
  // y se mandan. Si la base los guardó, se cierra la hoja como siempre; si no
  // hay señal (o se perdió la respuesta), se cierra con el aviso y se mandan
  // solos después; si la base los rechaza, el motivo se queda en la hoja.
  async function terminarEnvio(res: ResultadoEnvio): Promise<boolean> {
    if (res.estado === "aplicado") {
      await tras();
      return true;
    }
    if (res.estado === "en_cola") {
      cerrarHoja();
      setAvisoCola("Guardado en este teléfono. Se envía solo al volver la señal; no lo captures otra vez.");
      return true;
    }
    await onCambio();
    accion.fallar(res.motivo);
    return false;
  }

  // Estado real de la sesión en la base: para que repetir "Cerrar" o
  // "Cuadrar" tras perder la respuesta termine bien en lugar de dar error.
  async function estadoEnBase(sesionId: string): Promise<MesaSesion["estado"] | null> {
    const { data } = await rpc.from("mesa_sesiones").select("estado").eq("id", sesionId).maybeSingle();
    return (data?.estado as MesaSesion["estado"] | undefined) ?? null;
  }

  function recibir(op: { reservaId: string } | { nombre: string; personas: number }) {
    return accion.correr(async (paso) => {
      let sesionId = abierta ? m.sesion?.id ?? null : null;
      if (!sesionId) {
        const r = await paso(() => rpc.rpc("caja_abrir_mesa", { p_mesa_id: m.mesa.id }));
        if (!r.ok) {
          // Otro staff pudo abrirla primero: al recargar se ve la sesión
          // abierta y el siguiente intento sienta ahí.
          await onCambio();
          return false;
        }
        sesionId = r.data as string;
      }
      const r = await paso(() =>
        rpc.rpc(
          "caja_sentar_cliente",
          "reservaId" in op
            ? { p_sesion_id: sesionId, p_reservation_id: op.reservaId }
            : { p_sesion_id: sesionId, p_cliente_nombre: op.nombre, p_personas: op.personas },
        ),
      );
      if (!r.ok) {
        await onCambio();
        return false;
      }
      await tras();
      return true;
    });
  }

  function agregar(renglones: RenglonNuevo[], cuentaId: string) {
    // Un cargo por renglón ("N × producto" con su total), cada uno con su
    // clave: si se reintenta, lo que ya entró no se duplica.
    if (!sesion) return;
    return accion.correr(async () => {
      const nuevos = renglones.map((r): Omit<NuevoMovimiento, "clubId"> => ({
        clave: r.clave,
        mesaId: m.mesa.id,
        sesionId: sesion.id,
        montoCentavos: r.cantidad * r.unitario,
        descripcion: armarConcepto(r.cantidad, r.producto),
        ...(r.producto_id
          ? // Fase 2: del catálogo. Precio y concepto los pone la base y descuenta existencias.
            { tipo: "consumo_producto" as const, args: { p_cuenta_id: cuentaId, p_producto_id: r.producto_id, p_cantidad: r.cantidad } }
          : {
              tipo: "consumo" as const,
              args: { p_cuenta_id: cuentaId, p_monto_centavos: r.cantidad * r.unitario, p_concepto: armarConcepto(r.cantidad, r.producto) },
            }),
      }));
      return terminarEnvio(await onEnviar(nuevos));
    });
  }

  function cobrar(metodo: MetodoPago, centavos: number, referencia: string, clave: string, saldoVisto: number, propina: number) {
    if (!sesion) return;
    return accion.correr(async () =>
      terminarEnvio(
        await onEnviar([
          {
            clave,
            mesaId: m.mesa.id,
            sesionId: sesion.id,
            tipo: "pago",
            montoCentavos: centavos,
            descripcion:
              (metodo === "efectivo" ? "Cobro en efectivo" : metodo === "tarjeta" ? "Cobro con tarjeta" : "Cobro") +
              (fase2.propinas && propina > 0 ? ` · propina ${formatearCentavos(propina)}` : ""),
            args: {
              p_sesion_id: sesion.id,
              p_cuenta_id: null,
              p_metodo: metodo,
              p_monto_centavos: centavos,
              p_referencia: referencia || null,
              // El saldo que el staff tiene en pantalla (con lo pendiente de
              // enviar): si otro ya cobró o agregó consumo, la base lo
              // rechaza en lugar de sobrepagar. Nunca se reintenta con otro.
              p_saldo_esperado: saldoVisto,
              // La propina solo se manda con la fase 2 y la bandera del antro
              // (sin ellas, el cobro es exactamente el de antes).
              ...(fase2.propinas ? { p_propina_centavos: propina } : {}),
            },
          },
        ]),
      ),
    );
  }

  function cerrarMesa() {
    if (!sesion) return;
    if (pendientesGrupo > 0) return accion.fallar(avisoPrimeroEnviar);
    return accion.correr(async (paso) => {
      const r = await paso(() => rpc.rpc("caja_cerrar_mesa", { p_sesion_id: sesion.id }));
      if (!r.ok && (await estadoEnBase(sesion.id)) !== "cerrada") {
        await onCambio();
        return false;
      }
      accion.limpiarError();
      await onCambio();
      return true;
    });
  }

  function cuadrar(notas: string) {
    if (!sesion) return;
    if (pendientesGrupo > 0) return accion.fallar(avisoPrimeroEnviar);
    return accion.correr(async (paso) => {
      // Se parte del estado real en la base, no del de la pantalla: un
      // reintento después de perder la respuesta continúa donde se quedó.
      let estado = (await estadoEnBase(sesion.id)) ?? sesion.estado;
      if (estado === "abierta") {
        const r = await paso(() => rpc.rpc("caja_cerrar_mesa", { p_sesion_id: sesion.id }));
        estado = r.ok ? "cerrada" : ((await estadoEnBase(sesion.id)) ?? "abierta");
        if (estado === "abierta") {
          await onCambio();
          return false;
        }
        accion.limpiarError();
      }
      if (estado === "cerrada") {
        const r = await paso(() => rpc.rpc("caja_cuadrar_mesa", { p_sesion_id: sesion.id, p_notas: notas || null }));
        if (!r.ok && (await estadoEnBase(sesion.id)) !== "cuadrada") {
          await onCambio();
          return false;
        }
      }
      // "cuadrada": ya quedó (por este envío o por uno anterior). Se cuadra
      // una sola vez: la base no deja otro cuadre ni otra comisión.
      accion.limpiarError();
      await tras();
      return true;
    });
  }

  function anular(motivo: string) {
    if (!anulacion) return;
    return accion.correr(async (paso) => {
      const r = await paso(() =>
        anulacion.tipo === "consumo"
          ? rpc.rpc("caja_anular_consumo", { p_consumo_id: anulacion.fila.id, p_motivo: motivo })
          : rpc.rpc("caja_anular_pago", { p_pago_id: anulacion.fila.id, p_motivo: motivo }),
      );
      if (!r.ok) {
        await onCambio();
        return false;
      }
      await tras();
      return true;
    });
  }

  function reabrir(motivo: string) {
    if (!sesion) return;
    return accion.ejecutar(() => rpc.rpc("caja_reabrir_mesa", { p_sesion_id: sesion.id, p_motivo: motivo }), tras);
  }

  // ---------- Botón principal según el paso ----------
  // sinRed: la acción se puede hacer sin señal (va a la cola de caja).
  // cierra: cerrar o cuadrar (esperan a que se envíe lo pendiente del grupo).
  let principal: { texto: string; accion: () => void; tono?: "dorado" | "aviso"; sinRed?: boolean; cierra?: boolean } | null = null;
  let nota: string | null = null;
  if (nocheCerrada) nota = "La noche ya está cerrada.";
  else if (puedeRecibir) principal = { texto: m.estado === "cuadrada" ? "Recibir nuevo grupo" : "Recibir grupo", accion: () => setHoja("recibir") };
  else if (m.estado === "abierta" && m.cuentas.length === 0 && permisos.abrir_mesa) principal = { texto: "Sentar cliente", accion: () => setHoja("recibir") };
  else if (m.estado === "abierta" && m.saldo > 0) {
    if (permisos.cobrar) principal = { texto: `Cobrar ${formatearCentavos(m.saldo)}`, accion: () => setHoja("cobro"), sinRed: true };
  } else if (m.estado === "abierta" && m.consumo === 0 && m.cobrado === 0) {
    // Grupo recién sentado: lo siguiente es consumir, no cuadrar.
    if (permisos.registrar_consumo) principal = { texto: "Agregar consumo", accion: () => setHoja("consumo"), sinRed: true };
  } else if (m.estado === "abierta") {
    if (permisos.cuadrar_mesa) principal = { texto: "Cuadrar mesa", accion: () => setHoja("cuadrar"), cierra: true };
    else if (permisos.cerrar_mesa) principal = { texto: "Cerrar mesa", accion: () => void cerrarMesa(), cierra: true };
  } else if (m.estado === "por_cuadrar") {
    if (permisos.cuadrar_mesa) principal = { texto: "Cuadrar mesa", tono: "aviso", accion: () => setHoja("cuadrar"), cierra: true };
    else nota = "Pagada y cerrada. Falta que el gerente la cuadre.";
  }

  const porMetodo = (metodo: MetodoPago) => pagos.filter((p) => p.metodo === metodo);
  const totalMetodo = (metodo: MetodoPago) => porMetodo(metodo).filter((p) => !p.anulado).reduce((s, p) => s + p.monto_centavos, 0);
  const acciones = [
    abierta && permisos.abrir_mesa && m.cuentas.length > 0 && { texto: "Sentar a otro cliente", hacer: () => setHoja("recibir") },
    abierta && permisos.cerrar_mesa && m.saldo <= 0 && permisos.cuadrar_mesa && pendientesGrupo === 0 && { texto: "Solo cerrar (cuadrar después)", hacer: () => void cerrarMesa() },
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
          {propinasMesa > 0 && (
            <>
              {" "}
              · Propinas <span className="text-caja-texto">{formatearCentavos(propinasMesa)}</span>
            </>
          )}
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
            {vigentes.length === 0 && porEnviarConsumos.length === 0 ? (
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
                {porEnviarConsumos.map((x) => (
                  <FilaPorEnviar key={x.clave} texto={x.descripcion} monto={x.montoCentavos} />
                ))}
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
          {(pagos.length > 0 || porEnviarPagos.length > 0) && (
            <section className="mt-4">
              <h3 className="mb-1 text-sm font-medium">Cobros</h3>
              <div className="flex flex-col gap-2">
                {porEnviarPagos.length > 0 && (
                  <ul className="divide-y divide-caja-borde rounded-lg border border-dashed border-caja-aviso/60 bg-caja-superficie">
                    {porEnviarPagos.map((x) => (
                      <FilaPorEnviar key={x.clave} texto={x.descripcion} monto={x.montoCentavos} />
                    ))}
                  </ul>
                )}
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
                                {fase2.propinas && (p.propina_centavos ?? 0) > 0
                                  ? ` · propina ${formatearCentavos(p.propina_centavos ?? 0)}${sueltas.cobrosAnulados.has(p.id) ? " (anulada)" : ""}`
                                  : ""}
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

          {/* Fase 2: propinas sueltas (solo con la bandera «propinas»). */}
          <PropinasMesa
            nocheId={datos.noche?.id ?? null}
            sesionId={sesion.id}
            cuentas={m.cuentas}
            lista={sueltas.lista}
            puedeRegistrar={!nocheCerrada && permisos.cobrar}
            puedeAnular={!nocheCerrada && permisos.anular}
            sinConexion={sinConexion}
            onCambio={sueltas.recargar}
          />
        </>
      )}

      {/* Fase 2: mesa libre o ya cuadrada: la propina que dejaron va sin mesa. */}
      {!sesion && <PropinaSinMesa nocheId={datos.noche?.id ?? null} puedeRegistrar={!nocheCerrada && permisos.cobrar} sinConexion={sinConexion} />}

      <AvisoColaMesa movimientos={movimientos} sesionActual={sesion?.id ?? null} onDescartar={onDescartar} />

      {/* Acción principal fija abajo */}
      <div className="sticky bottom-0 mt-auto bg-caja-fondo pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {hoja === null && <MensajeError mensaje={accion.error} />}
        {/* Solo mientras siga habiendo algo por enviar en esta mesa. */}
        {hoja === null && avisoCola && movimientos.some((x) => x.estado === "pendiente") && (
          <p role="status" className="mb-2 flex items-start gap-2 text-sm text-caja-aviso">
            <CloudUpload className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {avisoCola}
          </p>
        )}
        {principal?.cierra && pendientesGrupo > 0 ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="flex items-start gap-2 text-sm text-caja-aviso">
              <CloudUpload className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {avisoPrimeroEnviar}
            </p>
            <BotonPrincipal disabled={sinConexion || enviandoCola || !onEnviarAhora} onClick={() => onEnviarAhora?.()}>
              {sinConexion
                ? `Sin conexión · ${textoPorEnviar(pendientesGrupo)}`
                : enviandoCola
                  ? `Enviando · ${textoPorEnviar(pendientesGrupo)}`
                  : `Enviar ahora · ${textoPorEnviar(pendientesGrupo)}`}
            </BotonPrincipal>
          </div>
        ) : principal ? (
          <BotonPrincipal tono={principal.tono} disabled={accion.ocupado || (sinConexion && !principal.sinRed)} onClick={principal.accion}>
            {sinConexion && !principal.sinRed ? "Sin conexión" : accion.ocupado && hoja === null ? "Guardando..." : principal.texto}
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
          sinConexion={sinConexion}
          error={accion.error}
          onRecibir={(op) => void recibir(op)}
        />
      )}
      {hoja === "consumo" && (
        <HojaConsumo
          abierta
          onCerrar={cerrarHoja}
          productos={productosDeLaNoche(datos.consumos)}
          catalogo={datos.productos}
          cuentas={m.cuentas}
          ocupado={accion.ocupado}
          sinConexion={sinConexion}
          error={accion.error}
          onAgregar={(r, cuenta) => void agregar(r, cuenta)}
        />
      )}
      {hoja === "cobro" && (
        <HojaCobro
          abierta
          onCerrar={cerrarHoja}
          saldo={m.saldo}
          ocupado={accion.ocupado}
          sinConexion={sinConexion}
          error={accion.error}
          onCobrar={(mt, c, ref, clave, saldoVisto, propina) => void cobrar(mt, c, ref, clave, saldoVisto, propina)}
        />
      )}
      {hoja === "cuadrar" && (
        <HojaCuadrar
          abierta
          onCerrar={cerrarHoja}
          consumo={consumoEnBase}
          cobrado={cobradoEnBase}
          bloqueo={pendientesGrupo > 0 ? avisoPrimeroEnviar : null}
          propinas={propinasMesa}
          cerrarAntes={m.estado === "abierta"}
          ocupado={accion.ocupado}
          sinConexion={sinConexion}
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
          sinConexion={sinConexion}
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
          sinConexion={sinConexion}
          error={accion.error}
          onConfirmar={(mo) => void anular(mo)}
        />
      )}
    </div>
  );
}

// Renglón capturado que sigue en el teléfono (cola de caja).
function FilaPorEnviar({ texto, monto }: { texto: string; monto: number }) {
  return (
    <li className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm">
      <span className="flex min-w-0 items-center gap-1.5">
        <CloudUpload className="size-3.5 shrink-0 text-caja-aviso" aria-hidden="true" />
        <span className="truncate">{texto}</span>
        <span className="shrink-0 text-xs text-caja-aviso">· por enviar</span>
      </span>
      <span className="shrink-0 tabular-nums">{formatearCentavos(monto)}</span>
    </li>
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
