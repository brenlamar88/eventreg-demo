import { test, expect, describe } from 'vitest';
import { constructEvent, signPayload } from '../src/stripe/webhook.ts';

// Real Stripe signature scheme: HMAC-SHA256 over "{timestamp}.{payload}" with the
// endpoint signing secret, header "t=<ts>,v1=<hex>", constant-time compared, with
// a timestamp tolerance to defeat replay. Verified BEFORE anything touches the
// ledger.
const SECRET = 'whsec_test_secret';
const NOW = 1_700_000_000_000; // fixed ms clock for deterministic timestamp checks
const NOW_SEC = Math.floor(NOW / 1000);

function body(id = 'evt_1'): string {
  return JSON.stringify({ id, type: 'payment_intent.succeeded', data: { object: {} } });
}

describe('stripe webhook signature verification', () => {
  test('accepts a correctly signed payload', () => {
    const payload = body();
    const header = signPayload(payload, SECRET, NOW_SEC);
    const event = constructEvent({ payload, signatureHeader: header, secret: SECRET, nowMs: NOW });
    expect(event.id).toBe('evt_1');
  });

  test('rejects a tampered payload', () => {
    const payload = body();
    const header = signPayload(payload, SECRET, NOW_SEC);
    const tampered = payload.replace('evt_1', 'evt_haxx');
    expect(() =>
      constructEvent({ payload: tampered, signatureHeader: header, secret: SECRET, nowMs: NOW }),
    ).toThrow(/signature/i);
  });

  test('rejects the wrong signing secret', () => {
    const payload = body();
    const header = signPayload(payload, SECRET, NOW_SEC);
    expect(() =>
      constructEvent({ payload, signatureHeader: header, secret: 'whsec_wrong', nowMs: NOW }),
    ).toThrow(/signature/i);
  });

  test('rejects a missing v1 signature', () => {
    expect(() =>
      constructEvent({ payload: body(), signatureHeader: `t=${NOW_SEC}`, secret: SECRET, nowMs: NOW }),
    ).toThrow(/signature/i);
  });

  test('rejects a stale timestamp outside tolerance (replay defense)', () => {
    const payload = body();
    const staleTs = NOW_SEC - 60 * 10; // 10 minutes old
    const header = signPayload(payload, SECRET, staleTs);
    expect(() =>
      constructEvent({
        payload,
        signatureHeader: header,
        secret: SECRET,
        nowMs: NOW,
        toleranceSeconds: 300,
      }),
    ).toThrow(/timestamp/i);
  });

  test('accepts a recent timestamp within tolerance', () => {
    const payload = body();
    const recentTs = NOW_SEC - 60; // 1 minute old
    const header = signPayload(payload, SECRET, recentTs);
    const event = constructEvent({
      payload,
      signatureHeader: header,
      secret: SECRET,
      nowMs: NOW,
      toleranceSeconds: 300,
    });
    expect(event.id).toBe('evt_1');
  });
});
