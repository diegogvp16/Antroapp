"use client";

import { Suspense } from "react";
import { ReportesPdf } from "@/components/reportes/reportes-pdf";

// Reportes PDF del dueño (noche y semana). La lógica vive en
// components/reportes/reportes-pdf.tsx; detrás de la bandera 'reportes_pdf'.
export default function ReportesPdfPage() {
  return (
    <Suspense fallback={null}>
      <ReportesPdf />
    </Suspense>
  );
}
