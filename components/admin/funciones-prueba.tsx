"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { FUNCIONES, type ClaveFuncion } from "@/lib/funciones";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Admin: encender o apagar las funciones en prueba por antro y por grupo
// (sql/post-junta-3/00-funciones-club.sql). Todas nacen apagadas. El valor
// propio del antro gana al del grupo; «Seguir al grupo» quita el propio.

interface Fila {
  club_id: string;
  club_nombre: string;
  grupo_id: string | null;
  grupo_nombre: string | null;
  funcion: ClaveFuncion;
  valor_club: boolean | null;
  valor_grupo: boolean | null;
  efectiva: boolean;
}

export function FuncionesPrueba() {
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    const { data, error: e } = await createClient().rpc("funciones_estado");
    if (e) {
      setError(e.code === "PGRST202" ? "La base todavía no tiene las funciones en prueba (falta el SQL 00 de post-junta-3)." : mensajeParaUsuario(e));
      setFilas([]);
      return;
    }
    setFilas((data ?? []) as Fila[]);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const antros = useMemo(() => {
    const m = new Map<string, { id: string; nombre: string; grupoId: string | null; grupoNombre: string | null; f: Map<string, Fila> }>();
    for (const f of filas ?? []) {
      if (!m.has(f.club_id)) m.set(f.club_id, { id: f.club_id, nombre: f.club_nombre, grupoId: f.grupo_id, grupoNombre: f.grupo_nombre, f: new Map() });
      m.get(f.club_id)!.f.set(f.funcion, f);
    }
    return [...m.values()];
  }, [filas]);

  const grupos = useMemo(() => {
    const m = new Map<string, { id: string; nombre: string; antros: number; f: Map<string, boolean | null> }>();
    for (const a of antros) {
      if (!a.grupoId) continue;
      if (!m.has(a.grupoId)) m.set(a.grupoId, { id: a.grupoId, nombre: a.grupoNombre ?? "Grupo", antros: 0, f: new Map() });
      const g = m.get(a.grupoId)!;
      g.antros += 1;
      for (const [clave, fila] of a.f) g.f.set(clave, fila.valor_grupo);
    }
    return [...m.values()];
  }, [antros]);

  async function cambiar(tipo: "club" | "grupo", id: string, funcion: ClaveFuncion, activa: boolean | null, texto: string) {
    setOcupado(`${tipo}|${id}|${funcion}`);
    setAviso(null);
    const supabase = createClient();
    const { error: e } =
      tipo === "club"
        ? await supabase.rpc("funcion_cambiar", { p_club_id: id, p_funcion: funcion, p_activa: activa })
        : await supabase.rpc("grupo_funcion_cambiar", { p_grupo_id: id, p_funcion: funcion, p_activa: activa });
    setOcupado(null);
    if (e) {
      setAviso(mensajeParaUsuario(e));
      return;
    }
    setAviso(texto);
    await cargar();
  }

  if (filas === null) return <p className="text-sm text-muted-foreground" role="status">Cargando…</p>;
  if (error) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-status-err" role="alert">{error}</p>
        <Button type="button" variant="outline" className="h-10 w-fit" onClick={() => void cargar()}>
          Intentar de nuevo
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {aviso && (
        <p className="text-sm" role="status">
          {aviso}
        </p>
      )}

      {grupos.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Por grupo</h2>
          <p className="text-sm text-muted-foreground">Vale para los antros del grupo que no tengan su propio valor.</p>
          {grupos.map((g) => (
            <Card key={g.id}>
              <CardContent className="flex flex-col gap-3 py-4">
                <p className="font-medium">
                  {g.nombre} <span className="text-sm font-normal text-muted-foreground">· {g.antros} {g.antros === 1 ? "antro" : "antros"}</span>
                </p>
                <ul className="flex flex-col divide-y divide-border">
                  {FUNCIONES.map((f) => {
                    const v = g.f.get(f.clave) ?? null;
                    const clave = `grupo|${g.id}|${f.clave}`;
                    return (
                      <li key={f.clave} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="text-sm">{f.nombre}</span>
                        <div className="flex items-center gap-2">
                          <Badge variant={v ? "default" : "outline"}>{v === null ? "Sin valor" : v ? "Encendida" : "Apagada"}</Badge>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10"
                            disabled={ocupado !== null}
                            onClick={() => void cambiar("grupo", g.id, f.clave, !v, `${f.nombre}: ${!v ? "encendida" : "apagada"} en ${g.nombre}.`)}
                          >
                            {ocupado === clave ? "Guardando…" : v ? "Apagar" : "Encender"}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Por antro</h2>
        {antros.length === 0 && <p className="text-sm text-muted-foreground">No hay antros dados de alta.</p>}
        {antros.map((a) => (
          <Card key={a.id}>
            <CardContent className="flex flex-col gap-3 py-4">
              <p className="font-medium">
                {a.nombre}
                {a.grupoNombre && <span className="text-sm font-normal text-muted-foreground"> · {a.grupoNombre}</span>}
              </p>
              <ul className="flex flex-col divide-y divide-border">
                {FUNCIONES.map((f) => {
                  const fila = a.f.get(f.clave);
                  const propio = fila?.valor_club ?? null;
                  const efectiva = fila?.efectiva ?? false;
                  const clave = `club|${a.id}|${f.clave}`;
                  const origen = propio !== null ? "valor propio" : fila?.valor_grupo !== null && fila?.valor_grupo !== undefined ? "del grupo" : "por defecto";
                  return (
                    <li key={f.clave} className="flex flex-col gap-2 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm">{f.nombre}</span>
                        <Badge variant={efectiva ? "default" : "outline"}>
                          {efectiva ? "Encendida" : "Apagada"} · {origen}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{f.descripcion}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-10"
                          disabled={ocupado !== null}
                          onClick={() => void cambiar("club", a.id, f.clave, !efectiva, `${f.nombre}: ${!efectiva ? "encendida" : "apagada"} en ${a.nombre}.`)}
                        >
                          {ocupado === clave ? "Guardando…" : efectiva ? "Apagar" : "Encender"}
                        </Button>
                        {propio !== null && a.grupoId && (
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-10"
                            disabled={ocupado !== null}
                            onClick={() => void cambiar("club", a.id, f.clave, null, `${f.nombre}: ${a.nombre} vuelve a seguir al grupo.`)}
                          >
                            Seguir al grupo
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
