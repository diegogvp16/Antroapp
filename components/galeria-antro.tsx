"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ClubPhoto } from "@/types";

interface GaleriaAntroProps {
  photos: ClubPhoto[];
  nombre: string;
}

// Carrusel de una foto a la vez. El desplazamiento real lo hace el scroll
// nativo con scroll-snap (así el swipe táctil se siente como el del sistema);
// las flechas y los puntos solo hacen scrollTo al slide que toca, y el índice
// se lee de vuelta del scroll para que ambos caminos queden sincronizados.
export function GaleriaAntro({ photos, nombre }: GaleriaAntroProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const total = photos.length;
  const hayVarias = total > 1;

  function irA(nuevo: number) {
    const track = trackRef.current;
    if (!track) return;
    const destino = Math.max(0, Math.min(total - 1, nuevo));
    track.scrollTo({ left: destino * track.clientWidth, behavior: "smooth" });
    setIndex(destino);
  }

  function handleScroll() {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return;
    const actual = Math.round(track.scrollLeft / track.clientWidth);
    setIndex(Math.max(0, Math.min(total - 1, actual)));
  }

  return (
    <div className="relative w-full">
      <div
        ref={trackRef}
        onScroll={handleScroll}
        className="no-scrollbar flex h-[26rem] w-full snap-x snap-mandatory overflow-x-auto"
      >
        {photos.map((photo, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={photo.id}
            src={photo.url}
            alt={`${nombre}, foto ${i + 1} de ${total}`}
            className="h-full w-full flex-shrink-0 snap-center object-cover"
          />
        ))}
      </div>

      {hayVarias && (
        <>
          <button
            type="button"
            onClick={() => irA(index - 1)}
            disabled={index === 0}
            aria-label="Foto anterior"
            className={cn(
              "absolute left-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-sm",
              "border border-noche-accent/45 bg-noche-bg/70 text-noche-accent backdrop-blur",
              "transition-opacity hover:bg-noche-bg/85 disabled:pointer-events-none disabled:opacity-0",
            )}
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => irA(index + 1)}
            disabled={index === total - 1}
            aria-label="Foto siguiente"
            className={cn(
              "absolute right-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-sm",
              "border border-noche-accent/45 bg-noche-bg/70 text-noche-accent backdrop-blur",
              "transition-opacity hover:bg-noche-bg/85 disabled:pointer-events-none disabled:opacity-0",
            )}
          >
            <ChevronRight className="size-5" />
          </button>

          <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
            {photos.map((photo, i) => (
              <button
                key={photo.id}
                type="button"
                onClick={() => irA(i)}
                aria-label={`Ir a la foto ${i + 1}`}
                aria-current={i === index ? "true" : undefined}
                className={cn(
                  "h-1 rounded-sm transition-all",
                  i === index
                    ? "w-6 bg-noche-accent"
                    : "w-2.5 bg-noche-text/45 hover:bg-noche-text/70",
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
