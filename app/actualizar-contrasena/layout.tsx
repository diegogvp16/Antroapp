import { ThemeControl } from "@/components/theme-control";

export default function ActualizarContrasenaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeControl>{children}</ThemeControl>;
}
