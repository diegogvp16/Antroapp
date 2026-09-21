import { ThemeControl } from "@/components/theme-control";

export default function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ThemeControl>{children}</ThemeControl>;
}
