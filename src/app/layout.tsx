import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/Sidebar";
import PortfolioLayoutApplier from './PortfolioLayoutApplier';
import { Suspense } from 'react';
import ThemeApplier from '@/components/ThemeApplier';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HoldingsHub",
  description: "Multi-portfolio tracker with live prices, FX conversion and per-portfolio breakdown.",
  icons: { icon: "/favicon.ico" },
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_ORIGIN ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'http://localhost:3000'
  ),
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // If we can determine the theme server-side, set it on <html> so Safari/iOS
  // renders the correct background immediately (no dependence on client hydration).
  // Falls back gracefully to system theme when unknown.
  // Note: settings are stored in settings.portfolio_prefs for now.
  const getServerTheme = async () => {
    try {
      const supabase = await getSupabaseServerClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return null;

      const { data } = await supabase
        .from('settings')
        .select('portfolio_prefs')
        .eq('id', 'global')
        .single();

      const t = (data as any)?.portfolio_prefs?.theme;
      if (t === 'system' || t === 'light' || t === 'dark') return t as 'system' | 'light' | 'dark';
      return 'system';
    } catch {
      return null;
    }
  };

  const serverTheme = await getServerTheme();
  return (
    <html lang="en" data-theme={serverTheme ?? undefined}>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Suspense fallback={null}>
          <ThemeApplier />
        </Suspense>
        <div className="flex h-screen">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
        {/* Must be mounted for order/hide to apply on the dashboard */}
        <Suspense fallback={null}>
          <PortfolioLayoutApplier />
        </Suspense>
      </body>
    </html>
  );
}
