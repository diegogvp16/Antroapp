import type { NextConfig } from "next";

// Cabeceras de seguridad para todas las rutas. Permissions-Policy: la cámara
// solo para este sitio (escáner del QR en /staff/panel) y la ubicación solo
// para este sitio (antros cercanos en /cliente). No se pone una CSP completa
// todavía: primero en modo Report-Only, para no romper nada sin aviso.
const CABECERAS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), microphone=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR permite correr `next build` en otra carpeta sin pisar la
  // .next del servidor de desarrollo (ver CLAUDE.md, lecciones). En Vercel
  // no se define y queda la de siempre.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: CABECERAS }];
  },
};

export default nextConfig;
