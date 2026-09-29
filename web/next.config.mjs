/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep visited pages in the browser's router cache briefly, so going back
  // to the list (or re-opening an issue) within 30s is instant.
  experimental: { staleTimes: { dynamic: 30, static: 180 } },
  // Personal tool: never let a search engine index it.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
