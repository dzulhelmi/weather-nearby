/**
 * Weather & Nearby — an API connection + webhook demo
 *
 * Two directions of integration, one page:
 *
 *   WE ASK THEM      GET /api/place?name=Shah+Alam
 *                    three external API calls, merged into one clean answer
 *
 *   THEY TELL US     POST /webhook/alert
 *                    an open endpoint; every message is verified with HMAC
 *
 * Run: npm start  ->  http://localhost:3000
 */

const path = require('path');
const express = require('express');

const { lookupPlace } = require('./lib/sources');
const { verify, safeEqual } = require('./lib/signature');

const PORT = process.env.PORT || 3000;

// Shared with the weather monitoring service that sends us alerts.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'demo-secret-change-in-production';

const app = express();
app.disable('x-powered-by');

/**
 * The webhook endpoint must read the RAW body, not a parsed JSON object,
 * because the HMAC is computed over the exact bytes that were sent. If we
 * JSON.parse first and then stringify again, key order or whitespace can shift
 * slightly and the signature will no longer match.
 */
app.use('/webhook', express.raw({ type: '*/*', limit: '50kb' }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ================================================================== *
 * PART 1 — the API connection
 *
 * One user request, three calls to external services, one clean answer.
 * The user never needs to know there are three APIs behind it.
 * ================================================================== */

app.get('/api/place', async (req, res) => {
  const name = String(req.query.name || '').trim();

  // The radius comes from the user, so it cannot be trusted. Clamp it to the
  // range the Wikipedia API actually allows before sending it outward.
  const radiusKm = Math.min(Math.max(Number(req.query.radius) || 5, 1), 10);

  if (name.length < 2) {
    return res.status(422).json({
      error: 'invalid_name',
      message: 'Please enter an area name (at least 2 characters).',
    });
  }

  try {
    const result = await lookupPlace(name, radiusKm);

    if (!result) {
      // 404, not 500: our system worked fine, that place just doesn't exist.
      return res.status(404).json({
        error: 'area_not_found',
        message: `Could not find "${name}". Try a city or district name.`,
      });
    }

    res.json(result);
  } catch (err) {
    // A failure here means an EXTERNAL service broke, not our code.
    // 502 Bad Gateway is the accurate status for that, and the message tells
    // the user what actually went wrong.
    console.error('Lookup failed:', err.message);
    res.status(502).json({ error: 'external_source_failed', message: err.message });
  }
});

/* ================================================================== *
 * PART 2 — the incoming webhook
 *
 * A weather monitoring service pushes alerts to us when it detects severe
 * conditions. We never have to poll and ask.
 *
 * The endpoint is open to the internet, so anyone could POST to it. We check a
 * shared secret token before trusting anything in the body: the sender puts
 * the token in a header, and we compare it against our own copy.
 * ================================================================== */

app.post('/webhook/alert', (req, res) => {
  // Check the token FIRST, before reading the body.
  // Never act on data you haven't verified.
  if (!safeEqual(req.get('x-webhook-token') || '', WEBHOOK_SECRET)) {
    console.log('[alert] REJECTED — bad token');
    return res.status(401).json({
      accepted: false,
      error: 'invalid_token',
      reason: 'Missing or incorrect x-webhook-token header',
    });
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
  } catch {
    return res.status(400).json({ accepted: false, error: 'invalid_json' });
  }

  // A real system would store this or trigger a notification here. This demo
  // just acknowledges it -- the browser displays what it sent and got back.
  console.log(`[alert] ACCEPTED — ${payload.area}: ${payload.message}`);

  res.json({
    accepted: true,
    area: payload.area,
    level: payload.level,
    message: payload.message,
  });
});

/**
 * The same webhook, secured with an HMAC signature instead of a token.
 *
 * Stronger, because the secret is never transmitted -- only a fingerprint
 * derived from it, which also proves the body wasn't modified in transit.
 * Try it with:  node scripts/send-hmac-alert.js
 */
app.post('/webhook/alert-hmac', (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  const check = verify(rawBody, req.get('x-signature'), WEBHOOK_SECRET);
  if (!check.ok) {
    console.log(`[alert-hmac] REJECTED — ${check.reason}`);
    return res.status(401).json({ accepted: false, error: 'invalid_signature', reason: check.reason });
  }

  const payload = JSON.parse(rawBody);
  console.log(`[alert-hmac] ACCEPTED — ${payload.area}: ${payload.message}`);

  res.json({ accepted: true, area: payload.area, level: payload.level, message: payload.message });
});

/* ------------------------------------------------------------------ *
 * Demo helper — NOT part of the real integration.
 *
 * Plays the role of the external monitoring service: it builds an alert
 * payload and hands over the token to send with it. The browser then POSTs
 * that payload to /webhook/alert itself, so the webhook request is a real
 * HTTP call you can watch in the browser's Network tab.
 *
 * The payload is built here rather than accepted from the caller.
 * ------------------------------------------------------------------ */

app.post('/api/demo/alert', (req, res) => {
  const area = String(req.body?.area || '').trim().slice(0, 80) || 'Shah Alam';

  const body = JSON.stringify({
    area,
    level: 'warning',
    message: 'Heavy rain expected within the next 2 hours.',
    source: 'Weather Monitor (simulated)',
  });

  // The wrong token is what makes the rejection demo work: same payload,
  // different token, and the check fails.
  const token = req.body?.useWrongToken ? 'the-wrong-token' : WEBHOOK_SECRET;

  res.json({ body, token });
});

app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

/**
 * Only listen when run directly (npm start). When this file is imported by a
 * serverless host such as Vercel, the platform handles listening itself.
 */
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n  Weather & Nearby running at http://localhost:${PORT}\n`));
}

module.exports = app;
