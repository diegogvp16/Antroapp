import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { SaludPlataforma } from "@/lib/domain/salud";
import { formatearFechaLarga } from "@/lib/fechas";

const horaMx = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" });

// Errores de la app de los últimos 7 días, agrupados en la base (sin tope de
// 500 filas como en /admin): mensaje, ruta, cuántas veces y cuándo fue el
// último. Nada de usuario, navegador ni IP.
export function ErroresAgrupados({ errores }: { errores: SaludPlataforma["errores"] }) {
  const { dia, semana, grupos, grupos_total } = errores;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Errores de la app</h2>
      <p className="text-sm">
        <Badge variant={dia === 0 ? "ok" : dia >= 10 ? "err" : "warn"}>{dia} en 24 h</Badge>{" "}
        <span className="text-muted-foreground">
          · {semana} en 7 días{grupos_total ? `, ${grupos_total} distintos` : ""}
          {grupos_total > grupos.length ? ` (se muestran ${grupos.length})` : ""}
        </span>
      </p>
      {grupos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin errores en los últimos 7 días.</p>
      ) : (
        <Card>
          <CardContent className="flex flex-col divide-y divide-border px-4 py-1 text-sm">
            {grupos.map((g, i) => (
              <div key={i} className="flex flex-col gap-0.5 py-2">
                <p className="break-words font-medium">
                  <span className={`mr-1.5 tabular-nums ${g.veces_24h > 0 ? "text-status-warn" : "text-muted-foreground"}`}>{g.veces}×</span>
                  {g.mensaje}
                </p>
                <p className="break-words text-xs text-muted-foreground">
                  {g.veces_24h} en 24 h · último: {formatearFechaLarga(g.ultimo)}, {horaMx.format(new Date(g.ultimo))}
                  {g.ruta ? ` · ${g.ruta}` : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
