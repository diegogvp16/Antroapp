"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ETIQUETA_ESTADO,
  ETIQUETA_ROL_INVITADO,
  accionesDe,
  estadoInvitacion,
  rolesQuePuedeInvitar,
  type EstadoInvitacion,
  type RolInvitable,
} from "@/lib/domain/invitaciones";

// Invitar por correo y ver las invitaciones del antro (pendientes, aceptadas,
// vencidas y revocadas), con «Reenviar» y «Revocar». Quién puede invitar qué
// rol lo decide la base (invitacion_puede); aquí solo se ofrecen los roles
// que tendría sentido intentar. La lista también la filtra la base: cada
// quien ve solo las que podría gestionar.

type Fila = {
  id: string;
  rol: RolInvitable;
  correo: string;
  nombre: string;
  creada_en: string;
  expira_en: string;
  aceptada_en: string | null;
  revocada_en: string | null;
  envios: number;
};

const VARIANTE: Record<EstadoInvitacion, "ok" | "warn" | "neutral" | "err"> = {
  pendiente: "warn",
  aceptada: "ok",
  vencida: "neutral",
  revocada: "neutral",
};

const INICIALES = 5;
// Se leen por páginas: un lote de 130 RPs (o las 400 pendientes que admite
// un antro) no cabe en una sola lectura corta.
const PAGINA = 100;

const fecha = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

async function llamarInvitar(cuerpo: object): Promise<{ ok: boolean; mensaje: string }> {
  try {
    const r = await fetch("/api/equipo/invitar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
    const c = (await r.json().catch(() => ({}))) as { ok?: boolean; aviso?: string; error?: string };
    if (r.ok && c.ok) return { ok: true, mensaje: c.aviso ?? "Invitación enviada." };
    return { ok: false, mensaje: c.error ?? "No se pudo enviar la invitación. Intenta de nuevo." };
  } catch {
    return { ok: false, mensaje: "Sin conexión. Revisa tu internet e intenta de nuevo." };
  }
}

// recargar: cambia de valor cuando otra parte de la pantalla creó invitaciones
// (el lote por CSV) y hay que volver a leer la lista.
export function InvitarPersonal({ clubId, miRol, recargar = 0 }: { clubId: string; miRol: string; recargar?: number }) {
  const roles = rolesQuePuedeInvitar(miRol);
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [correo, setCorreo] = useState("");
  const [rol, setRol] = useState<RolInvitable>(roles.includes("rp") ? "rp" : roles[0] ?? "rp");
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [confirmarRevocar, setConfirmarRevocar] = useState<string | null>(null);
  const [avisoFila, setAvisoFila] = useState<{ id: string; ok: boolean; texto: string } | null>(null);
  const [verTodas, setVerTodas] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [cargandoMas, setCargandoMas] = useState(false);
  // Cuántas filas hay a la vista: al recargar (después de reenviar, revocar
  // o un lote) se vuelven a leer las mismas, no solo la primera página.
  const cargadas = useRef(PAGINA);

  const cargar = useCallback(
    async (hasta?: number) => {
      const n = hasta ?? cargadas.current;
      // Primero las que siguen abiertas (sin aceptar ni revocar: pendientes y
      // vencidas), luego las revocadas y al final las aceptadas; dentro de
      // cada grupo, la más nueva primero. El id desempata (todas las de un
      // lote tienen la misma hora) para que las páginas no se encimen.
      const { data, error, count } = await createClient()
        .from("invitaciones")
        .select("id, rol, correo, nombre, creada_en, expira_en, aceptada_en, revocada_en, envios", { count: "exact" })
        .eq("club_id", clubId)
        .order("aceptada_en", { ascending: false, nullsFirst: true })
        .order("revocada_en", { ascending: false, nullsFirst: true })
        .order("creada_en", { ascending: false })
        .order("id", { ascending: true })
        .range(0, n - 1);
      if (error) {
        setErrorLista(mensajeParaUsuario(error, "No pudimos cargar las invitaciones."));
        return;
      }
      cargadas.current = n;
      setErrorLista(null);
      setFilas((data ?? []) as Fila[]);
      setTotal(count ?? data?.length ?? 0);
    },
    [clubId],
  );

  async function verMas() {
    setCargandoMas(true);
    await cargar(cargadas.current + PAGINA);
    setCargandoMas(false);
  }

  useEffect(() => {
    cargar();
  }, [cargar, recargar]);

  async function invitar(e: FormEvent) {
    e.preventDefault();
    setAviso(null);
    if (nombre.trim().length < 2) return setAviso({ ok: false, texto: "Escribe el nombre." });
    if (!/^\S+@\S+\.\S+$/.test(correo.trim())) return setAviso({ ok: false, texto: "Revisa el correo: no parece válido." });
    setEnviando(true);
    const r = await llamarInvitar({ accion: "crear", club_id: clubId, rol, correo: correo.trim(), nombre: nombre.trim() });
    setEnviando(false);
    setAviso({ ok: r.ok, texto: r.mensaje });
    if (r.ok) {
      setNombre("");
      setCorreo("");
      await cargar();
    }
  }

  async function reenviar(f: Fila) {
    setOcupado(f.id);
    setAvisoFila(null);
    const r = await llamarInvitar({ accion: "reenviar", id: f.id });
    setOcupado(null);
    setAvisoFila({ id: f.id, ok: r.ok, texto: r.mensaje });
    if (r.ok) await cargar();
  }

  async function revocar(f: Fila) {
    setOcupado(f.id);
    setAvisoFila(null);
    const { error } = await createClient().rpc("invitacion_revocar", { p_id: f.id });
    setOcupado(null);
    setConfirmarRevocar(null);
    if (error) {
      setAvisoFila({ id: f.id, ok: false, texto: mensajeParaUsuario(error, "No se pudo revocar. Intenta de nuevo.") });
      return;
    }
    setAvisoFila({ id: f.id, ok: true, texto: "Invitación revocada: el enlace ya no sirve." });
    await cargar();
  }

  if (roles.length === 0) return null;

  // Primero lo que todavía se puede mover (pendientes y vencidas), luego el
  // historial; cada grupo, de la más nueva a la más vieja. Solo las primeras
  // INICIALES a la vista para no empujar el resto de la pantalla.
  const ordenadas = [...(filas ?? [])].sort((a, b) => {
    const abierta = (f: Fila) => (accionesDe(estadoInvitacion(f)).reenviar ? 0 : 1);
    // Las de un mismo lote tienen la misma hora: entre ellas, por nombre.
    return (
      abierta(a) - abierta(b) || Date.parse(b.creada_en) - Date.parse(a.creada_en) || a.nombre.localeCompare(b.nombre, "es-MX", { numeric: true })
    );
  });
  const visibles = verTodas ? ordenadas : ordenadas.slice(0, INICIALES);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="px-5 py-4">
          <form onSubmit={invitar} className="flex flex-col gap-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-nombre">Nombre</Label>
                <Input id="inv-nombre" className="h-10" autoComplete="off" maxLength={120} value={nombre} onChange={(e) => setNombre(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-correo">Correo</Label>
                <Input
                  id="inv-correo"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  className="h-10"
                  maxLength={254}
                  value={correo}
                  onChange={(e) => setCorreo(e.target.value)}
                />
              </div>
            </div>
            {roles.length > 1 ? (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-sm font-medium">Rol</legend>
                <div className="flex flex-wrap gap-2">
                  {roles.map((r) => (
                    <Button key={r} type="button" variant={rol === r ? "default" : "outline"} className="h-10 min-w-20" aria-pressed={rol === r} onClick={() => setRol(r)}>
                      {ETIQUETA_ROL_INVITADO[r]}
                    </Button>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className="text-xs text-muted-foreground">Puedes invitar RPs. A staff y gerentes los invita el dueño.</p>
            )}
            {aviso && (
              <p role={aviso.ok ? "status" : "alert"} className={aviso.ok ? "text-sm text-status-ok" : "text-sm text-status-err"}>
                {aviso.texto}
              </p>
            )}
            <Button type="submit" className="h-10 self-start" disabled={enviando}>
              {enviando ? "Enviando…" : `Invitar como ${ETIQUETA_ROL_INVITADO[rol]}`}
            </Button>
            <p className="text-xs text-muted-foreground">
              Le llega un enlace para elegir su contraseña. Sirve una sola vez y vence en 72 horas. Entra con el rol y el antro de la invitación.
            </p>
          </form>
        </CardContent>
      </Card>

      {errorLista && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-status-err">
            {errorLista}
          </p>
          <Button type="button" variant="outline" className="h-10" onClick={() => cargar()}>
            Reintentar
          </Button>
        </div>
      )}
      {!errorLista && filas === null && <p className="text-sm text-muted-foreground">Cargando invitaciones…</p>}
      {!errorLista && filas?.length === 0 && <p className="text-sm text-muted-foreground">Todavía no hay invitaciones.</p>}
      {!errorLista &&
        visibles.map((f) => {
          const estado = estadoInvitacion(f);
          const acciones = accionesDe(estado);
          return (
            <Card key={f.id}>
              <CardContent className="flex flex-col gap-2 px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{f.nombre}</span>
                    <span className="truncate text-xs text-muted-foreground">{f.correo}</span>
                    <span className="text-xs text-muted-foreground">
                      {ETIQUETA_ROL_INVITADO[f.rol]} ·{" "}
                      {estado === "aceptada" && f.aceptada_en
                        ? `aceptó el ${fecha.format(new Date(f.aceptada_en))}`
                        : estado === "revocada" && f.revocada_en
                          ? `revocada el ${fecha.format(new Date(f.revocada_en))}`
                          : estado === "vencida"
                            ? `venció el ${fecha.format(new Date(f.expira_en))}`
                            : `vence el ${fecha.format(new Date(f.expira_en))}`}
                    </span>
                  </div>
                  <Badge variant={VARIANTE[estado]}>{ETIQUETA_ESTADO[estado]}</Badge>
                </div>
                {(acciones.reenviar || acciones.revocar) && confirmarRevocar !== f.id && (
                  <div className="flex flex-wrap gap-2">
                    {acciones.reenviar && (
                      <Button type="button" variant="outline" className="h-10" disabled={ocupado === f.id} onClick={() => reenviar(f)}>
                        {ocupado === f.id ? "Enviando…" : "Reenviar"}
                      </Button>
                    )}
                    {acciones.revocar && (
                      <Button type="button" variant="ghost" className="h-10" disabled={ocupado === f.id} onClick={() => setConfirmarRevocar(f.id)}>
                        Revocar
                      </Button>
                    )}
                  </div>
                )}
                {confirmarRevocar === f.id && (
                  <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <p className="text-sm">¿Revocar la invitación de {f.nombre}? El enlace deja de servir. Si después la necesitas, crea otra.</p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="destructive" className="h-10" disabled={ocupado === f.id} onClick={() => revocar(f)}>
                        {ocupado === f.id ? "Revocando…" : "Sí, revocar"}
                      </Button>
                      <Button type="button" variant="ghost" className="h-10" disabled={ocupado === f.id} onClick={() => setConfirmarRevocar(null)}>
                        Cancelar
                      </Button>
                    </div>
                  </div>
                )}
                {avisoFila?.id === f.id && (
                  <p role={avisoFila.ok ? "status" : "alert"} className={avisoFila.ok ? "text-xs text-status-ok" : "text-xs font-medium text-status-err"}>
                    {avisoFila.texto}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      {!errorLista && ordenadas.length > visibles.length && (
        <Button type="button" variant="outline" className="h-10 self-start" onClick={() => setVerTodas(true)}>
          Ver todas ({total ?? ordenadas.length})
        </Button>
      )}
      {!errorLista && verTodas && total !== null && ordenadas.length < total && (
        <Button type="button" variant="outline" className="h-10 self-start" disabled={cargandoMas} onClick={verMas}>
          {cargandoMas ? "Cargando…" : `Ver más (faltan ${total - ordenadas.length})`}
        </Button>
      )}
    </div>
  );
}
