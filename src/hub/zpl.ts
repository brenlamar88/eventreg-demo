import { createConnection } from 'node:net';

// Badge printing for the Zebra ZD421D: render ZPL II and write the raw bytes to
// the printer's TCP port 9100. No driver, no spooler — the venue hub talks
// straight to the printer on the LAN.

// ZPL treats ^ and ~ as command prefixes anywhere in field data. Strip them and
// control characters so a display name can't inject printer commands, and clamp
// length so a novel-length name can't walk off the label.
export function escapeZpl(s: string, maxLen = 40): string {
  return s
    .replace(/[\^~\\]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export interface Badge {
  name: string;
  eventName: string;
  roles: string[]; // e.g. ['sponsor', 'bidder']
  paddleNumber?: string;
}

// A 4x2in-ish badge at 203dpi (the ZD421D default): name large, event under it,
// roles as a chip line, optional paddle number big in the corner.
export function badgeZpl(b: Badge): string {
  const name = escapeZpl(b.name, 28);
  const event = escapeZpl(b.eventName, 36);
  const roles = escapeZpl(b.roles.join(' / '), 40);
  const paddle = b.paddleNumber ? escapeZpl(b.paddleNumber, 6) : null;
  const lines = [
    '^XA',
    '^CI28', // UTF-8
    '^PW812', // 4in @ 203dpi
    '^LL406', // 2in
    `^FO40,60^A0N,70,70^FD${name}^FS`,
    `^FO40,150^A0N,35,35^FD${event}^FS`,
    `^FO40,210^A0N,28,28^FD${roles}^FS`,
  ];
  if (paddle) lines.push(`^FO600,60^A0N,90,90^FD#${paddle}^FS`);
  lines.push('^PQ1', '^XZ');
  return lines.join('\n');
}

// Write raw ZPL to host:9100 and resolve once the socket has flushed and closed.
export function printZpl(host: string, zpl: string, port = 9100, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`printer ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('connect', () => {
      socket.end(zpl); // write + FIN; the ZD421D prints on receipt
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function printBadge(host: string, badge: Badge, port = 9100): Promise<void> {
  await printZpl(host, badgeZpl(badge), port);
}
