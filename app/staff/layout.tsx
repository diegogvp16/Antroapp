import { ThemeControl } from "@/components/theme-control";
import { metadataApp } from "@/lib/app-instalable";

export const metadata = metadataApp("staff", "Antro Staff");

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return <ThemeControl>{children}</ThemeControl>;
}
