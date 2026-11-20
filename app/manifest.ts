import type { MetadataRoute } from "next";

// App del cliente (la de siempre). Las de trabajo tienen su propio manifest
// en public/ (staff, rp, dueno.webmanifest) y lo declara el layout de cada
// sección: así el teléfono las instala como apps aparte, cada una abriendo
// directo en su panel. Iconos: scripts/generar-iconos.mjs.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "AntroApp",
    short_name: "AntroApp",
    description: "Reserva tu lugar en el antro en segundos.",
    lang: "es-MX",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0a0a",
    theme_color: "#0b0a0a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
