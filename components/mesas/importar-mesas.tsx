"use client";

import { useState, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MAX_BYTES_CSV } from "@/lib/domain/lector-csv";
import {
  MAX_MESAS_ANTRO,
  MAX_MESAS_CSV,
  compararMesas,
  filasParaBase,
  leerMesasCsv,
  type CambioMesa,
  type FilaMesa,
} from "@/lib/domain/importar-mesas";

// Importar mesas desde un CSV (B1a). Primero se revisa contra las mesas que
// ya tiene el antro (nuevas, cambio de capacidad, sin cambio y errores por
// línea) y luego se importa todo en una transacción (mesas_importar): o
// entra todo o nada. Nunca borra ni renombra mesas. Solo el dueño del antro
// y el admin (lo exige la base).

type Revision = { filas: FilaMesa[]; errores: string[] };

export function ImportarMesas({
  clubId,
  existentes,
  onListo,
}: {
  clubId: string;
  existentes: readonly { numero: string; capacidad: number }[];
  onListo: () => void | Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState("");
  const [revision, setRevision] = useState<Revision | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function cambiarTexto(t: string) {
    setTexto(t);
    setRevision(null);
    setError(null);
  }

  async function leerArchivo(e: ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    e.target.value = "";
    if (!archivo) return;
    if (archivo.size > MAX_BYTES_CSV) return setError("El archivo es muy grande (máximo 500 KB).");
    cambiarTexto(await archivo.text());
  }

  const comparacion = revision && revision.errores.length === 0 ? compararMesas(revision.filas, existentes) : null;
  const pasaTope = comparacion ? comparacion.totalDespues > MAX_MESAS_ANTRO : false;
  const sinCambios = comparacion ? comparacion.nuevas + comparacion.actualizadas === 0 : false;

  async function importar() {
    if (!revision || revision.errores.length || revision.filas.length === 0 || pasaTope || sinCambios) return;
    setGuardando(true);
    setError(null);
    const { data, error: e } = await createClient().rpc("mesas_importar", { p_club_id: clubId, p_filas: filasParaBase(revision.filas) });
    setGuardando(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudieron importar las mesas. No se guardó nada."));
    const r = data as { creadas: number; actualizadas: number; total: number };
    setAviso(`Listo: ${r.creadas} ${r.creadas === 1 ? "mesa nueva" : "mesas nuevas"} y ${r.actualizadas} con capacidad cambiada. Ahora son ${r.total}.`);
    setTexto("");
    setRevision(null);
    await onListo();
  }

  if (!abierto) {
    return (
      <div className="flex flex-col gap-2">
        <Button type="button" variant="outline" className="h-10 self-start" onClick={() => setAbierto(true)}>
          Importar mesas desde CSV
        </Button>
        {aviso && (
          <p role="status" className="text-sm text-status-ok">
            {aviso}
          </p>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Importar mesas desde CSV</CardTitle>
        <CardDescription>
          Una línea por mesa: <strong>nombre, capacidad</strong>. Si la mesa ya existe (mismo nombre), solo cambia su capacidad. No se borra ni se renombra
          ninguna. Hasta {MAX_MESAS_CSV} por archivo.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-6 pb-6">
        {/* Botón propio: el del navegador sale en inglés («Choose File»). */}
        <label className={buttonVariants({ variant: "outline", className: "h-10 cursor-pointer self-start focus-within:ring-3 focus-within:ring-ring/50" })}>
          Elegir archivo (.csv)
          <input id="mesas-archivo" type="file" accept=".csv,.txt,text/csv" className="sr-only" onChange={leerArchivo} />
        </label>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mesas-texto">O pega la lista</Label>
          <textarea
            id="mesas-texto"
            className="min-h-28 w-full rounded-lg border border-input bg-background px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder={"mesa,capacidad\n1,8\n2,8\nVIP 1,15"}
            value={texto}
            onChange={(e) => cambiarTexto(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="h-10" disabled={!texto.trim()} onClick={() => setRevision(leerMesasCsv(texto))}>
            Revisar
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-10"
            onClick={() => {
              setAbierto(false);
              cambiarTexto("");
            }}
          >
            Cerrar
          </Button>
        </div>

        {revision && revision.errores.length > 0 && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium text-status-err">
              {revision.errores.length === 1 ? "Hay 1 línea por corregir" : `Hay ${revision.errores.length} líneas por corregir`}. No se importa nada hasta que
              todas estén bien.
            </p>
            <ul role="alert" className="flex flex-col gap-1 text-status-err">
              {revision.errores.slice(0, 20).map((e) => (
                <li key={e}>{e}</li>
              ))}
              {revision.errores.length > 20 && <li>…y {revision.errores.length - 20} más.</li>}
            </ul>
          </div>
        )}

        {comparacion && (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              {comparacion.nuevas} {comparacion.nuevas === 1 ? "nueva" : "nuevas"} · {comparacion.actualizadas} cambian de capacidad · {comparacion.iguales} sin
              cambio. El antro quedaría con {comparacion.totalDespues} mesas.
            </p>
            {pasaTope && (
              <p role="alert" className="text-status-err">
                El máximo es {MAX_MESAS_ANTRO} mesas por antro.
              </p>
            )}
            <ul className="flex max-h-60 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="Vista previa">
              {comparacion.cambios.slice(0, 100).map((c) => (
                <li key={c.fila.numero.toLowerCase()} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="min-w-0 truncate font-medium">{c.fila.numero}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{detalle(c)}</span>
                </li>
              ))}
              {comparacion.cambios.length > 100 && <li className="px-3 py-1.5 text-muted-foreground">…y {comparacion.cambios.length - 100} más.</li>}
            </ul>
            <Button type="button" className="h-10 self-start" disabled={guardando || pasaTope || sinCambios} onClick={importar}>
              {guardando ? "Importando…" : sinCambios ? "No hay cambios" : `Importar ${comparacion.nuevas + comparacion.actualizadas} cambios`}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        )}
        {aviso && (
          <p role="status" className="text-sm text-status-ok">
            {aviso}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function detalle(c: CambioMesa): string {
  if (c.tipo === "nueva") return `Nueva · ${c.fila.capacidad} pers.`;
  if (c.tipo === "capacidad") return `${c.antes} → ${c.fila.capacidad} pers.`;
  return `Sin cambio · ${c.fila.capacidad} pers.`;
}
