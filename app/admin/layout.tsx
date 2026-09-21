import { ThemeControl } from "@/components/theme-control";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeControl>{children}</ThemeControl>;
}
