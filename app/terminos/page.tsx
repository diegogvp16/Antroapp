import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { legalesActivos } from "@/lib/legal/version";
import { TEXTO_RESERVAS_QR, TEXTO_TERMINOS } from "@/lib/legal/textos";
import { TextoLegal } from "@/components/legal/texto-legal";
import { AvisoBorrador } from "@/components/legal/aviso-borrador";

// Detrás de NEXT_PUBLIC_LEGALES (apagada por defecto): sin la bandera, 404.
export const metadata: Metadata = { title: "Términos de uso · AntroApp" };

export default function TerminosPage() {
  if (!legalesActivos()) notFound();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 sm:px-8">
      <Link href="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← AntroApp
      </Link>
      <AvisoBorrador />
      <TextoLegal md={TEXTO_TERMINOS} />
      <hr className="border-border" />
      <TextoLegal md={TEXTO_RESERVAS_QR} id="reservas" />
      <p className="text-sm text-muted-foreground">
        Ver también el <Link href="/privacidad" className="underline underline-offset-4">Aviso de privacidad</Link>.
      </p>
    </main>
  );
}
