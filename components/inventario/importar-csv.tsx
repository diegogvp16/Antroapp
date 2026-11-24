"use client";

import { useState, type ChangeEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { formatearCentavos } from "@/lib/domain/caja";
import { leerCatalogoCsv, type FilaCatalogo } from "@/lib/domain/catalogo-csv";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

// Importar el catálogo desde un CSV (fase 2). Primero se revisa (vista
// previa y errores por línea) y luego se importa todo en una transacción
// (producto_importar): o entra todo o nada.
export function ImportarCsv({ clubId, onListo }: { clubId: string; onListo: () => void }) {
  const [texto, setTexto] = useState("");
  const [revision, setRevision] = useState<{ filas: FilaCatalogo[]; errores: string[] } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function leerArchivo(e: ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    if (!archivo) return;
    if (archivo.size > 500_000) return setError("El archivo es muy grande (máximo 500 KB).");
    setTexto(await archivo.text());
    setRevision(null);
  }

  async function importar() {
    if (!revision || revision.errores.length || revision.filas.length === 0) return;
    setGuardando(true);
    setError(null);
    const { data, error: e } = await createClient().rpc("producto_importar", { p_club_id: clubId, p_filas: revision.filas });
    setGuardando(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo importar. No se guardó nada."));
    const r = data as { creados: number; actualizados: number };
    setAviso(`Listo: ${r.creados} nuevos y ${r.actualizados} actualizados.`);
    setTexto("");
    setRevision(null);
    onListo();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Importar desde CSV</CardTitle>
        <CardDescription>
          Una línea por producto: <strong>nombre, categoría, precio, mínimo, existencias</strong> (los dos últimos son opcionales). Si el producto ya
          existe se actualizan precio, categoría y mínimo; sus existencias se ajustan aparte, con motivo.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-6 pb-6">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="csv-archivo">Archivo (.csv)</Label>
          <input id="csv-archivo" type="file" accept=".csv,.txt,text/csv" className="text-sm" onChange={leerArchivo} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="csv-texto">O pega el contenido</Label>
          <textarea
            id="csv-texto"
            className="min-h-28 w-full rounded-lg border border-input bg-background px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder={"nombre,categoría,precio,mínimo,existencias\nTequila Reposado,Botellas,1800,3,12\nCerveza,Cervezas,90,24,120"}
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              setRevision(null);
            }}
          />
        </div>
        <Button type="button" variant="outline" className="h-10 self-start" disabled={!texto.trim()} onClick={() => setRevision(leerCatalogoCsv(texto))}>
          Revisar
        </Button>

        {revision && (
          <div className="flex flex-col gap-2 text-sm">
            {revision.errores.length > 0 ? (
              <ul role="alert" className="flex flex-col gap-1 text-status-err">
                {revision.errores.slice(0, 20).map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {revision.errores.length > 20 && <li>…y {revision.errores.length - 20} más.</li>}
              </ul>
            ) : (
              <p>
                {revision.filas.length} {revision.filas.length === 1 ? "producto listo" : "productos listos"} para importar:
              </p>
            )}
            {revision.filas.length > 0 && (
              <ul className="flex max-h-60 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {revision.filas.slice(0, 50).map((f) => (
                  <li key={f.nombre} className="flex justify-between gap-2 px-3 py-1.5">
                    <span className="min-w-0 truncate">
                      {f.nombre} <span className="text-muted-foreground">· {f.categoria}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">{formatearCentavos(f.precio_centavos)}</span>
                  </li>
                ))}
              </ul>
            )}
            <Button type="button" className="h-10 self-start" disabled={guardando || revision.errores.length > 0 || revision.filas.length === 0} onClick={importar}>
              {guardando ? "Importando…" : `Importar ${revision.filas.length}`}
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
