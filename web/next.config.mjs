/** @type {import('next').NextConfig} */
const nextConfig = {
  // Personal tool: never let a search engine index it.
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
