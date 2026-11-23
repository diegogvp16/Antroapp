"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TarjetaAntro, TotalesDelGrupo } from "@/components/grupo/cifras";
import { rangoDeAtajo, SelectorRango, type Atajo } from "@/components/grupo/selector-rango";
import { etiquetaRango, type RangoNoches } from "@/lib/fechas";
import {
  agruparPorCiudad,
  normalizarResumen,
  totalesGrupo,
  validarRango,
  type ResumenAntro,
} from "@/lib/domain/grupo";
import type { Profile } from "@/types";
import { TemaReportesContenedor } from "@/components/tema-reportes";

type Rol = Profile["role"];
type RolPermitido = "dueno" | "gerente" | "admin";

const VOLVER: Record<RolPermitido, string> = {
  dueno: "/dueno/panel",
  gerente: "/staff/panel",
  admin: "/admin",
};

// A dónde mandar a quien no puede ver esta vista.
const PANEL_DE: Partial<Record<Rol, string>> = {
  staff: "/staff/panel",
  rp: "/rp/panel",
  cliente: "/cliente",
};

function esPermitido(rol: Rol): rol is RolPermitido {
  return rol === "dueno" || rol === "gerente" || rol === "admin";
}

type Sesion =
  | { estado: "cargando" }
  | { estado: "permitido"; rol: RolPermitido }
  | { estado: "sin_acceso"; panel: string };

export default function GrupoPage() {
  const router = useRouter();
  const [sesion, setSesion] = useState<Sesion>({ estado: "cargando" });
  const [atajo, setAtajo] = useState<Atajo>("semana");
  const [rango, setRango] = useState<RangoNoches>(() => rangoDeAtajo("semana"));
  const [filas, setFilas] = useState<ResumenAntro[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  // Solo cuenta la respuesta de la última consulta.
  const ultimaCarga = useRef(0);

  // Sesión: dueño (también el de grupo), gerente o admin.
  useEffect(() => {
    async function cargarSesion() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/cliente/login");
        return;
      }
      const { data: perfil, error: errorPerfil } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (errorPerfil || !perfil) {
        router.replace("/cliente/login");
        return;
      }
      const rol = perfil.role as Rol;
      if (esPermitido(rol)) {
        setSesion({ estado: "permitido", rol });
      } else {
        setSesion({ estado: "sin_acceso", panel: PANEL_DE[rol] ?? "/cliente" });
      }
    }
    cargarSesion();
  }, [router]);

  const consultar = useCallback(async (r: RangoNoches) => {
    const numero = ++ultimaCarga.current;
    const invalido = validarRango(r);
    if (invalido) {
      setError(invalido);
      return;
    }
    setCargando(true);
    try {
      const { data, error: errorBase } = await createClient().rpc("grupo_resumen", {
        p_desde: r.desde,
        p_hasta: r.hasta,
      });
      if (numero !== ultimaCarga.current) return;
      if (errorBase) {
        setError(mensajeParaUsuario(errorBase, "No pudimos cargar el resumen del grupo. Intenta de nuevo."));
        return;
      }
      const crudas = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
      setFilas(crudas.map(normalizarResumen));
      setError(null);
    } catch (err) {
      console.error("Error cargando el resumen del grupo:", err);
      if (numero !== ultimaCarga.current) return;
      setError("No se pudo cargar. Revisa tu conexión e intenta de nuevo.");
    } finally {
      if (numero === ultimaCarga.current) setCargando(false);
    }
  }, []);

  const permitido = sesion.estado === "permitido";
  useEffect(() => {
    if (permitido) consultar(rango);
  }, [permitido, rango, consultar]);

  if (sesion.estado === "cargando") {
    return (
      <TemaReportesContenedor className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
        <p className="w-full max-w-2xl text-sm text-muted-foreground">Cargando...</p>
      </TemaReportesContenedor>
    );
  }

  if (sesion.estado === "sin_acceso") {
    return (
      <TemaReportesContenedor className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
        <Card className="w-full max-w-2xl">
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">Esta vista es para dueños y gerentes.</p>
            <Link
              href={sesion.panel}
              className="w-fit text-sm font-medium text-foreground underline underline-offset-4"
            >
              Ir a tu panel
            </Link>
          </CardContent>
        </Card>
      </TemaReportesContenedor>
    );
  }

  const unSoloAntro = sesion.rol === "gerente" || filas?.length === 1;
  const titulo = unSoloAntro ? "Resumen de tu antro" : "Panel de grupo";
  const ciudades = filas ? agruparPorCiudad(filas) : [];
  const variasCiudades = ciudades.length > 1;

  return (
    <TemaReportesContenedor className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <Link
          href={VOLVER[sesion.rol]}
          className="w-fit text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          ← Volver
        </Link>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold tracking-tight">{titulo}</h1>
            <p className="mt-1 text-sm text-muted-foreground tabular-nums">
              {etiquetaRango(rango)}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => consultar(rango)}
            disabled={cargando}
          >
            {cargando ? "Actualizando..." : "Actualizar"}
          </Button>
        </div>

        <SelectorRango
          atajo={atajo}
          rango={rango}
          deshabilitado={cargando}
          onCambiar={(a, r) => {
            setAtajo(a);
            setRango(r);
          }}
        />

        <p className="text-xs text-muted-foreground">
          Solo lectura. <span className="font-medium text-foreground">Consumo en caja</span>: todo lo
          registrado en las mesas, con y sin reserva, sin anulados.{" "}
          <span className="font-medium text-foreground">Entrada y conversión</span>: sobre las
          reservas que ya podían llegar (las de noches que no empiezan van aparte, como &quot;por
          venir&quot;); conversión = reservas cuya cuenta tuvo consumo. Comisiones y pagos por día, sin
          anulados. Cada antro cuenta sus noches en su propia hora.
        </p>

        {error && (
          <Card size="sm">
            <CardContent className="flex flex-col gap-2 px-4">
              <p className="text-sm break-words text-destructive" role="alert">
                {error}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => consultar(rango)}
              >
                Reintentar
              </Button>
            </CardContent>
          </Card>
        )}

        {!filas ? (
          !error && <p className="text-sm text-muted-foreground">Cargando el resumen...</p>
        ) : filas.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No hay antros que mostrar con tu cuenta.
          </p>
        ) : (
          <>
            {filas.length > 1 && <TotalesDelGrupo totales={totalesGrupo(filas)} />}

            {ciudades.map((grupo) => (
              <section key={grupo.ciudad} className="flex flex-col gap-3">
                {(variasCiudades || filas.length > 1) && (
                  <h2 className="text-lg font-semibold break-words">
                    {grupo.ciudad}
                    <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
                      {grupo.antros.length} {grupo.antros.length === 1 ? "antro" : "antros"}
                    </span>
                  </h2>
                )}
                {grupo.antros.map((antro) => (
                  <TarjetaAntro key={antro.club_id} antro={antro} rango={rango} rendimientoAbierto={unSoloAntro} />
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </TemaReportesContenedor>
  );
}
