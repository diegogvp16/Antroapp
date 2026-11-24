"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { textoCover } from "@/lib/cover";
import { ETIQUETA_ROL, ROLES_PERSONAL, ZONAS_MEXICO } from "@/lib/domain/alta-club";
import { aEntrada, type Borrador } from "./estado";
import type { GrupoExistente } from "./paso-grupo";

function Fila({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{etiqueta}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Seccion({ titulo, onEditar, children }: { titulo: string; onEditar: () => void; children: ReactNode }) {
  return (
    <section className="flex flex-col border-b border-border pb-3 last:border-b-0">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{titulo}</h3>
        <Button type="button" variant="link" size="sm" onClick={onEditar}>
          Editar
        </Button>
      </div>
      <dl>{children}</dl>
    </section>
  );
}

export function PasoResumen({
  borrador: b,
  grupos,
  onIrA,
  onPublicar,
}: {
  borrador: Borrador;
  grupos: GrupoExistente[] | null;
  onIrA: (paso: number) => void;
  onPublicar: (v: boolean) => void;
}) {
  const e = aEntrada(b);
  const p = e.politicas;
  const cover = textoCover({ cover_modo: p.cover_modo, cover_monto: p.cover_monto ?? null }) ?? "No se muestra";
  const zona = ZONAS_MEXICO.find((z) => z.valor === b.datos.zona_horaria)?.etiqueta ?? b.datos.zona_horaria;
  const capacidad = b.mesas.reduce((s, m) => s + (Number.isFinite(m.capacidad) ? m.capacidad : 0), 0);
  const grupoTexto =
    b.grupo.modo === "ninguno"
      ? "Independiente"
      : b.grupo.modo === "nuevo"
        ? `Grupo nuevo «${b.grupo.nombre.trim()}»`
        : `Se agrega a «${grupos?.find((g) => g.id === b.grupo.grupo_id)?.nombre ?? "—"}»`;
  const duenoGrupo =
    b.grupo.modo === "ninguno"
      ? null
      : b.grupo.dueno_grupo === "dueno_antro"
        ? "El dueño de este antro"
        : b.grupo.dueno_grupo === "cuenta_nueva"
          ? `${b.grupo.cuenta.nombre.trim()} (${b.grupo.cuenta.correo.trim().toLowerCase()}), cuenta nueva`
          : "Sin cambios";

  return (
    <div className="flex flex-col gap-4">
      <Seccion titulo="Datos" onEditar={() => onIrA(0)}>
        <Fila etiqueta="Nombre">{b.datos.nombre.trim()}</Fila>
        <Fila etiqueta="Dirección">{b.datos.direccion.trim()}</Fila>
        <Fila etiqueta="Ciudad">{b.datos.ciudad.trim()}</Fila>
        <Fila etiqueta="Zona horaria">{zona}</Fila>
        <Fila etiqueta="Horario">{b.datos.horario.trim()}</Fila>
      </Seccion>
      <Seccion titulo="Cover y políticas" onEditar={() => onIrA(1)}>
        <Fila etiqueta="Cover">{cover}</Fila>
        <Fila etiqueta="Depósito">{p.deposito_monto ? `$${Number(p.deposito_monto).toLocaleString("es-MX")} (informativo)` : "Sin depósito"}</Fila>
        <Fila etiqueta="Edad mínima">{p.edad_minima ?? "—"}</Fila>
        <Fila etiqueta="Vestimenta">{p.codigo_vestimenta || "—"}</Fila>
        <Fila etiqueta="Música">{p.tipo_musica || "—"}</Fila>
        <Fila etiqueta="Llegada hasta">{p.tolerancia_hora ?? "Sin límite"}</Fila>
      </Seccion>
      <Seccion titulo="Mesas" onEditar={() => onIrA(2)}>
        <Fila etiqueta="Mesas">
          {b.mesas.length} · {capacidad} personas
        </Fila>
        {b.mesas.length > 0 && (
          <Fila etiqueta="Nombres">
            {b.mesas
              .slice(0, 12)
              .map((m) => m.numero.trim())
              .join(", ")}
            {b.mesas.length > 12 ? ` y ${b.mesas.length - 12} más` : ""}
          </Fila>
        )}
      </Seccion>
      <Seccion titulo="Equipo" onEditar={() => onIrA(3)}>
        <Fila etiqueta="Dueño">{b.conDueno ? `${b.dueno.nombre.trim()} (${b.dueno.correo.trim().toLowerCase()})` : "Sin dueño por ahora"}</Fila>
        {ROLES_PERSONAL.map((r) => (
          <Fila key={r} etiqueta={ETIQUETA_ROL[r]}>
            {b.personal.filter((x) => x.rol === r).length}
          </Fila>
        ))}
      </Seccion>
      <Seccion titulo="Grupo" onEditar={() => onIrA(4)}>
        <Fila etiqueta="Grupo">{grupoTexto}</Fila>
        {duenoGrupo && <Fila etiqueta="Dueño del grupo">{duenoGrupo}</Fila>}
      </Seccion>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">¿Cómo queda?</legend>
        {[
          { v: false, t: "En borrador", d: "Nadie del público lo ve. El equipo ya puede entrar y preparar todo." },
          { v: true, t: "Publicado", d: "Verificado y con suscripción activa: aparece en el listado de clientes." },
        ].map((o) => (
          <label key={String(o.v)} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-foreground">
            <input type="radio" name="publicar" className="mt-0.5 size-5" checked={b.publicar === o.v} onChange={() => onPublicar(o.v)} />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{o.t}</span>
              <span className="text-xs text-muted-foreground">{o.d}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
