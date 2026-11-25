"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { boletosGuardados } from "@/lib/boletos-guardados";
import { boletosDelClub, type BoletoGuardado } from "@/lib/domain/boleto";
import { fechaLarga } from "@/lib/domain/compartir";

// "Ya apartaste lugar…" con enlace al boleto, si en este teléfono hay un
// boleto guardado para este antro y su noche no ha pasado. Se lee después de
// montar (localStorage no existe en el servidor) y si no hay nada no pinta.
export function AvisoBoletoGuardado({ clubId }: { clubId: string }) {
  const [boletos, setBoletos] = useState<BoletoGuardado[]>([]);

  useEffect(() => {
    setBoletos(boletosDelClub(boletosGuardados(), clubId));
  }, [clubId]);

  if (boletos.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-2" data-prueba="boleto-guardado">
      {boletos.map((b) => (
        <Link
          key={b.qr}
          href={`/r/${b.qr}`}
          className="flex min-h-12 items-center justify-between gap-3 rounded-md border border-noche-accent/40 bg-noche-accent/10 px-4 py-3 text-sm"
        >
          <span>
            Ya apartaste lugar para el <span className="font-semibold">{fechaLarga(b.fecha)}</span>
            {" · "}
            {b.personas} {b.personas === 1 ? "persona" : "personas"}
          </span>
          <span className="shrink-0 font-semibold text-noche-accent">Ver boleto →</span>
        </Link>
      ))}
    </div>
  );
}
