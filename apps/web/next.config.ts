import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Proxy API requests to gateway in development
  async rewrites() {
    const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4250";
    return [
      {
        source: "/api/:path*",
        destination: `${gateway}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
