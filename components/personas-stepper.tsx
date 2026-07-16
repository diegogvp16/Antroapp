"use client";

import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export const MIN_PERSONAS = 1;
export const MAX_PERSONAS = 20;

interface PersonasStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label?: string;
}

export function PersonasStepper({
  value,
  onChange,
  min = MIN_PERSONAS,
  max = MAX_PERSONAS,
  label = "Número de personas",
}: PersonasStepperProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label id="personas-label">{label}</Label>
      <div
        className="flex items-center justify-between rounded-lg border border-input px-2 py-1"
        role="group"
        aria-labelledby="personas-label"
      >
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Quitar una persona"
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          <Minus />
        </Button>
        <span
          className="min-w-10 text-center text-lg font-semibold tabular-nums"
          aria-live="polite"
        >
          {value}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Agregar una persona"
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + 1))}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}
