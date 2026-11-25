"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { esquemaPlantilla, precargaDesdePlantilla } from "@/lib/domain/alta-club";
import { aEntrada, BORRADOR_INICIAL, borradorDesdeClon, erroresDelPaso, PASO, PASOS, pasoDeRuta, type Borrador } from "@/components/admin/alta/estado";
import { PasoDatos } from "@/components/admin/alta/paso-datos";
import { PasoPoliticas } from "@/components/admin/alta/paso-politicas";
import { PasoMesas } from "@/components/admin/alta/paso-mesas";
import { PasoReglas } from "@/components/admin/alta/paso-reglas";
import { PasoEquipo } from "@/components/admin/alta/paso-equipo";
import { PasoGrupo, type GrupoExistente } from "@/components/admin/alta/paso-grupo";
import { PasoResumen } from "@/components/admin/alta/paso-resumen";
import { ResultadoAlta, type Credencial } from "@/components/admin/alta/resultado-alta";
import { AvisoClon } from "@/components/admin/alta/aviso-clon";

// Asistente de alta de un antro nuevo. La pantalla solo deja entrar al
// admin, pero quien manda es POST /api/admin/alta-club (y la función de la
// base), que vuelven a validar todo y a exigir admin.
//
// Con ?desde=<antro> es un CLON (B2): el asistente se precarga con la
// configuración del origen (admin_club_plantilla, solo admin) y el admin la
// revisa paso a paso como en cualquier alta. Al dar de alta, la base copia
// además el catálogo de productos del origen, sin existencias.

type Resultado = { nombre: string; publicado: boolean; credenciales: Credencial[]; aviso: string | null };
type EstadoClon = { estado: "cargando" } | { estado: "error"; mensaje: string } | null;

export default function AltaAntroPage() {
  const router = useRouter();
  const [listo, setListo] = useState(false);
  const [paso, setPaso] = useState(0);
  const [b, setB] = useState<Borrador>(BORRADOR_INICIAL);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [grupos, setGrupos] = useState<GrupoExistente[] | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [clon, setClon] = useState<EstadoClon>(null);
  const [intentoClon, setIntentoClon] = useState(0);
  const titulo = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return router.replace("/admin/login");
      const { data: perfil } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (perfil?.role !== "admin") return router.replace("/admin/login");
      // Sin parpadeo del asistente vacío mientras se lee la plantilla.
      if (new URLSearchParams(window.location.search).get("desde")) setClon({ estado: "cargando" });
      setListo(true);
      const { data } = await supabase.from("grupos").select("id, nombre, grupo_clubs(club_id)").order("nombre");
      setGrupos((data ?? []).map((g) => ({ id: g.id, nombre: g.nombre, antros: g.grupo_clubs?.length ?? 0 })));
    })();
  }, [router]);

  // Clon: lee la plantilla del origen (se lee de la URL aquí para no
  // necesitar un Suspense con useSearchParams).
  useEffect(() => {
    if (!listo) return;
    const desde = new URLSearchParams(window.location.search).get("desde");
    if (!desde) return;
    let vigente = true;
    setClon({ estado: "cargando" });
    (async () => {
      const { data, error } = await createClient().rpc("admin_club_plantilla", { p_club: desde });
      if (!vigente) return;
      if (error) {
        setClon({ estado: "error", mensaje: mensajeParaUsuario(error, "No se pudo leer la configuración del antro de origen.") });
        return;
      }
      const plantilla = esquemaPlantilla.safeParse(data);
      if (!plantilla.success) {
        console.error("Plantilla de clon inesperada", plantilla.error.issues[0]);
        setClon({ estado: "error", mensaje: "La configuración del antro de origen llegó incompleta. Intenta de nuevo." });
        return;
      }
      setB(borradorDesdeClon(precargaDesdePlantilla(plantilla.data)));
      setPaso(0);
      setClon(null);
    })();
    return () => {
      vigente = false;
    };
  }, [listo, intentoClon]);

  function altaEnBlanco() {
    setClon(null);
    setB(BORRADOR_INICIAL);
    setPaso(0);
    setErrores({});
    router.replace("/admin/alta-antro");
  }

  // Al cambiar de paso, el foco va al título (lectores de pantalla y teclado).
  useEffect(() => {
    titulo.current?.focus();
  }, [paso, resultado]);

  // Mientras escribe, los errores del paso se recalculan solo si ya se mostraron.
  const actualizar = (nuevo: Borrador) => {
    setB(nuevo);
    if (Object.keys(errores).length) setErrores(erroresDelPaso(paso, nuevo));
  };

  function siguiente() {
    const e = erroresDelPaso(paso, b);
    setErrores(e);
    if (Object.keys(e).length === 0) setPaso((p) => Math.min(p + 1, PASOS.length - 1));
  }
  function irA(i: number) {
    setErrores({});
    setErrorEnvio(null);
    setPaso(i);
  }

  async function enviar() {
    const e = erroresDelPaso(PASOS.length - 1, b);
    if (Object.keys(e).length) {
      const primero = Object.keys(e)[0];
      setPaso(pasoDeRuta(primero));
      setErrores(e);
      return;
    }
    setEnviando(true);
    setErrorEnvio(null);
    try {
      const res = await fetch("/api/admin/alta-club", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aEntrada(b)),
      });
      const cuerpo: { ok?: boolean; error?: string; aviso?: string; campos?: Record<string, string>; credenciales?: Credencial[] } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok || !cuerpo.ok) {
        if (cuerpo.campos && Object.keys(cuerpo.campos).length) {
          const primero = Object.keys(cuerpo.campos)[0];
          setPaso(pasoDeRuta(primero));
          setErrores(cuerpo.campos);
        }
        setErrorEnvio(cuerpo.error ?? "No se pudo dar de alta el antro. No se guardó nada; intenta de nuevo.");
        return;
      }
      setResultado({ nombre: b.datos.nombre.trim(), publicado: b.publicar, credenciales: cuerpo.credenciales ?? [], aviso: cuerpo.aviso ?? null });
    } catch {
      setErrorEnvio("Sin conexión: no se guardó nada. Revisa tu internet e intenta de nuevo.");
    } finally {
      setEnviando(false);
    }
  }

  if (!listo) return null;

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-8 sm:px-6">
      <div className="flex w-full max-w-2xl flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <Link href="/admin" className="inline-flex min-h-10 w-fit items-center text-sm text-muted-foreground underline-offset-4 hover:underline">
            ← Panel admin
          </Link>
        </div>

        {resultado ? (
          <Card>
            <CardContent className="px-5 py-5">
              <h1 ref={titulo} tabIndex={-1} className="sr-only">
                Alta terminada
              </h1>
              <ResultadoAlta
                nombreAntro={resultado.nombre}
                publicado={resultado.publicado}
                credenciales={resultado.credenciales}
                aviso={resultado.aviso}
                onOtro={() => {
                  setResultado(null);
                  altaEnBlanco();
                }}
              />
            </CardContent>
          </Card>
        ) : clon ? (
          <Card>
            <CardContent className="flex flex-col gap-4 px-5 py-5">
              <h1 ref={titulo} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
                Clonar antro
              </h1>
              {clon.estado === "cargando" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Leyendo la configuración del antro de origen…
                </p>
              ) : (
                <>
                  <p role="alert" className="rounded-lg border border-status-err/40 bg-status-err/10 p-3 text-sm text-status-err">
                    {clon.mensaje}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <Button type="button" className="h-11 px-5" onClick={() => setIntentoClon((n) => n + 1)}>
                      Intentar de nuevo
                    </Button>
                    <Button type="button" variant="outline" className="h-11 px-4" onClick={altaEnBlanco}>
                      Hacer un alta en blanco
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <header className="flex flex-col gap-3">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {b.clon ? "Clon de antro" : "Alta de antro"} · paso {paso + 1} de {PASOS.length}
              </p>
              <h1 ref={titulo} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
                {PASOS[paso]}
              </h1>
              <ol className="grid grid-cols-7 gap-1" aria-label="Pasos">
                {PASOS.map((nombre, i) => (
                  <li key={nombre}>
                    <button
                      type="button"
                      className="flex min-h-11 w-full flex-col justify-center gap-1 py-2 text-left disabled:cursor-default"
                      aria-current={i === paso ? "step" : undefined}
                      aria-label={`Paso ${i + 1}: ${nombre}`}
                      disabled={i > paso}
                      onClick={() => irA(i)}
                    >
                      <span className={`h-1.5 rounded-full ${i <= paso ? "bg-foreground" : "bg-border"}`} />
                      <span className={`hidden truncate text-xs sm:block ${i === paso ? "font-medium" : "text-muted-foreground"}`}>{nombre}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </header>

            {b.clon && paso === PASO.datos && <AvisoClon clon={b.clon} onEnBlanco={altaEnBlanco} />}

            <Card>
              <CardContent className="px-5 py-5">
                {paso === PASO.datos && <PasoDatos datos={b.datos} errores={errores} onCambio={(datos) => actualizar({ ...b, datos })} />}
                {paso === PASO.politicas && <PasoPoliticas politicas={b.politicas} errores={errores} onCambio={(politicas) => actualizar({ ...b, politicas })} />}
                {paso === PASO.mesas && <PasoMesas mesas={b.mesas} errores={errores} onCambio={(mesas) => actualizar({ ...b, mesas })} />}
                {paso === PASO.reglas && (
                  <PasoReglas
                    rp={b.rp}
                    permisos={b.permisos}
                    errores={errores}
                    onCambio={(rp) => actualizar({ ...b, rp })}
                    onPermisos={(permisos) => actualizar({ ...b, permisos })}
                  />
                )}
                {paso === PASO.equipo && (
                  <PasoEquipo
                    equipo={{ conDueno: b.conDueno, dueno: b.dueno, personal: b.personal }}
                    errores={errores}
                    onCambio={(eq) => actualizar({ ...b, ...eq })}
                  />
                )}
                {paso === PASO.grupo && <PasoGrupo grupo={b.grupo} grupos={grupos} hayDueno={b.conDueno} errores={errores} onCambio={(grupo) => actualizar({ ...b, grupo })} />}
                {paso === PASO.resumen && <PasoResumen borrador={b} grupos={grupos} onIrA={irA} onPublicar={(publicar) => setB({ ...b, publicar })} />}
              </CardContent>
            </Card>

            {Object.keys(errores).length > 0 && paso < PASOS.length - 1 && (
              <p role="alert" className="text-sm font-medium text-status-err">
                Revisa los campos marcados para seguir.
              </p>
            )}
            {errorEnvio && (
              <p role="alert" className="rounded-lg border border-status-err/40 bg-status-err/10 p-3 text-sm text-status-err">
                {errorEnvio}
              </p>
            )}

            <div className="flex items-center justify-between gap-3">
              <Button type="button" variant="outline" className="h-11 px-4" onClick={() => irA(paso - 1)} disabled={paso === 0 || enviando}>
                Atrás
              </Button>
              {paso < PASOS.length - 1 ? (
                <Button type="button" className="h-11 px-5" onClick={siguiente}>
                  Siguiente
                </Button>
              ) : (
                <Button type="button" className="h-11 px-5" onClick={enviar} disabled={enviando}>
                  {enviando ? "Dando de alta…" : b.publicar ? "Dar de alta y publicar" : "Dar de alta en borrador"}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
