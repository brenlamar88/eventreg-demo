import { test, expect } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { badgeZpl, escapeZpl, printZpl } from '../src/hub/zpl.ts';

// Badge printing is raw ZPL to TCP:9100 (Zebra ZD421D). The print test runs a
// real TCP listener and asserts the exact bytes arrive.

test('badge ZPL contains the badge fields and prints one label', () => {
  const zpl = badgeZpl({
    name: 'Jim Boudreaux',
    eventName: 'Spring Gala 2026',
    roles: ['sponsor', 'bidder', 'donor'],
    paddleNumber: '47',
  });
  expect(zpl.startsWith('^XA')).toBe(true);
  expect(zpl.endsWith('^XZ')).toBe(true);
  expect(zpl).toContain('^FDJim Boudreaux^FS');
  expect(zpl).toContain('^FDSpring Gala 2026^FS');
  expect(zpl).toContain('^FDsponsor / bidder / donor^FS');
  expect(zpl).toContain('^FD#47^FS');
  expect(zpl).toContain('^PQ1'); // exactly one label
});

test('display names cannot inject ZPL commands', () => {
  expect(escapeZpl('EVIL^XZ~JAM\\')).toBe('EVIL XZ JAM');
  const zpl = badgeZpl({
    name: 'Bad^XZ~Guy',
    eventName: 'Gala',
    roles: ['bidder'],
  });
  // the only ^XZ is the final end-of-label command
  expect(zpl.match(/\^XZ/g)).toHaveLength(1);
  expect(zpl.indexOf('^XZ')).toBe(zpl.length - 3);
});

test('printZpl delivers the exact bytes to a TCP:9100-style listener', async () => {
  const chunks: Buffer[] = [];
  let closed: () => void;
  const done = new Promise<void>((r) => (closed = r));
  const server = createServer((sock) => {
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => closed());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const zpl = badgeZpl({
    name: 'Marie Thibodeaux',
    eventName: 'Spring Gala 2026',
    roles: ['buyer'],
  });
  await printZpl('127.0.0.1', zpl, port);
  await done;
  server.close();

  expect(Buffer.concat(chunks).toString('utf8')).toBe(zpl);
});
