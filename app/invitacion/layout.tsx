import type { Metadata } from "next";
import { ThemeControl } from "@/components/theme-control";

// El token va en la ruta: que no viaje en el Referer a otros sitios ni la
// indexe un buscador.
export const metadata: Metadata = {
  title: "Invitación — AntroApp",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InvitacionLayout({ children }: { children: React.ReactNode }) {
  return <ThemeControl>{children}</ThemeControl>;
}
