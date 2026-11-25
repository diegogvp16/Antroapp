import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { porcentajeFallo, tonoFallo, type SaludPlataforma } from "@/lib/domain/salud";
import { formatearFechaLarga } from "@/lib/fechas";

const horaMx = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit" });
const n = (x: number) => x.toLocaleString("es-MX");
const fallidos = (x: number) => `${n(x)} ${x === 1 ? "fallido" : "fallidos"}`;

function Cifra({ titulo, valor, detalle, tono }: { titulo: string; valor: string; detalle?: string; tono?: "ok" | "warn" | "err" }) {
  const color = tono === "err" ? "text-status-err" : tono === "warn" ? "text-status-warn" : "";
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-0.5 px-4">
        <span className="text-xs text-muted-foreground">{titulo}</span>
        <span className={`text-2xl font-bold tabular-nums ${color}`}>{valor}</span>
        {detalle && <span className="text-xs text-muted-foreground">{detalle}</span>}
      </CardContent>
    </Card>
  );
}

// Inicios de sesión, registros y reservas sin cuenta: solo conteos. Nunca
// correos, IPs ni sus hashes (sin sal se revierten probando correos).
export function ResumenAccesos({ s }: { s: SaludPlataforma }) {
  const { login, bloqueos, registro, umbrales: u } = s;
  const bloqueados = bloqueos.pares_correo_ip + bloqueos.correos + bloqueos.ips;
  const rs = s.reservas_sin_cuenta;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Inicios de sesión</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cifra
          titulo="Última hora"
          valor={n(login.hora.total)}
          detalle={`${fallidos(login.hora.fallidos)} · ${porcentajeFallo(login.hora.fallidos, login.hora.total)}`}
          tono={tonoFallo(login.hora.fallidos, login.hora.total)}
        />
        <Cifra
          titulo="Últimas 24 h"
          valor={n(login.dia.total)}
          detalle={`${fallidos(login.dia.fallidos)} · ${porcentajeFallo(login.dia.fallidos, login.dia.total)}`}
          tono={tonoFallo(login.dia.fallidos, login.dia.total)}
        />
        <Cifra titulo="Correos distintos (24 h)" valor={n(login.dia.correos)} detalle={`${n(login.dia.ips)} conexiones distintas`} />
        <Cifra
          titulo="Bloqueos ahora"
          valor={n(bloqueados)}
          detalle={`Ventana de ${u.ventana_minutos} min`}
          tono={bloqueados > 0 ? "warn" : "ok"}
        />
      </div>
      <Card size="sm">
        <CardContent className="flex flex-col gap-1.5 px-4 text-sm">
          <Fila texto={`Correo + conexión (${u.max_fallos_correo_ip} fallos seguidos)`} valor={bloqueos.pares_correo_ip} />
          <Fila texto={`Correo desde cualquier conexión (${u.max_fallos_correo})`} valor={bloqueos.correos} />
          <Fila texto={`Conexión con muchos fallos (${u.max_fallos_ip})`} valor={bloqueos.ips} />
          <p className="pt-1 text-xs text-muted-foreground">
            Si el CAPTCHA no respondiera (modo degradado, {u.degradado_max_fallos_correo_ip} y {u.degradado_max_fallos_ip} fallos), estarían
            bloqueados {n(bloqueos.pares_correo_ip_degradado)} correo + conexión y {n(bloqueos.ips_degradado)} conexiones.
          </p>
        </CardContent>
      </Card>

      <h2 className="pt-2 text-lg font-semibold">Registros de cuentas</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cifra titulo="Última hora" valor={n(registro.hora.total)} detalle={`${n(registro.hora.degradados)} sin CAPTCHA verificado`} />
        <Cifra
          titulo="Últimas 24 h"
          valor={n(registro.dia.total)}
          detalle={`Clientes ${n(registro.dia.por_tipo.cliente ?? 0)} · dueños ${n(registro.dia.por_tipo.dueno ?? 0)}`}
        />
        <Cifra
          titulo="En modo degradado (24 h)"
          valor={n(registro.dia.degradados)}
          detalle={`Desde ${n(registro.dia.ips_con_degradado)} de ${n(registro.dia.ips)} conexiones`}
          tono={registro.dia.degradados > 0 ? "warn" : "ok"}
        />
        <Cifra
          titulo="Conexiones al límite"
          valor={n(registro.ips_al_limite_hora)}
          detalle={`${u.registros_por_ip_hora} por hora (${u.degradado_registros_por_ip_hora} sin CAPTCHA)`}
          tono={registro.ips_al_limite_hora > 0 ? "warn" : "ok"}
        />
      </div>
      {registro.top_ips_dia.length > 0 && (
        <Card size="sm">
          <CardContent className="flex flex-col gap-1 px-4 text-sm">
            <span className="text-xs text-muted-foreground">Registros por conexión (24 h, las que más tienen)</span>
            <ul className="flex flex-wrap gap-1.5">
              {registro.top_ips_dia.map((t, i) => (
                <li key={i}>
                  <Badge variant={t.degradados > 0 ? "warn" : "neutral"}>
                    {t.registros}
                    {t.degradados > 0 ? ` (${t.degradados} sin CAPTCHA)` : ""}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {rs && (
        <>
          <h2 className="pt-2 text-lg font-semibold">Reservas sin cuenta</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Cifra titulo="Última hora" valor={n(rs.hora)} />
            <Cifra titulo="Últimas 24 h" valor={n(rs.dia)} />
            <Cifra
              titulo="Conexiones al límite"
              valor={n(rs.ips_al_limite_hora)}
              detalle={`${u.reservas_por_ip_hora} por hora`}
              tono={rs.ips_al_limite_hora > 0 ? "warn" : "ok"}
            />
            <Cifra
              titulo="Teléfonos al límite"
              valor={n(rs.telefonos_al_limite)}
              detalle={`${u.reservas_por_telefono_noche} por antro y noche`}
              tono={rs.telefonos_al_limite > 0 ? "warn" : "ok"}
            />
          </div>
        </>
      )}

      {s.alertas.length > 0 && (
        <>
          <h2 className="pt-2 text-lg font-semibold">Alertas por correo</h2>
          <Card size="sm">
            <CardContent className="flex flex-col divide-y divide-border px-4 text-sm">
              {s.alertas.map((a) => (
                <div key={a.tipo} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="break-all font-medium">{a.tipo}</span>
                  <span className="text-xs text-muted-foreground">
                    Última: {formatearFechaLarga(a.ultima)}, {horaMx.format(new Date(a.ultima))} · {a.veces_7d} en 7 días
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}

function Fila({ texto, valor }: { texto: string; valor: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{texto}</span>
      <Badge variant={valor > 0 ? "warn" : "ok"}>{n(valor)}</Badge>
    </div>
  );
}
