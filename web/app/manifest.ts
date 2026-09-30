import type { MetadataRoute } from "next";

// "Add to Home Screen" on phones: the app name, colours and icon.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "IPO Copilot",
    short_name: "IPO Copilot",
    description: "Mainboard IPO alerts: GMP, subscription and the numbers that matter, delivered to you.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
