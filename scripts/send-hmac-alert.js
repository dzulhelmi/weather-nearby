/**
 * Sends a signed alert to the HMAC-protected webhook endpoint.
 *
 *   node scripts/send-hmac-alert.js          valid signature   -> 200
 *   node scripts/send-hmac-alert.js --bad    wrong secret      -> 401
 *
 * The page's buttons use the simpler token-based endpoint. This script exists
 * to exercise the HMAC one, which is the stronger method: the secret itself is
 * never sent, only a fingerprint derived from it and the message body.
 */

const { sign } = require('../lib/signature');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SECRET = process.env.WEBHOOK_SECRET || 'demo-secret-change-in-production';

const useWrongSecret = process.argv.includes('--bad');

async function main() {
  const body = JSON.stringify({
    area: 'Shah Alam',
    level: 'warning',
    message: 'Heavy rain expected within the next 2 hours.',
    source: 'Weather Monitor (script)',
  });

  const { header } = sign(body, useWrongSecret ? 'the-wrong-secret' : SECRET);

  console.log(`POST ${BASE_URL}/webhook/alert-hmac`);
  console.log(`x-signature: ${header}`);
  console.log(`secret used: ${useWrongSecret ? 'WRONG (expect 401)' : 'correct (expect 200)'}\n`);

  const res = await fetch(`${BASE_URL}/webhook/alert-hmac`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': header },
    body,
  });

  console.log(`-> ${res.status} ${res.statusText}`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  console.error('Is the server running? Try: npm start');
  process.exit(1);
});
