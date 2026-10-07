import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppNav from "@/components/AppNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "No Roll Models - Safer Bike Routing",
  description:
    "Bike routing that accounts for crash history, bike lane quality, and highway exposure - not just travel time.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/*
        h-full + overflow-hidden, not min-h-full. This is a fixed-viewport
        map app: the sidebar scrolls internally and the map fills the rest.
        With min-h-full the body is free to grow past the viewport, and a
        long sidebar pushed the 3D tour's transport bar below the fold.
      */}
      <body className="h-full overflow-hidden flex flex-col">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
