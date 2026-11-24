// Simple local-variation uncertainty.
//
// Each reading gets an uncertainty equal to the sample standard deviation of
// the last `window` readings (itself included). It reflects how much the
// balance was oscillating around that moment, not over the whole session.
// The final uncertainty of a session is the mean of those local values.

export const DEFAULT_WINDOW = 5;

/** Sample standard deviation (n-1); 0 when fewer than 2 values. */
export function stdDev(values) {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return Math.sqrt(sq / (n - 1));
}

/** Uncertainty of values[index]: std dev of the window ending there; null for the first reading. */
export function localUncertainty(values, index, window = DEFAULT_WINDOW) {
  if (index < 1) return null;
  const start = Math.max(0, index - window + 1);
  return stdDev(values.slice(start, index + 1));
}

export function localUncertainties(values, window = DEFAULT_WINDOW) {
  return values.map((_, i) => localUncertainty(values, i, window));
}

/** Average of the defined local uncertainties (null when there are none). */
export function meanUncertainty(uncertainties) {
  const known = uncertainties.filter((u) => u !== null && u !== undefined);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}
