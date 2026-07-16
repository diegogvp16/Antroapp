import Link from "next/link";

interface BackLinkProps {
  href: string;
  label?: string;
}

export function BackLink({ href, label = "Volver" }: BackLinkProps) {
  return (
    <Link
      href={href}
      className="absolute left-4 top-4 flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground sm:left-6 sm:top-6"
    >
      ← {label}
    </Link>
  );
}
