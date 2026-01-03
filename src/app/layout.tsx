import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TAN Picking",
  description: "Picking opvolging",
  manifest: "/manifest.webmanifest",
  themeColor: "#0b0b0b",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
