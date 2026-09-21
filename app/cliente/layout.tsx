import { ThemeNoche } from "@/components/theme-noche";

export default function ClienteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeNoche>{children}</ThemeNoche>;
}
