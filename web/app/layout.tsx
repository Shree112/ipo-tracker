import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

// Display serif for page titles and big numbers - the one typographic flourish
// in an otherwise quiet interface. Instrument Serif, SIL Open Font License.
const serif = localFont({
  src: [
    { path: "./fonts/instrument-serif-latin-400-normal.woff2", style: "normal", weight: "400" },
    { path: "./fonts/instrument-serif-latin-400-italic.woff2", style: "italic", weight: "400" },
  ],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "IPO Copilot", template: "%s · IPO Copilot" },
  description: "Set your rules once. Get one email when an Indian mainboard IPO is worth a look.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

// Dark is the default. A saved choice ("light") is applied before first paint
// so the page never flashes the wrong theme.
const themeScript = `try{var t=localStorage.getItem('ipo-theme');if(t==='light'){document.documentElement.dataset.theme='light'}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${GeistSans.variable} ${GeistMono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
