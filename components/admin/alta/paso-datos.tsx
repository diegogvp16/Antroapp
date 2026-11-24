"use client";

import { Input } from "@/components/ui/input";
import { ZONAS_MEXICO } from "@/lib/domain/alta-club";
import { Campo, SELECT_CLASES, describir } from "./campo";
import type { Borrador } from "./estado";

type Datos = Borrador["datos"];

export function PasoDatos({
  datos,
  errores,
  onCambio,
}: {
  datos: Datos;
  errores: Record<string, string>;
  onCambio: (d: Datos) => void;
}) {
  const campo = (k: keyof Datos) => ({
    id: `alta-${k}`,
    value: datos[k],
    "aria-invalid": !!errores[`datos.${k}`] || undefined,
    "aria-describedby": describir(`alta-${k}`, errores[`datos.${k}`]),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onCambio({ ...datos, [k]: e.target.value }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Campo id="alta-nombre" etiqueta="Nombre del antro" error={errores["datos.nombre"]}>
        <Input {...campo("nombre")} className="h-10" autoComplete="off" maxLength={120} />
      </Campo>
      <Campo id="alta-direccion" etiqueta="Dirección" error={errores["datos.direccion"]}>
        <Input {...campo("direccion")} className="h-10" autoComplete="off" maxLength={300} placeholder="Calle, número, colonia" />
      </Campo>
      <div className="grid gap-4 sm:grid-cols-2">
        <Campo id="alta-ciudad" etiqueta="Ciudad" error={errores["datos.ciudad"]} ayuda="Se usa para agrupar antros en /grupo.">
          <Input {...campo("ciudad")} className="h-10" autoComplete="off" maxLength={80} placeholder="Guadalajara" />
        </Campo>
        <Campo id="alta-zona_horaria" etiqueta="Zona horaria" error={errores["datos.zona_horaria"]} ayuda="Define el corte de la noche (08:00 locales).">
          <select {...campo("zona_horaria")} className={SELECT_CLASES}>
            {ZONAS_MEXICO.map((z) => (
              <option key={z.valor} value={z.valor}>
                {z.etiqueta}
              </option>
            ))}
          </select>
        </Campo>
      </div>
      <Campo id="alta-horario" etiqueta="Horario" error={errores["datos.horario"]} ayuda="Como lo verá el cliente, por ejemplo: Jue a Sáb 10pm a 3am.">
        <Input {...campo("horario")} className="h-10" autoComplete="off" maxLength={120} />
      </Campo>
    </div>
  );
}
