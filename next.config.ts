import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR permite correr `next build` en otra carpeta sin pisar la
  // .next del servidor de desarrollo (ver CLAUDE.md, lecciones). En Vercel
  // no se define y queda la de siempre.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
