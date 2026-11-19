"use client";

import { useEffect } from "react";
import { reportarError } from "@/lib/reportar-error";

// Último recurso: falla el layout raíz. No hay tema ni componentes, así que
// el estilo va en línea y en colores neutros.
export default function ErrorGlobal({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportarError(error);
  }, [error]);

  return (
    <html lang="es">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f6f6f4", color: "#111" }}>
        <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Algo salió mal</h1>
          <p style={{ maxWidth: 360, fontSize: 14, color: "#555", margin: 0 }}>
            Ya nos llegó el aviso. Intenta de nuevo; si sigue pasando, cierra la app y vuelve a abrirla.
          </p>
          <button type="button" onClick={reset} style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid #111", background: "#111", color: "#fff", fontSize: 14 }}>
            Reintentar
          </button>
        </main>
      </body>
    </html>
  );
}
