"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { textoCover } from "@/lib/cover";
import { OPCIONES_VISIBILIDAD, describirRegla } from "@/lib/domain/config-rp";
import { ETIQUETA_ROL, NO_SE_COPIA_CLON, PERMISOS_CAJA_ALTA, ROLES_PERSONAL, ZONAS_MEXICO, esquemaRp } from "@/lib/domain/alta-club";
import { aEntrada, PASO, type Borrador } from "./estado";
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
  const rp = esquemaRp.safeParse(e.rp);
  const pesos = (c: number) =>
    new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: c % 100 === 0 ? 0 : 2 }).format(c / 100);
  const pago = !rp.success
    ? "Falta completar"
    : rp.data.modo_pago === "reserva" && rp.data.regla
      ? `Por reserva: ${describirRegla(rp.data.regla)}`
      : `Por día: ${rp.data.tarifas_dia.map((c, i) => `día ${i + 1} ${pesos(c)}`).join(", ")}`;
  // Lo del otro modo que también se guarda (completo): clon o un cambio de modo a medias.
  const tambien = !rp.success
    ? null
    : rp.data.modo_pago === "dia" && rp.data.regla
      ? `Regla por reserva: ${describirRegla(rp.data.regla)}`
      : rp.data.modo_pago === "reserva" && rp.data.tarifas_dia.length > 0
        ? `Tarifas por día: ${rp.data.tarifas_dia.map((c, i) => `día ${i + 1} ${pesos(c)}`).join(", ")}`
        : null;
  const visibilidad = OPCIONES_VISIBILIDAD.find((o) => o.valor === b.rp.visibilidad)?.titulo ?? "—";
  const cambiosCaja = e.caja_permisos ?? [];
  const tituloPermiso = (permiso: string) => PERMISOS_CAJA_ALTA.find((x) => x.permiso === permiso)?.titulo ?? permiso;
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

  const clon = b.clon;
  const productos = clon?.productos;

  return (
    <div className="flex flex-col gap-4">
      {clon && (
        <section className="flex flex-col border-b border-border pb-3" aria-label="Clon">
          <h3 className="py-2 text-sm font-semibold">Clon</h3>
          <dl>
            <Fila etiqueta="Sale de">{clon.origen.nombre}</Fila>
            <Fila etiqueta="Catálogo">
              {productos == null
                ? "Sin catálogo de productos"
                : productos.total === 0
                  ? "El origen no tiene productos"
                  : `Se copian ${productos.total} productos (${productos.activos} activos), con existencias en 0`}
            </Fila>
            <Fila etiqueta="No se copia">{NO_SE_COPIA_CLON.join(" · ")}</Fila>
          </dl>
        </section>
      )}
      <Seccion titulo="Datos" onEditar={() => onIrA(PASO.datos)}>
        <Fila etiqueta="Nombre">{b.datos.nombre.trim()}</Fila>
        <Fila etiqueta="Dirección">{b.datos.direccion.trim()}</Fila>
        <Fila etiqueta="Ciudad">{b.datos.ciudad.trim()}</Fila>
        <Fila etiqueta="Zona horaria">{zona}</Fila>
        <Fila etiqueta="Horario">{b.datos.horario.trim()}</Fila>
      </Seccion>
      <Seccion titulo="Cover y políticas" onEditar={() => onIrA(PASO.politicas)}>
        <Fila etiqueta="Cover">{cover}</Fila>
        <Fila etiqueta="Depósito">{p.deposito_monto ? `$${Number(p.deposito_monto).toLocaleString("es-MX")} (informativo)` : "Sin depósito"}</Fila>
        <Fila etiqueta="Edad mínima">{p.edad_minima ?? "—"}</Fila>
        <Fila etiqueta="Vestimenta">{p.codigo_vestimenta || "—"}</Fila>
        <Fila etiqueta="Música">{p.tipo_musica || "—"}</Fila>
        <Fila etiqueta="Llegada hasta">{p.tolerancia_hora ?? "Sin límite"}</Fila>
      </Seccion>
      <Seccion titulo="Mesas" onEditar={() => onIrA(PASO.mesas)}>
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
      <Seccion titulo="Reglas de comisión y RPs" onEditar={() => onIrA(PASO.reglas)}>
        <Fila etiqueta="Pago a RPs">{pago}</Fila>
        {tambien && (
          <Fila etiqueta="También se guarda">
            {tambien}
            <span className="block text-xs text-muted-foreground">No se usa hoy: queda lista por si el antro cambia de modo de pago.</span>
          </Fila>
        )}
        <Fila etiqueta="Qué ven los RPs">{visibilidad}</Fila>
        <Fila etiqueta="Permisos de caja">
          {cambiosCaja.length === 0
            ? "Los de la plataforma"
            : cambiosCaja.map((c) => `${c.rol === "staff" ? "Staff" : "Gerente"} ${c.permitido ? "sí" : "no"}: ${tituloPermiso(c.permiso)}`).join(" · ")}
        </Fila>
      </Seccion>
      <Seccion titulo="Equipo" onEditar={() => onIrA(PASO.equipo)}>
        <Fila etiqueta="Dueño">{b.conDueno ? `${b.dueno.nombre.trim()} (${b.dueno.correo.trim().toLowerCase()})` : "Sin dueño por ahora"}</Fila>
        {ROLES_PERSONAL.map((r) => (
          <Fila key={r} etiqueta={ETIQUETA_ROL[r]}>
            {b.personal.filter((x) => x.rol === r).length}
          </Fila>
        ))}
      </Seccion>
      <Seccion titulo="Grupo" onEditar={() => onIrA(PASO.grupo)}>
        <Fila etiqueta="Grupo">{grupoTexto}</Fila>
        {duenoGrupo && <Fila etiqueta="Dueño del grupo">{duenoGrupo}</Fila>}
        {b.grupo.modo === "existente" && (
          <Fila etiqueta="Configuración">
            {b.grupo.config === "grupo"
              ? "La del grupo: reemplaza lo de los pasos anteriores en lo que el grupo define"
              : "La de este alta (menos lo que el grupo bloqueó)"}
          </Fila>
        )}
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
