"use client";

// Evidencia de una alerta de la revisión de RPs, según su regla. Los
// teléfonos ya vienen enmascarados desde la base (******1234).
import { formatearCentavos } from "@/lib/domain/caja";
import { etiquetaNoche } from "@/lib/fechas";
import type { ReglaFraude } from "@/lib/domain/fraude";

type Ev = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const txt = (v: unknown) => (typeof v === "string" ? v : "");
const lista = (v: unknown): Ev[] => (Array.isArray(v) ? (v as Ev[]) : []);

export function formatoHora(zona: string) {
  const f = new Intl.DateTimeFormat("es-MX", { timeZone: zona, hour: "2-digit", minute: "2-digit", hour12: false });
  return (instante: unknown) => (typeof instante === "string" ? f.format(new Date(instante)) : "—");
}
export function formatoFechaHora(zona: string) {
  const f = new Intl.DateTimeFormat("es-MX", { timeZone: zona, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return (instante: unknown) => (typeof instante === "string" ? f.format(new Date(instante)) : "—");
}

const ESTADO_RESERVA: Record<string, string> = { pendiente: "Pendiente", confirmada: "Confirmada", usada: "Usada" };

function Fila({ izquierda, derecha }: { izquierda: React.ReactNode; derecha: React.ReactNode }) {
  return (
    <li className="flex min-w-0 items-start justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <span className="min-w-0 break-words">{izquierda}</span>
      <span className="shrink-0 text-right text-muted-foreground tabular-nums">{derecha}</span>
    </li>
  );
}

export function EvidenciaAlerta({ regla, evidencia, zona }: { regla: ReglaFraude; evidencia: Ev; zona: string }) {
  const hora = formatoHora(zona);
  const fechaHora = formatoFechaHora(zona);

  if (regla === "cliente_repetido") {
    const reservas = lista(evidencia.reservas);
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p>
          Teléfono <span className="font-medium tabular-nums">{txt(evidencia.telefono) || "—"}</span> ·{" "}
          {num(evidencia.rps_distintos)} RPs distintos
        </p>
        <ul aria-label="Reservas del teléfono">
          {reservas.map((r) => (
            <Fila
              key={txt(r.reservation_id)}
              izquierda={
                <>
                  <span className="font-medium">{txt(r.rp_nombre) || "RP"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {ESTADO_RESERVA[txt(r.status)] ?? txt(r.status)} · creada {fechaHora(r.creada_en)}
                  </span>
                </>
              }
              derecha={etiquetaNoche(txt(r.fecha))}
            />
          ))}
        </ul>
      </div>
    );
  }

  if (regla === "rafaga") {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p>
          <span className="font-medium">{num(evidencia.reservas)} reservas</span> creadas entre {hora(evidencia.desde)} y{" "}
          {hora(evidencia.hasta)}.
        </p>
        <p className="text-muted-foreground">
          En toda esa noche el RP creó {num(evidencia.total_noche)} reservas.
        </p>
      </div>
    );
  }

  // consumo_atipico
  const cuentas = lista(evidencia.cuentas);
  const bajo = txt(evidencia.tipo) === "bajo";
  const p = (evidencia.parametros ?? {}) as Record<string, number>;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        Mediana del antro: <span className="font-medium">{formatearCentavos(num(evidencia.mediana_centavos))}</span> por
        cuenta ({num(evidencia.muestra)} cuentas cuadradas con consumo, últimos {num(p.dias_referencia)} días).
      </p>
      <p>
        {bajo
          ? `Consumo bajo: menos de ${formatearCentavos(num(evidencia.umbral_centavos))} (${num(p.pct_bajo)} % de la mediana).`
          : `Consumo alto: más de ${formatearCentavos(num(evidencia.umbral_centavos))} (${num(p.factor_alto)} veces la mediana).`}{" "}
        {cuentas.length} de {num(evidencia.cuentas_rp_semana)} cuentas del RP con consumo esa semana.
      </p>
      <ul aria-label="Cuentas del RP">
        {cuentas.map((c) => (
          <Fila
            key={txt(c.cuenta_id)}
            izquierda={etiquetaNoche(txt(c.fecha))}
            derecha={formatearCentavos(num(c.consumo_centavos))}
          />
        ))}
      </ul>
    </div>
  );
}
