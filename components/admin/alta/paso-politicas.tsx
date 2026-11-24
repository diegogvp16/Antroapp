"use client";

import { Input } from "@/components/ui/input";
import { CoverCampo } from "@/components/cover-campo";
import { Campo, TEXTAREA_CLASES, describir } from "./campo";
import type { Borrador } from "./estado";

type Politicas = Borrador["politicas"];

export function PasoPoliticas({
  politicas: p,
  errores,
  onCambio,
}: {
  politicas: Politicas;
  errores: Record<string, string>;
  onCambio: (p: Politicas) => void;
}) {
  const set = <K extends keyof Politicas>(k: K, v: Politicas[K]) => onCambio({ ...p, [k]: v });
  const err = (k: string) => errores[`politicas.${k}`];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <CoverCampo
          idPrefix="alta"
          modo={p.cover_modo}
          monto={p.cover_texto}
          onModoChange={(m) => onCambio({ ...p, cover_modo: m, cover_texto: m === "monto" ? p.cover_texto : "" })}
          onMontoChange={(t) => set("cover_texto", t)}
        />
        {err("cover_monto") && (
          <p role="alert" className="text-xs font-medium text-status-err">
            {err("cover_monto")}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Campo id="alta-deposito" etiqueta="Depósito por reserva (pesos)" opcional error={err("deposito_monto")} ayuda="Solo informativo: la app no cobra nada al cliente.">
          <Input
            id="alta-deposito"
            className="h-10"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={p.deposito_texto}
            aria-invalid={!!err("deposito_monto") || undefined}
            aria-describedby={describir("alta-deposito", err("deposito_monto"), "x")}
            onChange={(e) => set("deposito_texto", e.target.value)}
          />
        </Campo>
        <Campo id="alta-edad" etiqueta="Edad mínima" opcional error={err("edad_minima")}>
          <Input
            id="alta-edad"
            className="h-10"
            inputMode="numeric"
            autoComplete="off"
            value={p.edad_texto}
            aria-invalid={!!err("edad_minima") || undefined}
            aria-describedby={describir("alta-edad", err("edad_minima"))}
            onChange={(e) => set("edad_texto", e.target.value.replace(/\D/g, "").slice(0, 2))}
          />
        </Campo>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Campo id="alta-vestimenta" etiqueta="Código de vestimenta" opcional error={err("codigo_vestimenta")}>
          <Input id="alta-vestimenta" className="h-10" maxLength={200} placeholder="Casual elegante" value={p.codigo_vestimenta} onChange={(e) => set("codigo_vestimenta", e.target.value)} />
        </Campo>
        <Campo id="alta-musica" etiqueta="Música" opcional error={err("tipo_musica")}>
          <Input id="alta-musica" className="h-10" maxLength={200} placeholder="Reggaetón y house" value={p.tipo_musica} onChange={(e) => set("tipo_musica", e.target.value)} />
        </Campo>
      </div>

      <Campo id="alta-ambiente" etiqueta="Ambiente" opcional error={err("ambiente")}>
        <textarea id="alta-ambiente" className={TEXTAREA_CLASES} maxLength={500} value={p.ambiente} onChange={(e) => set("ambiente", e.target.value)} />
      </Campo>

      <Campo
        id="alta-tolerancia"
        etiqueta="Hora límite de llegada"
        opcional
        error={err("tolerancia_hora")}
        ayuda="Si el cliente llega después, la caja lo marca como «llegó tarde». No bloquea la entrada."
      >
        <Input
          id="alta-tolerancia"
          type="time"
          className="h-10 w-40"
          value={p.tolerancia_hora}
          aria-describedby={describir("alta-tolerancia", err("tolerancia_hora"), "x")}
          onChange={(e) => set("tolerancia_hora", e.target.value)}
        />
      </Campo>
    </div>
  );
}
