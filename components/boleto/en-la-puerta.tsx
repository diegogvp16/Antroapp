import { AVISO_ACCESO, avisoCover, renglonesPuerta } from "@/lib/domain/boleto";

// Lo que el cliente necesita saber antes de llegar: cover (informativo),
// hora límite, edad y vestimenta, y que el QR no garantiza la entrada.
// Se usa en la confirmación de la reserva y en el boleto público.
// `cover` es el texto de textoCover y `coverModo` el modo del antro: el aviso
// "lo cobra el antro" solo sale en modo "monto" (con "libre" no hay cover).
export function EnLaPuerta({
  cover,
  coverModo,
  toleranciaHora,
  edadMinima,
  codigoVestimenta,
}: {
  cover: string | null;
  coverModo: string | null | undefined;
  toleranciaHora?: string | null;
  edadMinima?: number | null;
  codigoVestimenta?: string | null;
}) {
  const filas = renglonesPuerta({
    cover,
    tolerancia_hora: toleranciaHora,
    edad_minima: edadMinima,
    codigo_vestimenta: codigoVestimenta,
  });
  const aviso = cover ? avisoCover(coverModo) : null;

  return (
    <section aria-labelledby="en-la-puerta" className="flex w-full flex-col gap-3">
      <h2 id="en-la-puerta" className="text-xl">
        En la puerta
      </h2>
      {filas.length > 0 && (
        <dl className="flex flex-col border-b border-border text-sm">
          {filas.map((f) => (
            <div key={f.etiqueta} className="grid grid-cols-[7rem_1fr] gap-3 border-t border-border py-2.5">
              <dt className="text-muted-foreground">{f.etiqueta}</dt>
              <dd className="font-medium">{f.valor}</dd>
            </div>
          ))}
        </dl>
      )}
      {aviso && (
        <p className="text-xs leading-relaxed text-muted-foreground" data-prueba="aviso-cover">
          {aviso}
        </p>
      )}
      <p className="rounded-md border border-noche-accent/30 bg-noche-accent/10 px-3 py-2.5 text-xs leading-relaxed text-foreground">
        <span className="font-semibold text-noche-accent">El QR no garantiza el acceso.</span>{" "}
        {AVISO_ACCESO}
      </p>
    </section>
  );
}
