import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Network Monitor",
  description: "Real-time network monitoring with ping statistics and speedtest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased" style={{ fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", "Monaco", "Inconsolata", "Roboto Mono", "Source Code Pro", "Consolas", monospace' }}>
        {children}
      </body>
    </html>
  );
}
