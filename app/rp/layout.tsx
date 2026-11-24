import { ThemeControl } from "@/components/theme-control";
import { metadataApp } from "@/lib/app-instalable";

export const metadata = metadataApp("rp", "Antro RP");

export default function RpLayout({ children }: { children: React.ReactNode }) {
  return <ThemeControl>{children}</ThemeControl>;
}
