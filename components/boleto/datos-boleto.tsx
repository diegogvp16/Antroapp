import { QRCodeSVG } from "qrcode.react";
import { fechaLarga } from "@/lib/domain/compartir";

// El QR sobre blanco (los escáneres lo necesitan con contraste real) y los
// datos del boleto: antro y dirección, noche, personas y a nombre de quién.
export function QrBoleto({ codigo, tamano = 210 }: { codigo: string; tamano?: number }) {
  return (
    <div className="rounded-md bg-white p-4 shadow-[0_0_0_6px_rgb(242_239_233/0.08)]" data-prueba="qr-boleto">
      {/* marginSize: con el p-4 suman ~4 módulos de blanco alrededor, lo que pide
          el estándar; con menos, algunos escáneres (y el de las pruebas) fallan
          porque alrededor del recuadro el fondo es oscuro. */}
      <QRCodeSVG value={codigo} size={tamano} marginSize={2} />
    </div>
  );
}

function mayuscula(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

export function DatosBoleto({
  antro,
  direccion,
  fecha,
  personas,
  nombre,
}: {
  antro: string | null;
  direccion?: string | null;
  fecha: string;
  personas: number;
  nombre: string;
}) {
  return (
    <dl className="flex w-full flex-col border-y border-dashed border-border text-sm">
      <div className="grid grid-cols-[7rem_1fr] gap-3 py-2.5">
        <dt className="text-muted-foreground">Antro</dt>
        <dd>
          <span className="font-medium">{antro ?? "El antro"}</span>
          {direccion && <span className="block text-muted-foreground">{direccion}</span>}
        </dd>
      </div>
      <div className="grid grid-cols-[7rem_1fr] gap-3 border-t border-border py-2.5">
        <dt className="text-muted-foreground">Noche</dt>
        <dd className="font-medium">{mayuscula(fechaLarga(fecha))}</dd>
      </div>
      <div className="grid grid-cols-[7rem_1fr] gap-3 border-t border-border py-2.5">
        <dt className="text-muted-foreground">Personas</dt>
        <dd className="font-medium">{personas}</dd>
      </div>
      <div className="grid grid-cols-[7rem_1fr] gap-3 border-t border-border py-2.5">
        <dt className="text-muted-foreground">A nombre de</dt>
        <dd className="font-medium break-words">{nombre}</dd>
      </div>
    </dl>
  );
}
