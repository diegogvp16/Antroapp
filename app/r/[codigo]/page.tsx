"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { CoverModo, Reservation } from "@/types";
import { enlaceCompartir, fechaLarga, mensajeReserva } from "@/lib/domain/compartir";
import {
  TEXTO_ESTADO,
  esEstadoBoleto,
  estadoBoletoRespaldo,
  type EstadoBoleto,
} from "@/lib/domain/boleto";
import { textoCover } from "@/lib/cover";
import { nocheOperativaMexico } from "@/lib/fechas";
import { esErrorDeRed } from "@/lib/errores-base";
import { DatosBoleto, QrBoleto } from "@/components/boleto/datos-boleto";
import { EnLaPuerta } from "@/components/boleto/en-la-puerta";
import { CompartirBoleto } from "@/components/boleto/compartir-boleto";

// Lo que devuelve obtener_reserva_por_qr (sql/post-junta-2/40-boleto-estado.sql):
// solo lo que el boleto muestra. Deliberadamente sin teléfono, consumo ni
// ids. Las columnas desde estado_boleto son nuevas: con la función vieja no
// llegan, y por eso son opcionales (el estado cae al respaldo).
interface ReservaPublica {
  cliente_nombre: string;
  fecha: string;
  personas: number;
  status: Reservation["status"];
  qr_code: string;
  club_nombre: string | null;
  estado_boleto?: string | null;
  club_direccion?: string | null;
  cover_modo?: CoverModo | null;
  cover_monto?: number | null;
  tolerancia_hora?: string | null;
  edad_minima?: number | null;
  codigo_vestimenta?: string | null;
}

type Carga =
  | { fase: "cargando" }
  | { fase: "no_encontrada" }
  | { fase: "error" }
  | { fase: "lista"; reserva: ReservaPublica; estado: EstadoBoleto };

const CLASE_INSIGNIA: Record<EstadoBoleto, string> = {
  vigente: "border-noche-accent/50 bg-noche-accent/15 text-noche-accent",
  usado: "border-border bg-noche-surface-2 text-muted-foreground",
  vencido: "border-destructive/40 bg-destructive/10 text-destructive",
};

export default function ReservaPublicaPage() {
  const params = useParams<{ codigo: string }>();
  const codigo = decodeURIComponent(params.codigo ?? "");

  const [carga, setCarga] = useState<Carga>({ fase: "cargando" });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchReserva() {
      setCarga({ fase: "cargando" });
      try {
        const supabase = createClient();
        // Vía RPC y no lectura directa de `reservations`: la tabla está
        // cerrada para quien no tiene sesión, y esta función devuelve una
        // sola reserva, la del código exacto, sin permitir listar el resto.
        const { data, error } = await supabase
          .rpc("obtener_reserva_por_qr", { p_qr: codigo })
          .maybeSingle();

        if (cancelled) return;
        if (error) {
          console.error("Error cargando boleto:", error);
          setCarga({ fase: esErrorDeRed(error) ? "error" : "no_encontrada" });
          return;
        }
        if (!data) {
          setCarga({ fase: "no_encontrada" });
          return;
        }
        const reserva = data as ReservaPublica;
        const estado = esEstadoBoleto(reserva.estado_boleto)
          ? reserva.estado_boleto
          : estadoBoletoRespaldo(reserva, nocheOperativaMexico());
        setCarga({ fase: "lista", reserva, estado });
      } catch (err) {
        console.error("Error cargando boleto:", err);
        if (!cancelled) setCarga({ fase: "error" });
      }
    }

    if (codigo) {
      fetchReserva();
    } else {
      setCarga({ fase: "no_encontrada" });
    }

    return () => {
      cancelled = true;
    };
  }, [codigo, intento]);

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
      <BackLink href="/" label="Volver al inicio" />
      <Card className="w-full max-w-sm">
        {carga.fase === "cargando" ? (
          <CardContent className="px-6 py-10 text-center text-muted-foreground" role="status">
            Cargando boleto...
          </CardContent>
        ) : carga.fase === "error" ? (
          <>
            <CardHeader>
              <CardTitle>No pudimos cargar tu boleto</CardTitle>
              <CardDescription>
                Revisa la señal e intenta de nuevo. Tu lugar sigue apartado.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <Button
                type="button"
                size="lg"
                className="h-12 w-full text-base"
                onClick={() => setIntento((n) => n + 1)}
              >
                Intentar de nuevo
              </Button>
            </CardContent>
          </>
        ) : carga.fase === "no_encontrada" ? (
          <>
            <CardHeader>
              <CardTitle>Boleto no encontrado</CardTitle>
              <CardDescription>
                No hay ninguna reserva con este código. Revisa que el enlace
                esté completo, tal como te lo mandaron.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-6 pb-6">
              <Button
                render={<Link href="/cliente" />}
                nativeButton={false}
                variant="outline"
                className="h-11 w-full"
              >
                Ver antros disponibles
              </Button>
            </CardContent>
          </>
        ) : (
          <Boleto reserva={carga.reserva} estado={carga.estado} />
        )}
      </Card>
    </div>
  );
}

function Boleto({ reserva, estado }: { reserva: ReservaPublica; estado: EstadoBoleto }) {
  const textos = TEXTO_ESTADO[estado];
  const vigente = estado === "vigente";
  const cover =
    reserva.cover_modo != null
      ? textoCover({ cover_modo: reserva.cover_modo, cover_monto: reserva.cover_monto ?? null })
      : null;
  const enlace = typeof window === "undefined" ? "" : window.location.href.split("#")[0];
  const antro = reserva.club_nombre ?? "el antro";

  return (
    <>
      <CardHeader>
        <span
          className={`mb-2 inline-flex w-fit items-center rounded-md border px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${CLASE_INSIGNIA[estado]}`}
          data-prueba="estado-boleto"
          data-estado={estado}
        >
          {textos.etiqueta}
        </span>
        <CardTitle>{textos.titulo}</CardTitle>
        <CardDescription>
          {vigente ? `En ${antro}, el ${fechaLarga(reserva.fecha)}. ${textos.detalle}` : textos.detalle}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-6 px-6 pb-6">
        {/* El QR solo se muestra si todavía sirve: uno usado o vencido no
            debe parecer válido en la puerta. */}
        {vigente && <QrBoleto codigo={reserva.qr_code} tamano={220} />}

        <DatosBoleto
          antro={reserva.club_nombre}
          direccion={reserva.club_direccion}
          fecha={reserva.fecha}
          personas={reserva.personas}
          nombre={reserva.cliente_nombre}
        />

        {vigente && (
          <>
            <EnLaPuerta
              cover={cover}
              toleranciaHora={reserva.tolerancia_hora}
              edadMinima={reserva.edad_minima}
              codigoVestimenta={reserva.codigo_vestimenta}
            />
            {enlace && (
              <CompartirBoleto
                enlace={enlace}
                titulo={`Mi lugar en ${antro}`}
                mensajeWhatsApp={enlaceCompartir(
                  mensajeReserva({
                    quien: "cliente",
                    antro,
                    cliente: reserva.cliente_nombre,
                    fecha: reserva.fecha,
                    personas: reserva.personas,
                    enlace,
                    cover,
                  }),
                )}
              />
            )}
          </>
        )}

        <div className="w-full border-t border-border pt-6 text-center">
          <p className="text-sm text-muted-foreground">
            {vigente
              ? "¿No conoces un RP? Explora los antros disponibles en AntroApp"
              : "Aparta tu próxima noche en AntroApp"}
          </p>
          <Button
            render={<Link href="/cliente" />}
            nativeButton={false}
            variant="outline"
            className="mt-3 h-11 w-full"
          >
            Ver antros disponibles
          </Button>
        </div>
      </CardContent>
    </>
  );
}
