export function getExpiryDate(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}
