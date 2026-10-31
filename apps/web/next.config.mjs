const backend = process.env.API_ORIGIN ?? "http://localhost:3000";

const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${backend}/api/auth/:path*` },
      { source: "/api/v1/:path*", destination: `${backend}/api/v1/:path*` },
    ];
  },
};

export default nextConfig;
