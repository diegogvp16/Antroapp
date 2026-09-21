import { ThemeControl } from "@/components/theme-control";

export default function RecuperarContrasenaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeControl>{children}</ThemeControl>;
}
