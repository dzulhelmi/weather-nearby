/**
 * Webhook signatures (HMAC SHA-256) — the stronger of the two methods here.
 *
 * The project verifies incoming webhooks in two ways:
 *
 *   /webhook/alert       shared token in a header  (server.js — the default)
 *   /webhook/alert-hmac  HMAC signature            (this file)
 *
 * A shared token is simpler and fine over HTTPS, but the token itself travels
 * with every request, so it can leak through logs or proxies. An HMAC never
 * sends the secret at all -- only a value derived from it.
 *
 * The core problem both solve: our endpoint has to be open to the internet,
 * because the external service needs to reach it. But that means anyone else
 * can reach it too -- including someone who wants to send a fake storm warning.
 *
 * The fix is a shared secret. The sender computes an HMAC over the message
 * body using that secret and puts the result in a header. We recompute the
 * same HMAC on our side and compare. The secret itself never travels over the
 * network.
 *
 * Header format (same style as Stripe and GitHub):
 *
 *     x-signature: t=1723800000,v1=<hex>
 *
 *     v1 = HMAC_SHA256(secret, "<t>.<raw body>")
 *
 * The timestamp is folded into the signed value so that someone who captures a
 * valid request cannot replay it forever.
 */

const crypto = require('crypto');

const TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Compare two strings without leaking their contents through timing.
 *
 * A normal === stops at the first differing character, so how long the
 * comparison takes reveals how much of the value was correct. timingSafeEqual
 * always takes the same amount of time regardless.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sign(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  return { header: `t=${timestamp},v1=${digest}` };
}

function parseHeader(header) {
  const out = {};
  for (const part of String(header || '').split(',')) {
    const [key, value] = part.split('=');
    if (key && value) out[key.trim()] = value.trim();
  }
  return { timestamp: Number(out.t), digest: out.v1 };
}

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verify(rawBody, header, secret) {
  const { timestamp, digest } = parseHeader(header);

  if (!timestamp || !digest) {
    return { ok: false, reason: 'Missing or malformed x-signature header' };
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > TOLERANCE_SECONDS) {
    return { ok: false, reason: `Timestamp too old (${age}s) — possible replay attack` };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(digest, 'hex');

  // Lengths must match before timingSafeEqual, otherwise it throws.
  if (a.length !== b.length) return { ok: false, reason: 'Signature does not match' };

  // A normal comparison (===) stops at the first differing character, so the
  // response time leaks the signature one character at a time. timingSafeEqual
  // always takes the same amount of time.
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'Signature does not match' };

  return { ok: true };
}

module.exports = { sign, verify, safeEqual };
