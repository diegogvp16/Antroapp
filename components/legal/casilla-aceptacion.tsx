"use client";

// "Acepto los Términos y el Aviso de privacidad". Solo se muestra con la
// bandera NEXT_PUBLIC_LEGALES; el formulario decide si es obligatoria.
export function CasillaAceptacion({ id, marcada, onCambio }: { id: string; marcada: boolean; onCambio: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-snug">
      <input id={id} type="checkbox" className="mt-0.5 size-5 shrink-0" checked={marcada} onChange={(e) => onCambio(e.target.checked)} required />
      <span>
        Leí y acepto los{" "}
        <a href="/terminos" target="_blank" rel="noopener" className="underline underline-offset-4">
          Términos de uso
        </a>{" "}
        (incluida la política de reservas: el QR no garantiza la entrada) y el{" "}
        <a href="/privacidad" target="_blank" rel="noopener" className="underline underline-offset-4">
          Aviso de privacidad
        </a>
        .
      </span>
    </label>
  );
}
