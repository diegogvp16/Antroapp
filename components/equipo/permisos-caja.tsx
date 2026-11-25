"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  ETIQUETA_PERMISO,
  PERMISOS_MATRIZ,
  ROLES_CAJA,
  esPermisoMatriz,
  valorRol,
  type FilaPermiso,
  type PermisoMatriz,
  type RolCaja,
} from "@/lib/domain/permisos-caja";

// Qué puede hacer cada rol en la caja, y las excepciones por persona. La
// matriz la lee cualquiera que vea la caja del antro (caja_puede_ver); la
// cambia solo el dueño o el admin (caja_configurar_permiso lo hace cumplir
// en la base). Al gerente se le muestra en solo lectura.

type Persona = { id: string; nombre: string; role: RolCaja };
const ETIQUETA_ROL: Record<RolCaja, string> = { staff: "Staff", gerente: "Gerente" };
const SELECT =
  "h-10 w-full rounded-lg border border-input bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

export function PermisosCaja({ clubId, editable }: { clubId: string; editable: boolean }) {
  const [filas, setFilas] = useState<FilaPermiso[] | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);
  const [nuevaPersona, setNuevaPersona] = useState("");
  const [nuevoPermiso, setNuevoPermiso] = useState<PermisoMatriz>("anular");
  const [nuevoValor, setNuevoValor] = useState(true);

  const cargar = useCallback(async () => {
    const supabase = createClient();
    const [p, g] = await Promise.all([
      supabase.from("caja_permisos").select("permiso, rol, profile_id, permitido").eq("club_id", clubId),
      supabase.from("profiles").select("id, nombre, role").eq("club_id", clubId).in("role", ["staff", "gerente"]).eq("activo", true).order("nombre"),
    ]);
    if (p.error) {
      setError(mensajeParaUsuario(p.error, "No pudimos cargar los permisos de caja."));
      return;
    }
    setError(null);
    setFilas((p.data ?? []) as FilaPermiso[]);
    setPersonas((g.data ?? []) as Persona[]);
  }, [clubId]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function guardar(clave: string, args: { permiso: PermisoMatriz; rol: RolCaja | null; profileId: string | null; permitido: boolean }) {
    setGuardando(clave);
    setAviso(null);
    const { error: e } = await createClient().rpc("caja_configurar_permiso", {
      p_club_id: clubId,
      p_permiso: args.permiso,
      p_rol: args.rol,
      p_profile_id: args.profileId,
      p_permitido: args.permitido,
    });
    setGuardando(null);
    if (e) {
      setAviso({ ok: false, texto: mensajeParaUsuario(e, "No se pudo guardar. Intenta de nuevo.") });
      return false;
    }
    setAviso({ ok: true, texto: "Guardado. Aplica desde la siguiente acción en la caja." });
    await cargar();
    return true;
  }

  async function agregarExcepcion(e: FormEvent) {
    e.preventDefault();
    if (!nuevaPersona) return setAviso({ ok: false, texto: "Elige a la persona." });
    const ok = await guardar("nueva", { permiso: nuevoPermiso, rol: null, profileId: nuevaPersona, permitido: nuevoValor });
    if (ok) setNuevaPersona("");
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-status-err">
          {error}
        </p>
        <Button type="button" variant="outline" className="h-10" onClick={cargar}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (filas === null) return <p className="text-sm text-muted-foreground">Cargando permisos…</p>;

  const nombreDe = new Map(personas.map((p) => [p.id, p]));
  const excepciones = filas.filter((f) => f.profile_id && esPermisoMatriz(f.permiso));

  return (
    <div className="flex flex-col gap-3">
      {!editable && <p className="text-xs text-muted-foreground">Solo el dueño cambia estos permisos. Aquí ves cómo están.</p>}
      <Card>
        <CardContent className="px-0 py-0">
          <table className="w-full text-sm">
            <caption className="sr-only">Permisos de caja por rol</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">
                  Permiso
                </th>
                {ROLES_CAJA.map((r) => (
                  <th key={r} scope="col" className="w-24 px-2 py-2 text-center font-medium">
                    {ETIQUETA_ROL[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISOS_MATRIZ.map((permiso) => (
                <tr key={permiso} className="border-b border-border last:border-0">
                  <th scope="row" className="px-4 py-1.5 text-left font-normal">
                    {ETIQUETA_PERMISO[permiso]}
                  </th>
                  {ROLES_CAJA.map((rol) => {
                    const v = valorRol(filas, rol, permiso);
                    const clave = `${rol}:${permiso}`;
                    const texto = v.permitido ? "Sí" : "No";
                    return (
                      <td key={rol} className="px-2 py-1.5 text-center">
                        {editable ? (
                          <Button
                            type="button"
                            variant={v.permitido ? "default" : "outline"}
                            className="h-10 w-16"
                            aria-pressed={v.permitido}
                            aria-label={`${ETIQUETA_PERMISO[permiso]} para ${ETIQUETA_ROL[rol]}: ${texto}. Tocar para cambiar.`}
                            disabled={guardando !== null}
                            onClick={() => guardar(clave, { permiso, rol, profileId: null, permitido: !v.permitido })}
                          >
                            {guardando === clave ? "…" : texto}
                          </Button>
                        ) : (
                          <Badge variant={v.permitido ? "ok" : "neutral"}>{texto}</Badge>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {aviso && (
        <p role={aviso.ok ? "status" : "alert"} className={aviso.ok ? "text-sm text-status-ok" : "text-sm text-status-err"}>
          {aviso.texto}
        </p>
      )}

      <h3 className="text-sm font-semibold">Excepciones por persona</h3>
      <p className="text-xs text-muted-foreground">Le ganan a lo del rol. Sirven para darle a alguien de confianza un permiso más, o quitárselo.</p>
      {excepciones.length === 0 && <p className="text-sm text-muted-foreground">No hay excepciones.</p>}
      {excepciones.map((f) => {
        const p = nombreDe.get(f.profile_id!);
        const permiso = f.permiso as PermisoMatriz;
        const clave = `p:${f.profile_id}:${permiso}`;
        return (
          <Card key={clave}>
            <CardContent className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{p?.nombre ?? "Persona dada de baja"}</span>
                <span className="text-xs text-muted-foreground">
                  {ETIQUETA_PERMISO[permiso]}
                  {p ? ` · ${ETIQUETA_ROL[p.role]}` : ""}
                </span>
              </div>
              {editable && p ? (
                <Button
                  type="button"
                  variant={f.permitido ? "default" : "outline"}
                  className="h-10 w-16"
                  aria-pressed={f.permitido}
                  aria-label={`${ETIQUETA_PERMISO[permiso]} para ${p.nombre}: ${f.permitido ? "Sí" : "No"}. Tocar para cambiar.`}
                  disabled={guardando !== null}
                  onClick={() => guardar(clave, { permiso, rol: null, profileId: f.profile_id, permitido: !f.permitido })}
                >
                  {guardando === clave ? "…" : f.permitido ? "Sí" : "No"}
                </Button>
              ) : (
                <Badge variant={f.permitido ? "ok" : "neutral"}>{f.permitido ? "Sí" : "No"}</Badge>
              )}
            </CardContent>
          </Card>
        );
      })}

      {editable && personas.length > 0 && (
        <Card>
          <CardContent className="px-5 py-4">
            <form onSubmit={agregarExcepcion} className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exc-persona">Persona</Label>
                  <select id="exc-persona" className={SELECT} value={nuevaPersona} onChange={(e) => setNuevaPersona(e.target.value)}>
                    <option value="">Elige…</option>
                    {personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre} ({ETIQUETA_ROL[p.role]})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exc-permiso">Permiso</Label>
                  <select id="exc-permiso" className={SELECT} value={nuevoPermiso} onChange={(e) => setNuevoPermiso(e.target.value as PermisoMatriz)}>
                    {PERMISOS_MATRIZ.map((p) => (
                      <option key={p} value={p}>
                        {ETIQUETA_PERMISO[p]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant={nuevoValor ? "default" : "outline"} className="h-10" aria-pressed={nuevoValor} onClick={() => setNuevoValor(true)}>
                  Permitir
                </Button>
                <Button type="button" variant={!nuevoValor ? "default" : "outline"} className="h-10" aria-pressed={!nuevoValor} onClick={() => setNuevoValor(false)}>
                  Quitar
                </Button>
                <Button type="submit" variant="outline" className="h-10" disabled={guardando !== null}>
                  {guardando === "nueva" ? "Guardando…" : "Guardar excepción"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
