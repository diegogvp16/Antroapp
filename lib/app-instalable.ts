import type { Metadata } from "next";

// Metadatos de una app de trabajo instalable (Staff, RP, Dueño): su manifest
// (public/<clave>.webmanifest) y su icono y nombre en iPhone. El layout de la
// sección los exporta; reemplazan a los del cliente (public/manifest.webmanifest,
// declarado en app/layout.tsx).
export function metadataApp(clave: "staff" | "rp" | "dueno", nombre: string): Metadata {
  return {
    manifest: `/${clave}.webmanifest`,
    appleWebApp: { capable: true, statusBarStyle: "black", title: nombre },
    icons: {
      icon: [
        { url: `/iconos/${clave}-192.png`, sizes: "192x192", type: "image/png" },
        { url: `/iconos/${clave}-512.png`, sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: `/iconos/${clave}-apple-180.png`, sizes: "180x180", type: "image/png" }],
    },
  };
}
