import { ThemeControl } from "@/components/theme-control";
import { metadataApp } from "@/lib/app-instalable";

export const metadata = metadataApp("dueno", "Antro Dueño");

export default function DuenoLayout({ children }: { children: React.ReactNode }) {
  return <ThemeControl>{children}</ThemeControl>;
}
