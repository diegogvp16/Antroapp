import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatearCentavos } from "@/lib/domain/caja";
import { ALERTA_REGLA, describirRegla, ordenarAntros, type EstadoReglasAntro } from "@/lib/domain/salud";
import { formatearFechaLarga } from "@/lib/fechas";

const fechaCorta = (f: string) => formatearFechaLarga(`${f.slice(0, 10)}T12:00:00Z`);

// Estado de las reglas de pago de RPs por antro (solo lectura). Para
// cambiarlas está la configuración del antro (dueño o gerente).
export function ReglasComisionEstado({ filas }: { filas: EstadoReglasAntro[] }) {
  const ordenadas = ordenarAntros(filas);
  const conAlerta = filas.filter((f) => f.alertas.some((a) => ALERTA_REGLA[a]?.tono === "err")).length;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Reglas de pago de RPs</h2>
      <p className="text-sm text-muted-foreground">
        {filas.length} antros · {conAlerta === 0 ? "ninguno con alertas rojas" : `${conAlerta} con alertas rojas`}. Semana de lunes a domingo,
        por la noche de la reserva.
      </p>
      {ordenadas.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hay antros todavía.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {ordenadas.map((f) => (
            <li key={f.club_id} data-antro={f.club_id}>
              <Card size="sm">
                <CardContent className="flex flex-col gap-2 px-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words font-medium">{f.nombre}</span>
                    <Badge variant={f.publicado ? "ok" : "neutral"}>{f.publicado ? "Publicado" : "No publicado"}</Badge>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Pago</dt>
                    <dd>{f.modo_pago === "dia" ? `Por día de asistencia (${f.tarifas_dia} tarifas)` : "Por reserva"}</dd>
                    {f.modo_pago === "reserva" && (
                      <>
                        <dt className="text-muted-foreground">Regla</dt>
                        <dd>
                          {describirRegla(f.regla)}
                          <span className="text-muted-foreground">
                            {f.regla?.origen === "regla"
                              ? f.regla.vigente_desde
                                ? ` · desde ${fechaCorta(f.regla.vigente_desde)}`
                                : ""
                              : " · configuración anterior"}
                          </span>
                        </dd>
                        {f.programada && (
                          <>
                            <dt className="text-muted-foreground">Programada</dt>
                            <dd>
                              {describirRegla(f.programada)}
                              {f.programada.vigente_desde && (
                                <span className="text-muted-foreground"> · desde {fechaCorta(f.programada.vigente_desde)}</span>
                              )}
                            </dd>
                          </>
                        )}
                      </>
                    )}
                    <dt className="text-muted-foreground">RPs</dt>
                    <dd>
                      {f.rps_activos} {f.rps_activos === 1 ? "activo" : "activos"}
                      {f.modo_pago === "reserva"
                        ? f.rps_con_regla_propia
                          ? ` · ${f.rps_con_regla_propia} con regla propia`
                          : ""
                        : f.rps_con_tarifa_dia_propia
                          ? ` · ${f.rps_con_tarifa_dia_propia} con tarifa propia`
                          : ""}
                    </dd>
                    <dt className="text-muted-foreground">Semana</dt>
                    <dd className="tabular-nums">
                      {f.modo_pago === "dia"
                        ? `${f.pagos_dia_semana} pagos por día · ${formatearCentavos(Number(f.pagos_dia_semana_centavos))}`
                        : `${f.comisiones_semana} comisiones${f.comisiones_semana_en_cero ? ` (${f.comisiones_semana_en_cero} en $0)` : ""} · ${formatearCentavos(Number(f.comision_semana_centavos))}`}
                    </dd>
                  </dl>
                  {f.alertas.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {f.alertas.map((a) => {
                        const info = ALERTA_REGLA[a] ?? { texto: a, tono: "warn" as const };
                        const cuantas =
                          a === "regla_id_inconsistente"
                            ? f.comisiones_inconsistentes
                            : a === "noche_sin_cerrar"
                              ? f.noches_sin_cerrar
                              : a === "pendientes_viejas"
                                ? f.pendientes_viejas
                                : null;
                        return (
                          <li key={a}>
                            <Badge variant={info.tono} className="h-auto whitespace-normal py-1 text-left">
                              {info.texto}
                              {cuantas ? ` (${cuantas})` : ""}
                            </Badge>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
