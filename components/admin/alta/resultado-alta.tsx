"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ETIQUETA_ROL, type CuentaNueva } from "@/lib/domain/alta-club";

export type Credencial = CuentaNueva & { password: string };

// Pantalla final: las contraseñas temporales se ven SOLO aquí. Al salir de
// la página ya no hay forma de recuperarlas (no se guardan).
export function ResultadoAlta({
  nombreAntro,
  publicado,
  credenciales,
  onOtro,
}: {
  nombreAntro: string;
  publicado: boolean;
  credenciales: Credencial[];
  onOtro: () => void;
}) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    const texto = credenciales.map((c) => `${c.nombre}\t${ETIQUETA_ROL[c.rol]}\t${c.correo}\t${c.password}`).join("\n");
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
    } catch {
      setCopiado(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2" role="status">
        <Badge variant="ok">Listo</Badge>
        <h2 className="text-xl font-semibold tracking-tight text-balance">{nombreAntro} quedó dado de alta</h2>
        <p className="text-sm text-muted-foreground">
          {publicado ? "Está publicado: ya aparece para los clientes." : "Está en borrador: el público no lo ve hasta que lo publiques."}
        </p>
      </div>

      {credenciales.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="rounded-lg border border-status-warn/40 bg-status-warn/10 p-3 text-sm">
            <strong>Guarda estas contraseñas ahora.</strong> No se guardan en ningún lado: al salir de esta pantalla ya no se pueden ver. Entrégalas a cada
            persona por un medio privado; pueden cambiarla después.
          </div>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-label="Cuentas creadas">
            {credenciales.map((c) => (
              <li key={c.correo} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">{c.nombre}</span>
                  <span className="text-xs text-muted-foreground">{ETIQUETA_ROL[c.rol]}</span>
                </div>
                <span className="break-all text-muted-foreground">{c.correo}</span>
                <span className="font-mono text-base tracking-wide select-all" aria-label={`Contraseña temporal de ${c.nombre}`}>
                  {c.password}
                </span>
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" className="h-10 self-start" onClick={copiar}>
            {copiado ? "Copiado" : "Copiar todo (para una hoja de cálculo)"}
          </Button>
        </section>
      )}

      <div className="flex flex-wrap gap-2">
        <Button className="h-10" render={<Link href="/admin" />} nativeButton={false}>
          Volver al panel
        </Button>
        <Button type="button" variant="outline" className="h-10" onClick={onOtro}>
          Dar de alta otro antro
        </Button>
      </div>
    </div>
  );
}
