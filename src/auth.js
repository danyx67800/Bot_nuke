import crypto from 'node:crypto';

const COOKIE_NAME = 'bn_session';
const MAX_ATTEMPTS = 6;
const ATTEMPT_WINDOW_MS = 5 * 60_000;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export class Auth {
  constructor({ store, secret, secureCookies = false, ttlMs = 7 * 24 * 3600_000 }) {
    this.store = store;
    this.secret = secret;
    this.secureCookies = secureCookies;
    this.ttlMs = ttlMs;
    this.attempts = new Map();
  }

  get hasPassword() {
    const auth = this.store.data.auth;
    return Boolean(auth?.passwordHash && auth?.salt);
  }

  setPassword(password) {
    const pw = String(password ?? '');
    if (pw.length < 8) throw new Error('La password deve avere almeno 8 caratteri.');
    if (pw.length > 200) throw new Error('Password troppo lunga (max 200 caratteri).');
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(pw, salt);
    this.store.update((cfg) => {
      cfg.auth = { passwordHash, salt, epoch: (cfg.auth?.epoch ?? 0) + 1 };
    });
    return this.issueCookie();
  }

  verify(password) {
    const auth = this.store.data.auth;
    if (!auth?.passwordHash || !auth?.salt) return false;
    return safeEqual(hashPassword(String(password ?? ''), auth.salt), auth.passwordHash);
  }

  /** Invalida tutte le sessioni (cambio password). */
  revokeAll() {
    this.store.update((cfg) => {
      cfg.auth = { ...cfg.auth, epoch: (cfg.auth?.epoch ?? 0) + 1 };
    });
  }

  issueCookie() {
    const payload = Buffer.from(JSON.stringify({
      e: this.store.data.auth?.epoch ?? 0,
      exp: Date.now() + this.ttlMs,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    const parts = [
      `${COOKIE_NAME}=${payload}.${sig}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    ];
    if (this.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie() {
    const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (this.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  isAuthenticated(req) {
    if (!this.hasPassword) return false;
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return false;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    if (!safeEqual(sig, expected)) return false;
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return false;
    return data.e === (this.store.data.auth?.epoch ?? 0);
  }

  attemptAllowed(ip) {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now - rec.first > ATTEMPT_WINDOW_MS) return true;
    return rec.count < MAX_ATTEMPTS;
  }

  noteFailure(ip) {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now - rec.first > ATTEMPT_WINDOW_MS) this.attempts.set(ip, { first: now, count: 1 });
    else rec.count += 1;
    if (this.attempts.size > 2000) this.attempts.clear();
  }

  noteSuccess(ip) {
    this.attempts.delete(ip);
  }
}
