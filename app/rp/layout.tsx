import { ThemeControl } from "@/components/theme-control";

export default function RpLayout({ children }: { children: React.ReactNode }) {
  return <ThemeControl>{children}</ThemeControl>;
}
