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
        // 40 px de alto para el dedo (antes 20); el texto queda donde estaba.
        "absolute left-2 top-2 flex min-h-10 items-center gap-1 px-2 text-sm font-medium text-muted-foreground hover:text-foreground sm:left-4 sm:top-4",
        className,
      )}
    >
      ← {label}
    </Link>
  );
}
