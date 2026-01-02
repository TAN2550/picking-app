import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TAN Picking",
  description: "Picking opvolging",
  manifest: "/manifest.webmanifest",
  themeColor: "#0b0b0b",
  icons: {
    icon: [
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <head>
        {/* iPhone/iPad "Add to Home Screen" */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="TAN Picking" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />

        {/* PWA */}
        <link rel="manifest" href="/manifest.webmanifest" />

        {/* Extra favicons */}
        <link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png" />
        <link rel="icon" href="/icons/favicon-16.png" sizes="16x16" type="image/png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
