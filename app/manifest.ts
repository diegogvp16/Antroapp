import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AntroApp",
    short_name: "AntroApp",
    description: "Reserva tu lugar en el antro en segundos.",
    start_url: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#9333ea",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
