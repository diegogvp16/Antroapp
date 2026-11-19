"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AccionConMotivo,
  FilaMonto,
  MensajeError,
  useAccion,
} from "@/components/caja/accion";
import { CobroMesa } from "@/components/caja/cobro-mesa";
import { CuentaCliente } from "@/components/caja/cuenta-cliente";
import { SentarCliente } from "@/components/caja/sentar-cliente";
import { cn } from "@/lib/utils";
import {
  ESTADO_MESA_BADGE,
  ESTADO_MESA_LABEL,
  estadoMesa,
  formatearCentavos,
  horaCorta,
  METODO_LABEL,
  METODOS_PAGO,
  nombreODefault,
  ordenarSesiones,
  resumenSesion,
  type CajaCuadre,
  type DatosCaja,
  type MesaCaja,
  type MesaSesion,
  type PermisosCaja,
  type ResumenCaja,
} from "@/lib/domain/caja";

export function MesaDetalle({
  mesa,
  datos,
  permisos,
  onCambio,
  onVolver,
  onAbrir,
  abriendo,
}: {
  mesa: MesaCaja;
  datos: DatosCaja;
  permisos: PermisosCaja;
  onCambio: () => Promise<void>;
  onVolver: () => void;
  onAbrir: (mesaId: string) => void;
  abriendo: boolean;
}) {
  const nocheAbierta = datos.noche?.estado !== "cerrada";
  const sesionesMesa = ordenarSesiones(datos.sesiones.filter((s) => s.mesa_id === mesa.id));
  const { sesion: sesionPrincipal, sePuedeAbrir } = estadoMesa(sesionesMesa);
  const [sesionElegida, setSesionElegida] = useState<string | null>(null);
  const sesion =
    sesionesMesa.find((s) => s.id === sesionElegida) ?? sesionPrincipal;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onVolver}>
          ← Mesas
        </Button>
        {nocheAbierta && permisos.abrir_mesa && sePuedeAbrir && (
          <Button type="button" size="sm" disabled={abriendo} onClick={() => onAbrir(mesa.id)}>
            {abriendo ? "Abriendo..." : sesionPrincipal ? "Abrir otra vez" : "Abrir mesa"}
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 break-words text-xl font-semibold">Mesa {mesa.numero}</h2>
        <Badge variant={ESTADO_MESA_BADGE[sesion?.estado ?? "libre"]}>
          {ESTADO_MESA_LABEL[sesion?.estado ?? "libre"]}
        </Badge>
      </div>

      {!nocheAbierta && (
        <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
          La noche ya está cerrada: todo queda en solo lectura.
        </p>
      )}

      {sesionesMesa.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Sesiones de la mesa">
          {sesionesMesa.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={sesion?.id === s.id}
              onClick={() => setSesionElegida(s.id)}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-xs text-muted-foreground",
                sesion?.id === s.id && "border-foreground text-foreground",
              )}
            >
              {i === 0 ? "Actual" : `Anterior ${i}`} · {ESTADO_MESA_LABEL[s.estado]} ·{" "}
              {horaCorta(s.abierta_en)}
            </button>
          ))}
        </div>
      )}

      {sesion ? (
        <DetalleSesion
          key={sesion.id}
          sesion={sesion}
          datos={datos}
          permisos={permisos}
          nocheAbierta={nocheAbierta}
          onCambio={onCambio}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Esta mesa no se ha abierto esta noche.
          {mesa.capacidad ? ` Capacidad: ${mesa.capacidad}.` : ""}
        </p>
      )}
    </div>
  );
}

function DetalleSesion({
  sesion,
  datos,
  permisos,
  nocheAbierta,
  onCambio,
}: {
  sesion: MesaSesion;
  datos: DatosCaja;
  permisos: PermisosCaja;
  nocheAbierta: boolean;
  onCambio: () => Promise<void>;
}) {
  const cuentas = datos.cuentas.filter((c) => c.sesion_id === sesion.id);
  const consumos = datos.consumos.filter((c) => c.sesion_id === sesion.id);
  const pagos = datos.pagos.filter((p) => p.sesion_id === sesion.id);
  const totales = resumenSesion(sesion.id, datos.consumos, datos.pagos);
  const abierta = sesion.estado === "abierta" && nocheAbierta;
  const cuadre = datos.cuadres.find((c) => c.tipo === "mesa" && c.sesion_id === sesion.id);

  return (
    <>
      <ResumenSesion totales={totales} />

      <p className="text-xs text-muted-foreground">
        Abierta por {nombreODefault(datos.nombres, sesion.abierta_por, "Equipo")} a las{" "}
        {horaCorta(sesion.abierta_en)}
        {sesion.cerrada_en ? ` · cerrada a las ${horaCorta(sesion.cerrada_en)}` : ""}
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">Cuentas</h3>
        {cuentas.length === 0 && (
          <p className="text-sm text-muted-foreground">Nadie sentado todavía.</p>
        )}
        {cuentas.map((c) => (
          <CuentaCliente
            key={c.id}
            cuenta={c}
            consumos={consumos.filter((k) => k.cuenta_id === c.id)}
            nombres={datos.nombres}
            editable={abierta}
            puedeRegistrar={permisos.registrar_consumo}
            puedeAnular={permisos.anular}
            onCambio={onCambio}
          />
        ))}
        {abierta && permisos.abrir_mesa && (
          <SentarCliente
            sesionId={sesion.id}
            reservas={datos.reservasSentables}
            nombres={datos.nombres}
            onCambio={onCambio}
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">Cobro</h3>
        <CobroMesa
          sesionId={sesion.id}
          cuentas={cuentas}
          pagos={pagos}
          saldo={totales.saldo}
          nombres={datos.nombres}
          editable={abierta}
          puedeCobrar={permisos.cobrar}
          puedeAnular={permisos.anular}
          onCambio={onCambio}
        />
      </section>

      {abierta && permisos.cerrar_mesa && (
        <CerrarMesa sesionId={sesion.id} saldo={totales.saldo} onCambio={onCambio} />
      )}

      {sesion.estado === "cerrada" && nocheAbierta && (
        <MesaCerrada sesion={sesion} totales={totales} permisos={permisos} onCambio={onCambio} />
      )}

      {sesion.estado === "cuadrada" && (
        <CuadreMesa cuadre={cuadre ?? null} sesion={sesion} nombres={datos.nombres} />
      )}
    </>
  );
}

function ResumenSesion({ totales }: { totales: ResumenCaja }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Dato etiqueta="Consumido" valor={formatearCentavos(totales.consumido)} />
      <Dato etiqueta="Cobrado" valor={formatearCentavos(totales.cobrado)} />
      <Dato
        etiqueta="Saldo"
        valor={formatearCentavos(totales.saldo)}
        className={cn(
          totales.saldo === 0 && "text-status-ok",
          totales.saldo > 0 && "text-status-warn",
          totales.saldo < 0 && "text-status-err",
        )}
      />
    </div>
  );
}

function Dato({
  etiqueta,
  valor,
  className,
}: {
  etiqueta: string;
  valor: string;
  className?: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex min-w-0 flex-col gap-0.5 px-3">
        <span className="text-xs text-muted-foreground">{etiqueta}</span>
        <span className={cn("text-sm font-semibold break-all tabular-nums sm:text-base", className)}>
          {valor}
        </span>
      </CardContent>
    </Card>
  );
}

function CerrarMesa({
  sesionId,
  saldo,
  onCambio,
}: {
  sesionId: string;
  saldo: number;
  onCambio: () => Promise<void>;
}) {
  const { ocupado, error, ejecutar } = useAccion();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      {saldo > 0 && (
        <p className="text-sm text-status-warn">
          Falta cobrar {formatearCentavos(saldo)} para cerrar la mesa.
        </p>
      )}
      {saldo < 0 && (
        <p className="text-sm text-status-err">
          Se cobró {formatearCentavos(-saldo)} de más: anula el pago equivocado para cerrar.
        </p>
      )}
      <MensajeError mensaje={error} />
      <Button
        type="button"
        size="lg"
        disabled={saldo !== 0 || ocupado}
        onClick={() =>
          ejecutar(() => createClient().rpc("caja_cerrar_mesa", { p_sesion_id: sesionId }), onCambio)
        }
      >
        {ocupado ? "Cerrando..." : "Cerrar mesa"}
      </Button>
    </div>
  );
}

function MesaCerrada({
  sesion,
  totales,
  permisos,
  onCambio,
}: {
  sesion: MesaSesion;
  totales: ResumenCaja;
  permisos: PermisosCaja;
  onCambio: () => Promise<void>;
}) {
  const [notas, setNotas] = useState("");
  const cuadrar = useAccion();
  const reabrir = useAccion();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cuadre de la mesa</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 text-sm">
          <FilaMonto etiqueta="Registrado" valor={formatearCentavos(totales.consumido)} fuerte />
          {METODOS_PAGO.map((m) => (
            <FilaMonto
              key={m}
              etiqueta={`Cobrado en ${METODO_LABEL[m].toLowerCase()}`}
              valor={formatearCentavos(totales.porMetodo[m])}
            />
          ))}
          <FilaMonto etiqueta="Total cobrado" valor={formatearCentavos(totales.cobrado)} fuerte />
        </div>

        {permisos.cuadrar_mesa && (
          <form
            className="flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              await cuadrar.ejecutar(
                () =>
                  createClient().rpc("caja_cuadrar_mesa", {
                    p_sesion_id: sesion.id,
                    p_notas: notas.trim() || null,
                  }),
                onCambio,
              );
            }}
          >
            <Label htmlFor={`notas-${sesion.id}`}>Notas</Label>
            <Input
              id={`notas-${sesion.id}`}
              placeholder="Opcional"
              maxLength={500}
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Al cuadrar, la mesa queda definitiva y aquí nacen las comisiones de los RPs de sus
              cuentas.
            </p>
            <MensajeError mensaje={cuadrar.error} />
            <Button type="submit" disabled={cuadrar.ocupado}>
              {cuadrar.ocupado ? "Cuadrando..." : "Cuadrar mesa"}
            </Button>
          </form>
        )}

        {permisos.reabrir_mesa && (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <AccionConMotivo
              etiqueta="Reabrir mesa"
              etiquetaConfirmar="Reabrir"
              placeholder="Motivo de la reapertura"
              onConfirmar={(motivo) =>
                reabrir.ejecutar(
                  () =>
                    createClient().rpc("caja_reabrir_mesa", {
                      p_sesion_id: sesion.id,
                      p_motivo: motivo,
                    }),
                  onCambio,
                )
              }
            />
            <MensajeError mensaje={reabrir.error} />
          </div>
        )}

        {!permisos.cuadrar_mesa && !permisos.reabrir_mesa && (
          <p className="text-sm text-muted-foreground">
            La mesa está cerrada. Un gerente la cuadra al final.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CuadreMesa({
  cuadre,
  sesion,
  nombres,
}: {
  cuadre: CajaCuadre | null;
  sesion: MesaSesion;
  nombres: Record<string, string>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mesa cuadrada</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {cuadre ? (
          <>
            <FilaMonto etiqueta="Registrado" valor={formatearCentavos(cuadre.registrado_centavos)} fuerte />
            <FilaMonto etiqueta="Efectivo" valor={formatearCentavos(cuadre.cobrado_efectivo_centavos)} />
            <FilaMonto etiqueta="Tarjeta" valor={formatearCentavos(cuadre.cobrado_tarjeta_centavos)} />
            <FilaMonto etiqueta="Otro" valor={formatearCentavos(cuadre.cobrado_otro_centavos)} />
            {cuadre.notas && <p className="break-words text-muted-foreground">Notas: {cuadre.notas}</p>}
          </>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Cuadrada por{" "}
          {nombreODefault(nombres, cuadre?.hecho_por ?? sesion.cuadrada_por, "Equipo")}
          {sesion.cuadrada_en ? ` a las ${horaCorta(sesion.cuadrada_en)}` : ""}. Es definitiva:
          solo lectura.
        </p>
      </CardContent>
    </Card>
  );
}
