import { ThemeControl } from "@/components/theme-control";

export default function CambiarContrasenaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeControl>{children}</ThemeControl>;
}
