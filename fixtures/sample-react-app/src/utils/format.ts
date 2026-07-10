/**
 * @fileoverview Small pure formatting helpers with no framework dependencies.
 */

/**
 * Format a number as a localized currency string.
 *
 * @param amount - value in major currency units
 * @param currency - ISO 4217 currency code
 */
export function formatCurrency(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

/** Format a Date as `YYYY-MM-DD`. */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Internal, non-exported helper — should still be captured by the sweep.
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format seconds as `mm:ss`. */
export function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${pad2(m)}:${pad2(s)}`;
}
