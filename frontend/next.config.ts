import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep development output separate from a production build run through Compose.
  distDir: process.env.NODE_ENV === "production" ? ".next-production" : ".next",
};

export default nextConfig;


