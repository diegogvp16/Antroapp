// Manda un error al aviso de errores (/api/errores). Nunca lanza: si el
// aviso falla, la pantalla de error se sigue mostrando.
export function reportarError(error: Error & { digest?: string }) {
  try {
    void fetch("/api/errores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mensaje: `${error.name}: ${error.message}`.slice(0, 1000),
        digest: error.digest ?? null,
        ruta: typeof window !== "undefined" ? window.location.pathname : null,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Sin aviso; no hay nada más que hacer.
  }
}
