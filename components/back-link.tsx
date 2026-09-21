import Link from "next/link";
import { cn } from "@/lib/utils";

interface BackLinkProps {
  href: string;
  label?: string;
  className?: string;
}

export function BackLink({ href, label = "Volver", className }: BackLinkProps) {
  return (
    <Link
      href={href}
      className={cn(
        "absolute left-4 top-4 flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground sm:left-6 sm:top-6",
        className,
      )}
    >
      ← {label}
    </Link>
  );
}
