import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe webhook signature verification, implemented to Stripe's actual scheme so
// an unsigned or tampered body is rejected before it can reach the ledger.
//
// Header format: "t=<unix_ts>,v1=<hex_sig>[,v1=<hex_sig>...]"
// Signed payload: "<t>.<raw_body>"
// Signature:      HMAC-SHA256(secret, signed_payload), hex.

export interface ConstructEventOpts {
  payload: string; // the raw request body, byte-for-byte
  signatureHeader: string; // the Stripe-Signature header
  secret: string; // the endpoint signing secret (whsec_...)
  toleranceSeconds?: number; // reject timestamps older than this (default 300)
  nowMs?: number; // injectable clock for tests
}

export class StripeSignatureError extends Error {}

export function signPayload(payload: string, secret: string, timestampSec: number): string {
  const sig = createHmac('sha256', secret).update(`${timestampSec}.${payload}`).digest('hex');
  return `t=${timestampSec},v1=${sig}`;
}

function parseHeader(header: string): { t: number | null; v1: string[] } {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key === 't') t = Number(val);
    else if (key === 'v1') v1.push(val);
  }
  return { t, v1 };
}

function hexEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function constructEvent(opts: ConstructEventOpts): any {
  const { payload, signatureHeader, secret } = opts;
  const tolerance = opts.toleranceSeconds ?? 300;
  const nowMs = opts.nowMs ?? Date.now();

  const { t, v1 } = parseHeader(signatureHeader);
  if (t === null || Number.isNaN(t) || v1.length === 0) {
    throw new StripeSignatureError('missing or malformed signature header (need t and v1)');
  }

  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const matched = v1.some((candidate) => hexEq(candidate, expected));
  if (!matched) {
    throw new StripeSignatureError('signature verification failed');
  }

  // Replay defense: only enforced after the signature matches, so we trust `t`.
  const ageSec = Math.abs(Math.floor(nowMs / 1000) - t);
  if (ageSec > tolerance) {
    throw new StripeSignatureError(`timestamp outside tolerance (${ageSec}s > ${tolerance}s)`);
  }

  return JSON.parse(payload);
}
