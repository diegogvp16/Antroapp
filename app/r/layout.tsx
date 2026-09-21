import { ThemeNoche } from "@/components/theme-noche";

export default function ReservaPublicaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeNoche>{children}</ThemeNoche>;
}
