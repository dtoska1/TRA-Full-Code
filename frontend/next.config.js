/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NODE_ENV === "production" ? ".next" : ".next-dev",
  // Allow HMR websocket connections from LAN IPs in dev mode.
  allowedDevOrigins: process.env.LAN_ORIGIN ? [process.env.LAN_ORIGIN] : [],
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
    return [{ source: "/api/:path*", destination: `${apiBase}/api/:path*` }];
  },
};

module.exports = nextConfig;
