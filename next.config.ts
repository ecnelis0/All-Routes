import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev-tools badge sits bottom-left - exactly over the
  // sidebar's bottom buttons (Rename, Start navigation, Save...). A real
  // click on "Rename" opened the badge's menu instead. Build errors still
  // show as the full-screen overlay; only the badge goes.
  devIndicators: false,
  // Next.js blocks cross-origin requests to dev resources by default, and
  // treats 127.0.0.1 as a different origin from localhost. Hitting the dev
  // server by IP - which scripts/renderTour.mjs and most local tooling
  // does - otherwise warns on every page load and blocks HMR.
  //
  // The tunnel domains are for testing live GPS on a phone: geolocation
  // only works on https, and a tunnel is the simplest way to give the dev
  // server a trusted https URL (see README "Testing GPS on a phone").
  allowedDevOrigins: ["127.0.0.1", "*.trycloudflare.com", "*.ngrok-free.app"],
};

export default nextConfig;
