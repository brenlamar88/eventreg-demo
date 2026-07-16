import './globals.css';
import type { ReactNode } from 'react';
import { getUser } from './lib/auth';
import { signOutAction } from './lib/auth-actions';

export const metadata = {
  title: 'V8 Event Platform — Operator Console',
  description: 'Sponsorships, bidding, and consignor settlement on one ledger.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getUser();
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="wrap">
            <span className="brand">
              <span className="v8">V8</span> Event Platform
            </span>
            <span className="crumbs">
              <a href="/">Home</a>
            </span>
            {user && (
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="muted" style={{ fontSize: 13 }}>{user.email}</span>
                <form action={signOutAction}>
                  <button className="ghost" type="submit">Sign out</button>
                </form>
              </span>
            )}
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
