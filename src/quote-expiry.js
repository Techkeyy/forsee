export const QUOTE_TTL_MS = 120000;

// Fail closed if the local clock moves backwards or quote metadata is invalid.
export function quoteSecondsRemaining(quote, now) {
  if (!quote || !Number.isFinite(quote.created) || !Number.isFinite(now) || now < quote.created) return 0;
  return Math.max(0, Math.ceil((QUOTE_TTL_MS - (now - quote.created)) / 1000));
}
