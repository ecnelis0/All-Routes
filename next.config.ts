import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js blocks cross-origin requests to dev resources by default, and
  // treats 127.0.0.1 as a different origin from localhost. Hitting the dev
  // server by IP - which scripts/renderTour.mjs and most local tooling
  // does - otherwise warns on every page load and blocks HMR.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
