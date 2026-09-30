// How much each investor category can apply for, from the lot size and the
// upper price band (SEBI's mainboard limits):
//   Retail        up to Rs 2 lakh
//   Small HNI     above Rs 2 lakh, up to Rs 10 lakh (sNII)
//   Big HNI       above Rs 10 lakh (bNII)
const RETAIL_MAX = 200_000;
const SHNI_MAX = 1_000_000;

export type LotRow = { category: string; lots: number; shares: number; amount: number };

export function lotTable(lotSize: number | null, price: number | null): LotRow[] {
  if (!lotSize || !price) return [];
  const lotAmt = lotSize * price;
  const row = (category: string, lots: number): LotRow => ({ category, lots, shares: lots * lotSize, amount: lots * lotAmt });
  const retailMax = Math.floor(RETAIL_MAX / lotAmt);
  const shniMin = retailMax + 1;
  const shniMax = Math.floor(SHNI_MAX / lotAmt);
  const out: LotRow[] = [];
  if (retailMax >= 1) out.push(row("Retail (min)", 1), row("Retail (max)", retailMax));
  if (shniMax >= shniMin) out.push(row("Small HNI (min)", shniMin), row("Small HNI (max)", shniMax));
  out.push(row("Big HNI (min)", Math.max(shniMax, retailMax) + 1));
  return out;
}
