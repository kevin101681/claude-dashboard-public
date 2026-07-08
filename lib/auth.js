// Auth layer. Two modes:
//   1. Clerk mode (when CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY are set):
//      API/WS requests carry a Clerk session JWT (Authorization: Bearer or
//      ?clerk_token= for WebSockets). Verified server-side, optionally
//      restricted to an email allowlist. Static assets are public (the app
//      shell renders Clerk's sign-in).
//   2. Token mode (no Clerk config): the original shared-token + cookie auth,
//      which gates everything including static assets.
// Env vars win over config.json keys of the same (camelCase) name.

const crypto = require('crypto');

function setting(config, envName, configKey) {
  return process.env[envName] || config[configKey] || null;
}

class Auth {
  constructor(config) {
    this.config = config;
    this.secretKey = setting(config, 'CLERK_SECRET_KEY', 'clerkSecretKey');
    this.publishableKey = setting(config, 'CLERK_PUBLISHABLE_KEY', 'clerkPublishableKey');
    if (this.secretKey && !this.secretKey.startsWith('sk_')) {
      console.warn(`auth: clerkSecretKey doesn't look like a Clerk secret key (expected sk_...) — Clerk auth disabled until it's fixed`);
      this.secretKey = null;
    }
    if (this.publishableKey && !this.publishableKey.startsWith('pk_')) {
      console.warn(`auth: clerkPublishableKey doesn't look like a Clerk publishable key (expected pk_...) — Clerk auth disabled until it's fixed`);
      this.publishableKey = null;
    }
    this.allowedEmails = (setting(config, 'ALLOWED_EMAILS', 'allowedEmails') || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const allowToken = setting(config, 'ALLOW_TOKEN_AUTH', 'allowTokenAuth');
    // Shared-token auth stays available by default (handy on the PC itself);
    // set ALLOW_TOKEN_AUTH=false to make Clerk the only way in.
    this.allowTokenAuth = allowToken === null ? true : String(allowToken) !== 'false';
    this._sdkPromise = null;
    this._client = null;
    this._emailCache = new Map(); // userId -> { ok, expires }
  }

  get clerkEnabled() {
    return !!(this.secretKey && this.publishableKey);
  }

  _sdk() {
    // @clerk/backend is ESM-only; load it lazily from CommonJS.
    if (!this._sdkPromise) this._sdkPromise = import('@clerk/backend');
    return this._sdkPromise;
  }

  bearerFrom(req) {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
    const url = new URL(req.url, 'http://x');
    return url.searchParams.get('clerk_token');
  }

  async verifyClerk(token) {
    const { verifyToken, createClerkClient } = await this._sdk();
    const payload = await verifyToken(token, { secretKey: this.secretKey });
    if (this.allowedEmails.length) {
      await this._checkEmailAllowed(payload.sub, createClerkClient);
    }
    return payload;
  }

  async _checkEmailAllowed(userId, createClerkClient) {
    const cached = this._emailCache.get(userId);
    if (cached && cached.expires > Date.now()) {
      if (!cached.ok) throw new Error('email not on allowlist');
      return;
    }
    if (!this._client) this._client = createClerkClient({ secretKey: this.secretKey });
    const user = await this._client.users.getUser(userId);
    const emails = (user.emailAddresses || []).map(e => e.emailAddress.toLowerCase());
    const ok = emails.some(e => this.allowedEmails.includes(e));
    this._emailCache.set(userId, { ok, expires: Date.now() + 10 * 60 * 1000 });
    if (!ok) throw new Error('email not on allowlist');
  }

  tokenFrom(req) {
    const url = new URL(req.url, 'http://x');
    const qp = url.searchParams.get('token');
    if (qp) return qp;
    const cookies = req.headers.cookie || '';
    const m = cookies.match(/(?:^|;\s*)cd_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  tokenAuthorized(req) {
    if (!this.allowTokenAuth) return false;
    const t = this.tokenFrom(req);
    return !!t && t.length === this.config.token.length &&
      crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.config.token));
  }

  // Unified check for API routes and WebSocket upgrades.
  async authorize(req) {
    if (this.clerkEnabled) {
      const bearer = this.bearerFrom(req);
      if (bearer) {
        try { await this.verifyClerk(bearer); return true; } catch { return false; }
      }
    }
    return this.tokenAuthorized(req);
  }
}

module.exports = { Auth };
