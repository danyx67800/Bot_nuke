export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(clamp(n, min, max));
}

export function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

// Gli ID Discord (snowflake) sono interi a 64 bit in stringa.
export function isSnowflake(value) {
  return typeof value === 'string' && /^\d{15,21}$/.test(value);
}

export function maskToken(token) {
  if (!token) return '';
  const tail = token.slice(-4);
  return `••••••••${tail}`;
}

export function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

export function isoNow() {
  return new Date().toISOString();
}

export function clampPostRate(retryAfterMs) {
  const ms = Number(retryAfterMs);
  if (!Number.isFinite(ms) || ms <= 0) return 60_000;
  return Math.min(15 * 60_000, Math.max(5_000, ms));
}
