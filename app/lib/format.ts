// Parse a user-entered dollar string ("1,234.56") into integer cents, without
// floating point. Throws on malformed input.
export function dollarsToCents(input: string): bigint {
  const cleaned = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) {
    throw new Error(`invalid amount: "${input}"`);
  }
  const [whole, frac = ''] = cleaned.split('.');
  const cents = frac.padEnd(2, '0').slice(0, 2);
  return BigInt(whole) * 100n + BigInt(cents);
}

// Integer cents in, human dollars out. Never do math here — display only.
export function usd(cents: string | number | bigint | null | undefined): string {
  if (cents === null || cents === undefined) return '$0.00';
  const n = BigInt(cents);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const dollars = abs / 100n;
  const rem = (abs % 100n).toString().padStart(2, '0');
  const withCommas = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${withCommas}.${rem}`;
}
