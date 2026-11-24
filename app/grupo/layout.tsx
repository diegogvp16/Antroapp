import { ThemeControl } from "@/components/theme-control";

export default function GrupoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeControl>{children}</ThemeControl>;
}
