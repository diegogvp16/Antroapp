"use client";

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useFunciones } from "@/lib/funciones";
import {
  AVISO_ENLACE_WA,
  INFO_PLANTILLA,
  datosDeReserva,
  enlaceWa,
  esTipoPlantilla,
  plantillaEfectiva,
  renderPlantilla,
  tiposParaEstado,
  type TipoPlantilla,
} from "@/lib/domain/whatsapp";

// Mensajes de WhatsApp de UNA reserva del RP (bandera 'whatsapp'): según el
// estado, confirmación y recordatorio (por llegar) o aviso de no-show (no
// llegó), con los textos del antro. Los datos salen de whatsapp_reserva, que
// solo responde por las reservas del propio RP. Nada se envía solo.

type Datos = { cliente_nombre: string; cliente_telefono: string | null; fecha: string; personas: number; qr_code: string; antro: string; horario: string | null; estado: string };

export function MensajesReservaRp({ reservaId, estado }: { reservaId: string; estado: string }) {
  const [clubId, setClubId] = useState<string | null>(null);
  const [datos, setDatos] = useState<Datos | null>(null);
  const [propias, setPropias] = useState<Partial<Record<TipoPlantilla, string>>>({});
  const f = useFunciones(clubId);
  const activa = f.activa("whatsapp");
  const tipos = tiposParaEstado(estado);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase.from("profiles").select("club_id").eq("id", user.id).maybeSingle();
      setClubId(data?.club_id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!activa || !clubId || tipos.length === 0) return;
    let vivo = true;
    const supabase = createClient();
    Promise.all([supabase.rpc("whatsapp_reserva", { p_reserva_id: reservaId }), supabase.rpc("whatsapp_plantillas", { p_club: clubId })]).then(
      ([r, p]) => {
        if (!vivo) return;
        if (!r.error && r.data) setDatos(r.data as Datos);
        const m: Partial<Record<TipoPlantilla, string>> = {};
        for (const x of (p.data ?? []) as { tipo: string; texto: string }[]) if (esTipoPlantilla(x.tipo)) m[x.tipo] = x.texto;
        setPropias(m);
      },
    );
    return () => {
      vivo = false;
    };
  }, [activa, clubId, reservaId, tipos.length]);

  if (!activa || tipos.length === 0 || !datos) return null;
  const d = datosDeReserva({ ...datos, origen: window.location.origin });
  return (
    <section className="mt-3 flex flex-col gap-2">
      <h3 className="text-sm font-medium">Mensajes</h3>
      <div className="flex flex-wrap gap-2">
        {tipos.map((t) => {
          const e = enlaceWa(datos.cliente_telefono, renderPlantilla(plantillaEfectiva(t, propias), d));
          return (
            <a
              key={t}
              href={e.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-caja-borde bg-caja-superficie px-3 text-sm"
            >
              <MessageCircle className="size-4" aria-hidden="true" />
              {INFO_PLANTILLA[t].nombre}
              {!e.directo && <span className="text-xs text-caja-secundario">(sin teléfono)</span>}
            </a>
          );
        })}
      </div>
      <p className="text-xs text-caja-secundario">{AVISO_ENLACE_WA}</p>
    </section>
  );
}
