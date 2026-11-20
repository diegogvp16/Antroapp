"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AjusteExistencias, FormularioProducto } from "@/components/inventario/formulario-producto";
import { formatearCentavos, type Producto } from "@/lib/domain/caja";
import { bajoStock, categorias, textoExistencias } from "@/lib/domain/inventario";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { FASE2_ACTIVA } from "@/lib/fase2";
import { cn } from "@/lib/utils";

// Catálogo de productos del antro (fase 2, bandera NEXT_PUBLIC_FASE2). Lo
// carga y edita el gerente; la base revisa el permiso en cada cambio.
type Estado = { tipo: "cargando" } | { tipo: "apagado" } | { tipo: "error"; mensaje: string } | { tipo: "listo"; clubId: string };
type Edicion = { id: string; modo: "editar" | "ajustar" } | null;

export default function CatalogoPage() {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>(FASE2_ACTIVA ? { tipo: "cargando" } : { tipo: "apagado" });
  const [productos, setProductos] = useState<Producto[] | null>(null);
  const [errorLista, setErrorLista] = useState<string | null>(null);
  const [edicion, setEdicion] = useState<Edicion>(null);

  useEffect(() => {
    if (!FASE2_ACTIVA) return;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return router.replace("/cliente/login");
      const { data: perfil, error } = await supabase.from("profiles").select("role, club_id, activo").eq("id", user.id).maybeSingle();
      if (error) return setEstado({ tipo: "error", mensaje: mensajeParaUsuario(error, "No pudimos cargar tu cuenta. Intenta de nuevo.") });
      if (!perfil || perfil.role !== "gerente" || !perfil.club_id || perfil.activo === false) return router.replace("/staff/panel");
      setEstado({ tipo: "listo", clubId: perfil.club_id as string });
    })();
  }, [router]);

  const clubId = estado.tipo === "listo" ? estado.clubId : null;
  const cargar = useCallback(async () => {
    if (!clubId) return;
    const { data, error } = await createClient()
      .from("productos")
      .select("id, nombre, categoria, precio_centavos, existencias, existencias_minimas, activo")
      .eq("club_id", clubId)
      .order("categoria")
      .order("nombre");
    if (error) {
      setErrorLista(mensajeParaUsuario(error, "No pudimos cargar el catálogo. Intenta de nuevo."));
      return;
    }
    setErrorLista(null);
    setProductos((data ?? []) as Producto[]);
  }, [clubId]);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const listaCategorias = useMemo(() => categorias(productos ?? []), [productos]);
  const bajos = (productos ?? []).filter((p) => p.activo && bajoStock(p));
  const grupos = listaCategorias.map((c) => ({ categoria: c, productos: (productos ?? []).filter((p) => p.categoria.trim().toLowerCase() === c.toLowerCase()) }));
  const tras = async () => {
    setEdicion(null);
    await cargar();
  };

  return (
    <div className="flex flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-10">
      <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
        <Link href="/staff/panel" className="-ml-2 flex h-11 w-fit items-center px-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          ← Panel
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Catálogo e inventario</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Lo que se vende en la caja. Cada venta descuenta existencias; anular un cargo las regresa. Nada se borra: un producto se apaga.
          </p>
        </div>

        {estado.tipo === "apagado" && <p className="text-sm text-muted-foreground">El catálogo todavía no está activo en tu antro.</p>}
        {estado.tipo === "cargando" && <p className="text-sm text-muted-foreground">Cargando…</p>}
        {estado.tipo === "error" && (
          <p className="text-sm text-destructive" role="alert">
            {estado.mensaje}
          </p>
        )}

        {clubId && (
          <>
            {bajos.length > 0 && (
              <div role="status" className="rounded-lg border border-status-warn/50 bg-status-warn/10 px-4 py-3 text-sm">
                <p className="font-medium">
                  {bajos.length === 1 ? "1 producto con existencias bajas" : `${bajos.length} productos con existencias bajas`}
                </p>
                <p className="mt-1 text-muted-foreground">{bajos.map((p) => `${p.nombre} (${textoExistencias(p).toLowerCase()})`).join(" · ")}</p>
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Agregar producto</CardTitle>
                <CardDescription>El precio es el que cobra la caja; el mínimo dispara el aviso de existencias bajas.</CardDescription>
              </CardHeader>
              <CardContent>
                <FormularioProducto clubId={clubId} categoriasExistentes={listaCategorias} onGuardado={cargar} />
              </CardContent>
            </Card>

            {errorLista && (
              <div className="flex flex-col gap-2" role="alert">
                <p className="text-sm text-destructive">{errorLista}</p>
                <Button type="button" variant="outline" className="h-11 w-fit" onClick={() => void cargar()}>
                  Reintentar
                </Button>
              </div>
            )}
            {productos && productos.length === 0 && (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                Todavía no hay productos. Agrega el primero arriba: en cuanto haya uno, la caja muestra el catálogo al agregar consumo.
              </p>
            )}

            {grupos.map((g) => (
              <section key={g.categoria} className="flex flex-col gap-2">
                <h2 className="text-lg font-semibold">
                  {g.categoria}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">{g.productos.length}</span>
                </h2>
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                  {g.productos.map((p) => (
                    <li key={p.id} className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className={cn("min-w-0 font-medium", !p.activo && "text-muted-foreground line-through")}>{p.nombre}</span>
                        <span className="tabular-nums">{formatearCentavos(p.precio_centavos)}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className={cn("tabular-nums", p.activo && bajoStock(p) ? "font-medium text-status-warn" : "text-muted-foreground")}>
                          {textoExistencias(p)} · mínimo {p.existencias_minimas}
                        </span>
                        {!p.activo && <Badge variant="neutral">No se vende</Badge>}
                        <span className="ml-auto flex gap-1">
                          <Button type="button" variant="ghost" className="h-11" onClick={() => setEdicion({ id: p.id, modo: "ajustar" })}>
                            Existencias
                          </Button>
                          <Button type="button" variant="ghost" className="h-11" onClick={() => setEdicion({ id: p.id, modo: "editar" })}>
                            Editar
                          </Button>
                        </span>
                      </div>
                      {edicion?.id === p.id && edicion.modo === "editar" && (
                        <FormularioProducto clubId={clubId} producto={p} categoriasExistentes={listaCategorias} onGuardado={tras} onCancelar={() => setEdicion(null)} />
                      )}
                      {edicion?.id === p.id && edicion.modo === "ajustar" && (
                        <AjusteExistencias producto={p} onGuardado={tras} onCancelar={() => setEdicion(null)} />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
