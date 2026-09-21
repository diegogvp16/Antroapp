"use client";

import { User, Ticket, CalendarClock, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

export type RpTab = "perfil" | "reservas" | "turnos" | "nomina";

interface BottomNavProps {
  active: RpTab;
  onChange: (tab: RpTab) => void;
}

const TABS: { id: RpTab; label: string; icon: typeof User }[] = [
  { id: "perfil", label: "Perfil", icon: User },
  { id: "reservas", label: "Reservas", icon: Ticket },
  { id: "turnos", label: "Turnos", icon: CalendarClock },
  { id: "nomina", label: "Nómina", icon: Wallet },
];

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
      aria-label="Navegación principal"
    >
      <div className="mx-auto flex w-full max-w-sm items-stretch justify-between px-2">
        {TABS.map(({ id, label, icon: Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 border-t-2 py-2.5 text-xs transition-colors",
                isActive
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent font-medium text-muted-foreground",
              )}
            >
              <Icon
                className={cn(
                  "transition-transform",
                  isActive ? "size-6 scale-110" : "size-5",
                )}
                strokeWidth={isActive ? 2.5 : 2}
              />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
