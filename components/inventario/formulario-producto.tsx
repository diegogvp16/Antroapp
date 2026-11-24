"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MensajeError, useAccion } from "@/components/caja/accion";
import { createClient } from "@/lib/supabase/client";
import { centavosATexto, montoValido, pesosACentavos, type Producto } from "@/lib/domain/caja";

// Alta o edición de un producto del catálogo (fase 2). Todo pasa por
// producto_guardar en la base: solo el gerente o el dueño del antro.
export function FormularioProducto({
  clubId,
  producto,
  categoriasExistentes,
  onGuardado,
  onCancelar,
}: {
  clubId: string;
  producto?: Producto;
  categoriasExistentes: string[];
  onGuardado: () => Promise<void> | void;
  onCancelar?: () => void;
}) {
  const nuevo = !producto;
  const [nombre, setNombre] = useState(producto?.nombre ?? "");
  const [categoria, setCategoria] = useState(producto?.categoria ?? "");
  const [precio, setPrecio] = useState(producto ? centavosATexto(producto.precio_centavos) : "");
  const [iniciales, setIniciales] = useState("0");
  const [minimo, setMinimo] = useState(String(producto?.existencias_minimas ?? 0));
  const [activo, setActivo] = useState(producto?.activo ?? true);
  const { ocupado, error, ejecutar } = useAccion();

  const precioCent = pesosACentavos(precio);
  const entero = (t: string) => (/^\d{1,6}$/.test(t.trim()) ? Number(t.trim()) : null);
  const valido = nombre.trim() && categoria.trim() && montoValido(precioCent) && entero(minimo) !== null && (!nuevo || entero(iniciales) !== null);
  const idLista = `categorias-${producto?.id ?? "nuevo"}`;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valido || precioCent === null) return;
        const ok = await ejecutar(
          () =>
            createClient().rpc("producto_guardar", {
              p_club_id: clubId,
              p_id: producto?.id ?? null,
              p_nombre: nombre.trim(),
              p_categoria: categoria.trim(),
              p_precio_centavos: precioCent,
              p_existencias_minimas: entero(minimo) ?? 0,
              p_activo: activo,
              p_existencias_iniciales: nuevo ? (entero(iniciales) ?? 0) : 0,
            }),
          onGuardado,
        );
        if (ok && nuevo) {
          setNombre("");
          setPrecio("");
          setIniciales("0");
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`nombre-${idLista}`}>Nombre</Label>
          <Input id={`nombre-${idLista}`} value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={80} placeholder="Ej. Cerveza clara" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`cat-${idLista}`}>Categoría</Label>
          <Input id={`cat-${idLista}`} value={categoria} onChange={(e) => setCategoria(e.target.value)} maxLength={40} list={idLista} placeholder="Ej. Cervezas" />
          <datalist id={idLista}>
            {categoriasExistentes.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`precio-${idLista}`}>Precio ($)</Label>
          <Input id={`precio-${idLista}`} value={precio} onChange={(e) => setPrecio(e.target.value)} inputMode="decimal" placeholder="0.00" />
        </div>
        {nuevo && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`ini-${idLista}`}>Existencias iniciales</Label>
            <Input id={`ini-${idLista}`} value={iniciales} onChange={(e) => setIniciales(e.target.value)} inputMode="numeric" />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`min-${idLista}`}>Avisar cuando queden (mínimo)</Label>
          <Input id={`min-${idLista}`} value={minimo} onChange={(e) => setMinimo(e.target.value)} inputMode="numeric" />
        </div>
      </div>
      {!nuevo && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} className="size-5" />
          Se vende (si lo apagas, ya no aparece en la caja; no se borra)
        </label>
      )}
      {precio && !montoValido(precioCent) && <p className="text-xs text-destructive">Precio no válido (ej. 90 o 1250.50).</p>}
      <MensajeError mensaje={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-11" disabled={!valido || ocupado}>
          {ocupado ? "Guardando..." : nuevo ? "Agregar al catálogo" : "Guardar cambios"}
        </Button>
        {onCancelar && (
          <Button type="button" variant="ghost" className="h-11" onClick={onCancelar} disabled={ocupado}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}

// Ajuste de existencias con motivo (llegó pedido, conteo, merma).
export function AjusteExistencias({ producto, onGuardado, onCancelar }: { producto: Producto; onGuardado: () => Promise<void> | void; onCancelar: () => void }) {
  const [cantidad, setCantidad] = useState("");
  const [signo, setSigno] = useState<1 | -1>(1);
  const [motivo, setMotivo] = useState("");
  const { ocupado, error, ejecutar } = useAccion();
  const n = /^\d{1,6}$/.test(cantidad.trim()) ? Number(cantidad.trim()) : null;
  const valido = n !== null && n > 0 && motivo.trim().length >= 3;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valido || n === null) return;
        await ejecutar(
          () => createClient().rpc("producto_ajustar_existencias", { p_producto_id: producto.id, p_cantidad: signo * n, p_motivo: motivo.trim() }),
          onGuardado,
        );
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        {([1, -1] as const).map((s) => (
          <Button key={s} type="button" variant={signo === s ? "default" : "outline"} className="h-11" onClick={() => setSigno(s)} aria-pressed={signo === s}>
            {s === 1 ? "Entra (pedido)" : "Sale (merma, conteo)"}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`aj-n-${producto.id}`}>Cantidad</Label>
          <Input id={`aj-n-${producto.id}`} value={cantidad} onChange={(e) => setCantidad(e.target.value)} inputMode="numeric" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`aj-m-${producto.id}`}>Motivo</Label>
          <Input id={`aj-m-${producto.id}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={300} placeholder="Ej. llegó el pedido del jueves" />
        </div>
      </div>
      <MensajeError mensaje={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="h-11" disabled={!valido || ocupado}>
          {ocupado ? "Guardando..." : `${signo === 1 ? "Sumar" : "Restar"} ${n ?? ""}`}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={onCancelar} disabled={ocupado}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
