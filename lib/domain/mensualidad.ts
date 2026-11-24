// Mensualidad del antro (Stripe): reglas puras, sin red ni Supabase.
// Este archivo no importa nada con "@/": las pruebas lo cargan con Node.
//
// Estados que ve el antro:
//   activa          → pagó; publicado.
//   en_gracia       → un cobro falló; sigue publicado hasta gracia_hasta.
//   vencida         → terminó la gracia sin pago; deja de mostrarse al
//                     público (puerta, caja y reportes SIGUEN funcionando).
//   cancelada       → canceló la suscripción; igual que vencida.
//   sin_suscripcion → nunca se suscribió (o el primer pago no se completó).
//
// Nunca un bloqueo repentino en plena noche: la gracia siempre termina a las
// 08:00 (corte de la noche operativa) en la zona del antro, y quien quita la
// publicación es la tarea diaria (/api/cron/mensualidad), que corre después
// de ese corte. El webhook solo publica; no despublica.

export type EstadoMensualidad = "activa" | "en_gracia" | "vencida" | "cancelada" | "sin_suscripcion";

export const HORA_CORTE = 8;

// status de una suscripción de Stripe → estado del antro.
export function estadoDesdeStripe(statusStripe: string, graciaHasta: Date | null, ahora: Date): EstadoMensualidad {
  switch (statusStripe) {
    case "active":
    case "trialing":
      return "activa";
    case "past_due":
    case "unpaid":
    case "paused":
      return graciaHasta && ahora.getTime() < graciaHasta.getTime() ? "en_gracia" : "vencida";
    case "canceled":
    case "incomplete_expired":
      return "cancelada";
    default:
      // incomplete: el primer pago todavía no se completa.
      return "sin_suscripcion";
  }
}

// ¿El antro se muestra al público con este estado?
export function quedaPublicado(estado: EstadoMensualidad): boolean {
  return estado === "activa" || estado === "en_gracia";
}

// Instante de "fecha HH:00" en una zona horaria (sin librerías).
export function instanteLocal(fechaISO: string, hora: number, zona: string): Date {
  const [a, m, d] = fechaISO.split("-").map(Number);
  const supuesto = Date.UTC(a, m - 1, d, hora, 0, 0);
  // Diferencia entre lo que marca el reloj de la zona en ese instante y el supuesto.
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(supuesto))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  const reloj = Date.UTC(partes.year, partes.month - 1, partes.day, partes.hour, partes.minute);
  return new Date(supuesto - (reloj - supuesto));
}

function fechaEn(instante: Date, zona: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zona }).format(instante);
}

// Fin de la gracia: `dias` después de `desde`, redondeado al SIGUIENTE corte
// de las 08:00 en la zona del antro (nunca a media noche).
export function finDeGracia(desde: Date, dias: number, zona: string): Date {
  const minimo = new Date(desde.getTime() + Math.max(0, dias) * 86_400_000);
  const fecha = fechaEn(minimo, zona);
  const corte = instanteLocal(fecha, HORA_CORTE, zona);
  if (corte.getTime() >= minimo.getTime()) return corte;
  const [a, m, d] = fecha.split("-").map(Number);
  const siguiente = new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
  return instanteLocal(siguiente, HORA_CORTE, zona);
}

export const ETIQUETA_ESTADO: Record<EstadoMensualidad, string> = {
  activa: "Activa",
  en_gracia: "En periodo de gracia",
  vencida: "Vencida",
  cancelada: "Cancelada",
  sin_suscripcion: "Sin suscripción",
};

export const TONO_ESTADO: Record<EstadoMensualidad, "ok" | "warn" | "err" | "neutral"> = {
  activa: "ok",
  en_gracia: "warn",
  vencida: "err",
  cancelada: "neutral",
  sin_suscripcion: "neutral",
};

// ---------- Lectura defensiva de los objetos de Stripe ----------
// Solo los campos que se usan; tolera las dos formas de la API (antes y
// después de que el periodo se moviera a los items y la suscripción de la
// factura a `parent`).

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (typeof x === "object" && x !== null ? (x as Obj) : {});
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const idDe = (x: unknown): string | null => str(x) ?? str(obj(x).id);

export interface SuscripcionStripe {
  id: string;
  status: string;
  customer: string | null;
  clubId: string | null;
  priceId: string | null;
  periodoFin: Date | null;
  cancelarAlFinal: boolean;
}

export function leerSuscripcion(x: unknown): SuscripcionStripe | null {
  const s = obj(x);
  const id = str(s.id);
  const status = str(s.status);
  if (!id || !status) return null;
  const item = obj((obj(s.items).data as unknown[] | undefined)?.[0]);
  const fin = num(item.current_period_end) ?? num(s.current_period_end);
  return {
    id,
    status,
    customer: idDe(s.customer),
    clubId: str(obj(s.metadata).club_id),
    priceId: str(obj(item.price).id),
    periodoFin: fin ? new Date(fin * 1000) : null,
    cancelarAlFinal: s.cancel_at_period_end === true,
  };
}

export interface FacturaStripe {
  id: string;
  customer: string | null;
  suscripcion: string | null;
  clubId: string | null;
  montoCentavos: number;
  moneda: string;
  url: string | null;
  periodoInicio: Date | null;
  periodoFin: Date | null;
}

export function leerFactura(x: unknown): FacturaStripe | null {
  const f = obj(x);
  const id = str(f.id);
  if (!id) return null;
  const detalles = obj(obj(f.parent).subscription_details);
  const linea = obj((obj(f.lines).data as unknown[] | undefined)?.[0]);
  const periodo = obj(linea.period);
  const ini = num(periodo.start) ?? num(f.period_start);
  const fin = num(periodo.end) ?? num(f.period_end);
  return {
    id,
    customer: idDe(f.customer),
    suscripcion: idDe(detalles.subscription) ?? idDe(f.subscription),
    clubId: str(obj(detalles.metadata).club_id) ?? str(obj(f.metadata).club_id),
    montoCentavos: num(f.amount_paid) || num(f.amount_due) || 0,
    moneda: str(f.currency) ?? "mxn",
    url: str(f.hosted_invoice_url),
    periodoInicio: ini ? new Date(ini * 1000) : null,
    periodoFin: fin ? new Date(fin * 1000) : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (x: string | null): x is string => !!x && UUID.test(x);
