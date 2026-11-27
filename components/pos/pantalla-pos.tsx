"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { formatearCentavos, MIN_MOTIVO } from "@/lib/domain/caja";
import { etiquetaNoche, formatearFechaLarga, nocheOperativaMexico } from "@/lib/fechas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TemaReportesContenedor } from "@/components/tema-reportes";
import { ConciliacionNoche } from "@/components/pos/conciliacion-noche";
import { CLASE_SELECT, ImportarVentas } from "@/components/pos/importar-ventas";
import type { Profile } from "@/types";

// Ventas del POS: importar, conciliar y ver las importaciones. Se monta en
// /staff/pos (gerente) y /dueno/pos (dueño y admin). Quién puede y en qué
// antros lo decide la base (pos_mis_antros: rol + bandera pos_ventas).

type Rol = Profile["role"];
const PERMITIDOS: readonly Rol[] = ["gerente", "dueno", "admin"];
const PANEL_DE: Partial<Record<Rol, string>> = { staff: "/staff/panel", rp: "/rp/panel", cliente: "/cliente" };

// noche_en_curso: la noche operativa del antro en SU zona horaria
// (club_fecha_operacion), no la del centro.
type Antro = { club_id: string; nombre: string; noche_en_curso: string | null };
type Sesion =
  | { estado: "cargando" }
  | { estado: "listo"; antros: Antro[] }
  | { estado: "sin_acceso"; panel: string }
  | { estado: "error"; mensaje: string };
type Pestana = "importar" | "conciliar" | "importaciones";

export function PantallaPos({ volver }: { volver: string }) {
  const router = useRouter();
  const [sesion, setSesion] = useState<Sesion>({ estado: "cargando" });
  const [clubId, setClubId] = useState<string | null>(null);
  const [pestana, setPestana] = useState<Pestana>("importar");
  const [noche, setNoche] = useState(() => nocheOperativaMexico());

  useEffect(() => {
    async function cargar() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return router.replace("/cliente/login");
      const { data: perfil } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (!perfil) return router.replace("/cliente/login");
      const rol = perfil.role as Rol;
      if (!PERMITIDOS.includes(rol)) return setSesion({ estado: "sin_acceso", panel: PANEL_DE[rol] ?? "/cliente" });
      const { data, error } = await supabase.rpc("pos_mis_antros");
      if (error) {
        return setSesion({
          estado: "error",
          mensaje: error.code === "PGRST202" ? "Las ventas del POS todavía no están disponibles." : mensajeParaUsuario(error, "No pudimos cargar tus antros."),
        });
      }
      const antros = (Array.isArray(data) ? data : []) as Antro[];
      setSesion({ estado: "listo", antros });
      setClubId(antros[0]?.club_id ?? null);
      if (antros[0]?.noche_en_curso) setNoche(antros[0].noche_en_curso);
    }
    void cargar();
  }, [router]);

  return (
    <TemaReportesContenedor className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Button render={<Link href={volver} />} nativeButton={false} variant="ghost" className="h-10 self-start px-2">
            <ChevronLeft /> Volver al panel
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Ventas del POS</h1>
          <p className="text-sm text-muted-foreground">
            Sube lo que vendió el punto de venta y compáralo con lo registrado en caja. Es solo para revisar: no cambia la caja, las comisiones ni la nómina.
          </p>
        </div>

        {sesion.estado === "cargando" && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {sesion.estado === "error" && (
          <p role="alert" className="text-sm text-status-err">
            {sesion.mensaje}
          </p>
        )}
        {sesion.estado === "sin_acceso" && (
          <Card>
            <CardContent className="flex flex-col gap-3 px-4">
              <p className="text-sm">Las ventas del POS son para el gerente y el dueño del antro.</p>
              <Button render={<Link href={sesion.panel} />} nativeButton={false} variant="outline" className="h-10 self-start">
                Ir a mi panel
              </Button>
            </CardContent>
          </Card>
        )}
        {sesion.estado === "listo" && sesion.antros.length === 0 && (
          <p className="text-sm text-muted-foreground">Las ventas del POS no están activas para tu antro.</p>
        )}
        {sesion.estado === "listo" && clubId && (
          <>
            {sesion.antros.length > 1 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pos-antro">Antro</Label>
                <select
                  id="pos-antro"
                  className={CLASE_SELECT}
                  value={clubId}
                  onChange={(e) => {
                    setClubId(e.target.value);
                    const n = sesion.antros.find((a) => a.club_id === e.target.value)?.noche_en_curso;
                    if (n) setNoche(n);
                  }}
                >
                  {sesion.antros.map((a) => (
                    <option key={a.club_id} value={a.club_id}>
                      {a.nombre}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div role="tablist" aria-label="Ventas del POS" className="grid grid-cols-3 gap-2">
              {(
                [
                  ["importar", "Importar"],
                  ["conciliar", "Conciliar"],
                  ["importaciones", "Importaciones"],
                ] as const
              ).map(([id, etiqueta]) => (
                <Button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={pestana === id}
                  variant={pestana === id ? "default" : "outline"}
                  className="h-10 px-1"
                  onClick={() => setPestana(id)}
                >
                  {etiqueta}
                </Button>
              ))}
            </div>
            {pestana === "importar" && (
              <ImportarVentas
                key={clubId}
                clubId={clubId}
                onImportado={(noches) => {
                  setNoche(noches[noches.length - 1] ?? noche);
                  setPestana("conciliar");
                }}
              />
            )}
            {pestana === "conciliar" && <ConciliacionNoche key={clubId} clubId={clubId} noche={noche} onNoche={setNoche} />}
            {pestana === "importaciones" && (
              <Importaciones
                key={clubId}
                clubId={clubId}
                onVerNoche={(n) => {
                  setNoche(n);
                  setPestana("conciliar");
                }}
              />
            )}
          </>
        )}
      </div>
    </TemaReportesContenedor>
  );
}

interface Importacion {
  id: string;
  archivo_nombre: string;
  formato: string;
  lineas_archivo: number;
  lineas_nuevas: number;
  lineas_propias: number;
  lineas_repetidas: number;
  total_centavos: number;
  importado_en: string;
  importado_por_nombre: string | null;
  deshecha_en: string | null;
  motivo_deshacer: string | null;
  noches: string[];
}

function Importaciones({ clubId, onVerNoche }: { clubId: string; onVerNoche: (n: string) => void }) {
  const [lista, setLista] = useState<Importacion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deshaciendo, setDeshaciendo] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const { data, error: e } = await createClient().rpc("pos_importaciones_lista", { p_club_id: clubId });
    if (e) {
      setLista([]);
      return setError(mensajeParaUsuario(e, "No pudimos cargar las importaciones."));
    }
    setLista((data ?? []) as Importacion[]);
  }, [clubId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function deshacer(id: string) {
    setOcupado(true);
    setError(null);
    const { data, error: e } = await createClient().rpc("pos_importacion_deshacer", { p_importacion_id: id, p_motivo: motivo.trim() });
    setOcupado(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo deshacer la importación."));
    const r = (data ?? {}) as { borradas?: number; conservadas?: number };
    setAviso(
      `Importación deshecha: ${r.borradas ?? 0} ventas borradas` +
        (r.conservadas ? `; ${r.conservadas} se conservan porque también vienen en otro archivo importado.` : "."),
    );
    setDeshaciendo(null);
    setMotivo("");
    await cargar();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Importaciones</CardTitle>
        <CardDescription>
          Las últimas 50. Deshacer (por ejemplo, si se mapeó mal) borra las ventas de ese archivo, salvo las que también vienen en otro archivo
          importado, y deja que se vuelva a subir.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {lista === null && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {lista?.length === 0 && !error && <p className="text-sm text-muted-foreground">Todavía no hay importaciones.</p>}
        <ul className="flex flex-col gap-3">
          {(lista ?? []).map((i) => (
            <li key={i.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0 font-medium break-all">{i.archivo_nombre}</span>
                {i.deshecha_en ? <Badge variant="neutral">Deshecha</Badge> : <span className="tabular-nums">{formatearCentavos(Number(i.total_centavos))}</span>}
              </div>
              <span className="text-xs text-muted-foreground">
                {formatearFechaLarga(i.importado_en)}
                {i.importado_por_nombre && ` · ${i.importado_por_nombre}`} · {i.lineas_nuevas} nuevas
                {i.lineas_repetidas > 0 && `, ${i.lineas_repetidas} repetidas`} · {i.formato.toUpperCase()}
              </span>
              {i.deshecha_en && i.motivo_deshacer && <span className="text-xs text-muted-foreground">Motivo: {i.motivo_deshacer}</span>}
              {!i.deshecha_en && (
                <div className="flex flex-wrap gap-2">
                  {i.noches.map((n) => (
                    <Button key={n} type="button" variant="outline" className="h-10" onClick={() => onVerNoche(n)}>
                      {etiquetaNoche(n)}
                    </Button>
                  ))}
                  {deshaciendo !== i.id && (
                    <Button type="button" variant="outline" className="h-10" onClick={() => (setDeshaciendo(i.id), setMotivo(""))}>
                      Deshacer
                    </Button>
                  )}
                </div>
              )}
              {deshaciendo === i.id && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`pos-motivo-${i.id}`}>Motivo</Label>
                  <Input id={`pos-motivo-${i.id}`} value={motivo} maxLength={300} onChange={(e) => setMotivo(e.target.value)} className="h-10" />
                  <div className="flex gap-2">
                    <Button type="button" variant="destructive" className="h-10" disabled={ocupado || motivo.trim().length < MIN_MOTIVO} onClick={() => deshacer(i.id)}>
                      Deshacer ({i.lineas_propias} {i.lineas_propias === 1 ? "venta se borra" : "ventas se borran"})
                    </Button>
                    <Button type="button" variant="outline" className="h-10" onClick={() => setDeshaciendo(null)}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {aviso && <p className="text-sm text-status-ok">{aviso}</p>}
        {error && (
          <p role="alert" className="text-sm text-status-err">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
