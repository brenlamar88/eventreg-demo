import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'V8 Event Platform — Operator Console',
  description: 'Sponsorships, bidding, and consignor settlement on one ledger.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="wrap">
            <span className="brand">
              <span className="v8">V8</span> Event Platform
            </span>
            <span className="crumbs">
              <a href="/orgs">Operators</a>
            </span>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
