import { ThemeControl } from "@/components/theme-control";

export default function DuenoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeControl>{children}</ThemeControl>;
}
