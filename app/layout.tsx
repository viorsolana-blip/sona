import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sona — Solana Liquidity Marketplace",
  description: "A marketplace for verified Raydium CPMM Fee Keys on Solana.",
  icons: {
    icon: "/assets/sona-symbol.png",
    shortcut: "/assets/sona-symbol.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
