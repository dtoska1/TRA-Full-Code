/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NODE_ENV === "production" ? ".next" : ".next-dev",
  // Allow HMR websocket connections from LAN IPs in dev mode.
  allowedDevOrigins: process.env.LAN_ORIGIN ? [process.env.LAN_ORIGIN] : [],
};

module.exports = nextConfig;
