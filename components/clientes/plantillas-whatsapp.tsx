"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mensajeParaUsuario } from "@/lib/errores-base";
import { Button } from "@/components/ui/button";
import { CLASE_TEXTO } from "@/components/clientes/form-motivo";
import {
  AVISO_ENLACE_WA,
  DATOS_EJEMPLO,
  INFO_PLANTILLA,
  INFO_VARIABLE,
  MAX_PLANTILLA,
  PLANTILLAS_FABRICA,
  TIPOS_PLANTILLA,
  VARIABLES_PLANTILLA,
  plantillaEfectiva,
  renderPlantilla,
  validarPlantilla,
  type TipoPlantilla,
} from "@/lib/domain/whatsapp";

// Textos de los mensajes de WhatsApp del antro (gerente, dueño). Sin texto
// propio vale el de fábrica. La base valida igual (variables y largo).

export function PlantillasWhatsApp({
  clubId,
  antro,
  horario,
  propias,
  onGuardado,
}: {
  clubId: string;
  antro: string;
  horario: string | null;
  propias: Partial<Record<TipoPlantilla, string>>;
  onGuardado: () => Promise<void> | void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        AntroApp no manda mensajes: arma el texto y abre WhatsApp en el teléfono de quien lo usa. {AVISO_ENLACE_WA}
      </p>
      {TIPOS_PLANTILLA.map((t) => (
        <EditorPlantilla
          key={t}
          clubId={clubId}
          tipo={t}
          propia={propias[t] ?? null}
          inicial={plantillaEfectiva(t, propias)}
          ejemplo={{ ...DATOS_EJEMPLO, antro: antro || DATOS_EJEMPLO.antro, hora: horario || DATOS_EJEMPLO.hora }}
          onGuardado={onGuardado}
        />
      ))}
    </div>
  );
}

function EditorPlantilla({
  clubId,
  tipo,
  propia,
  inicial,
  ejemplo,
  onGuardado,
}: {
  clubId: string;
  tipo: TipoPlantilla;
  propia: string | null;
  inicial: string;
  ejemplo: typeof DATOS_EJEMPLO;
  onGuardado: () => Promise<void> | void;
}) {
  const [texto, setTexto] = useState(inicial);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const v = validarPlantilla(texto);
  const cambiado = texto.trim() !== inicial.trim();

  async function guardar(valor: string | null) {
    setGuardando(true);
    setError(null);
    setAviso(null);
    const { error: e } = await createClient().rpc("whatsapp_plantilla_guardar", { p_club: clubId, p_tipo: tipo, p_texto: valor });
    setGuardando(false);
    if (e) return setError(mensajeParaUsuario(e, "No se pudo guardar. Intenta de nuevo."));
    if (valor === null) setTexto(PLANTILLAS_FABRICA[tipo]);
    setAviso(valor === null ? "Volvió al texto de fábrica." : "Guardado.");
    await onGuardado();
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium">{INFO_PLANTILLA[tipo].nombre}</h2>
        <span className="text-xs text-muted-foreground">{propia ? "Texto propio" : "De fábrica"}</span>
      </div>
      <p className="text-xs text-muted-foreground">{INFO_PLANTILLA[tipo].uso}</p>
      <textarea
        className={CLASE_TEXTO}
        rows={6}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        aria-label={`Texto de ${INFO_PLANTILLA[tipo].nombre}`}
        aria-invalid={!v.ok}
      />
      <div className="flex flex-wrap gap-1.5" aria-label="Agregar variable">
        {VARIABLES_PLANTILLA.map((x) => (
          <button
            key={x}
            type="button"
            title={INFO_VARIABLE[x]}
            onClick={() => setTexto((t) => `${t}${t.endsWith(" ") || t.endsWith("\n") || t === "" ? "" : " "}{${x}}`)}
            className="h-10 rounded-md border border-border px-2 font-mono text-xs hover:bg-muted"
          >
            {`{${x}}`}
          </button>
        ))}
      </div>
      <p className={v.largo > MAX_PLANTILLA ? "text-xs text-status-err" : "text-xs text-muted-foreground"}>
        {v.largo} de {MAX_PLANTILLA} caracteres
      </p>
      {!v.ok && (
        <ul role="alert" className="text-sm text-status-err">
          {v.errores.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Vista previa (datos de ejemplo)</span>
        <p className="whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm">{renderPlantilla(texto, ejemplo)}</p>
      </div>
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
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="h-10" disabled={!v.ok || !cambiado || guardando} onClick={() => void guardar(texto)}>
          {guardando ? "Guardando…" : "Guardar"}
        </Button>
        {propia && (
          <Button type="button" variant="outline" className="h-10" disabled={guardando} onClick={() => void guardar(null)}>
            Volver al de fábrica
          </Button>
        )}
        {!propia && cambiado && (
          <Button type="button" variant="ghost" className="h-10" onClick={() => setTexto(PLANTILLAS_FABRICA[tipo])}>
            Deshacer
          </Button>
        )}
      </div>
    </section>
  );
}
