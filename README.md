# Weather & Nearby

Enter an area name and get its weather forecast plus notable places within a
chosen radius. It also exposes a webhook endpoint that receives weather alerts
from an external monitoring service.

This project demonstrates **integration in both directions**:

| Direction | What it means | Where |
|---|---|---|
| **We ask them** | We call three external APIs and merge the results | `GET /api/place` → [lib/sources.js](lib/sources.js) |
| **They tell us** | An open endpoint that receives alerts, with the sender verified | `POST /webhook/alert` → [server.js](server.js) |

No API keys required. No accounts to register.

---

## Running it

```bash
npm install
npm start
```

Open <http://localhost:3000>.

---

## The three external APIs

All three are free and keyless, which is why this repo runs immediately after
cloning.

### 1. Open-Meteo Geocoding — name to coordinates

```
GET https://geocoding-api.open-meteo.com/v1/search?name=Shah+Alam&count=1&format=json
```

People type place names; every geo API speaks latitude and longitude. This
call bridges that gap, and it must run **first** because the other two need its
output.

Returns: `latitude`, `longitude`, `admin1` (state), `country`, `timezone`.

### 2. Open-Meteo Forecast — coordinates to weather

```
GET https://api.open-meteo.com/v1/forecast?latitude=3.085&longitude=101.533
      &current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m
      &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max
      &timezone=auto&forecast_days=4
```

Returns current conditions and a 4-day forecast. Two details worth knowing:

- Weather arrives as numeric **WMO codes**, not text. Code `95` means
  thunderstorm. Mapping those to words and icons is our job — see
  `WEATHER_CODES` in [lib/sources.js](lib/sources.js).
- The daily forecast comes back as **parallel arrays** (one array per field),
  so we zip them into one object per day before rendering.

### 3. Wikipedia GeoSearch — coordinates and radius to nearby places

```
GET https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json
      &gscoord=3.085|101.533&gsradius=5000&gslimit=8
```

A genuine radius search: give it a centre point and a distance in metres, and
it returns articles inside that circle, sorted nearest first, each with its
exact distance. Maximum radius is 10 km, which is why user input is clamped
before being sent.

### How they are combined

```
User types "Shah Alam", radius 5 km
        │
        ▼
GET /api/place?name=Shah+Alam&radius=5
        │
        ├─► 1. Geocoding        "Shah Alam"  →  3.085, 101.533
        │
        │      coordinates ready; the next two calls do not depend on
        │      each other, so they run CONCURRENTLY:
        │
        ├─► 2. Forecast         current conditions + 4 days
        └─► 3. GeoSearch        places within 5 km

        merged into one clean JSON response → rendered
```

Steps 2 and 3 use `Promise.allSettled`, not `Promise.all`. If Wikipedia fails,
the user still gets their weather — one source going down should not take the
whole page with it.

---

## The webhook

The endpoint is open to the internet, so the sender has to prove itself before
anything in the body is trusted. Two methods are implemented.

### Shared token — `/webhook/alert`

The default, and what the page's buttons use.

```
Weather monitoring service
        │
        ▼
POST /webhook/alert  ── x-webhook-token: <secret> ──► matches? ─ no ─► 401
                                                          │
                                                         yes
                                                          ▼
                                                   alert accepted
```

Simple, and fine over HTTPS. Comparison uses `crypto.timingSafeEqual` so the
response time can't leak the token.

### HMAC signature — `/webhook/alert-hmac`

Stronger: the secret is never transmitted, only a fingerprint derived from it
and the body — which also proves the body wasn't modified in transit.

```
x-signature: t=1723800000,v1=<hex>

v1 = HMAC_SHA256(secret, "<t>.<raw body>")
```

Rejected when the header is missing, the timestamp is older than 5 minutes
(replay protection), or the digest doesn't match. The **raw** body is used, not
a parsed object — the HMAC covers the exact bytes that were sent.

Try it against a running server:

```bash
node scripts/send-hmac-alert.js        # valid signature   -> 200
node scripts/send-hmac-alert.js --bad  # wrong secret      -> 401
```

### Which to use

A shared token is enough for most integrations over HTTPS. Prefer HMAC when the
payload passes through infrastructure you don't control, or when tampering with
the body would be costly — the token approach can't detect that.

---

## Project structure

```
server.js                     HTTP routes, input validation, status codes
lib/sources.js                the three external API calls, and how they merge
lib/signature.js              HMAC signing/verifying, and safe comparison
public/index.html             UI: search form, weather card, alert list

scripts/send-hmac-alert.js    exercises the HMAC webhook endpoint
api/index.js                  Vercel entry point (one line)
vercel.json                   routes every path to that entry point
```

Four source files. Each one readable in a single sitting.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/place?name=&radius=` | Look up an area. Radius 1–10 km. |
| `POST` | `/webhook/alert` | Receive an alert. Requires `x-webhook-token`. |
| `POST` | `/webhook/alert-hmac` | Same, secured with an `x-signature` HMAC instead. |
| `POST` | `/api/demo/alert` | Demo helper: builds an alert payload and its token. |

The two alert buttons work in two steps: the page asks `/api/demo/alert` for a
payload and token, then POSTs that payload to `/webhook/alert` itself. The
webhook call is therefore a real HTTP request you can watch in the browser's
Network tab.

```bash
curl "http://localhost:3000/api/place?name=Kuantan&radius=8"
```

Status codes returned:

| Code | When |
|---|---|
| `200` | Success |
| `422` | Area name invalid (too short) |
| `404` | Name valid, but no such place exists |
| `502` | An external API failed — not our code |
| `401` | Webhook signature invalid |

## Deploying

### Vercel

The repo already contains everything Vercel needs:

- `api/index.js` — hands the Express app to Vercel's serverless runtime
- `vercel.json` — rewrites every path to that function, so Express keeps its own routing

```bash
npm i -g vercel
vercel
vercel --prod
```

Or connect the GitHub repo at [vercel.com/new](https://vercel.com/new) — no build
settings to change; Vercel detects the `api/` folder on its own.

Set one environment variable in **Project → Settings → Environment Variables**:

| Name | Value |
|---|---|
| `WEBHOOK_SECRET` | a random string |

Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Note on serverless:** Vercel runs each request as a short-lived function, so
nothing can be kept in memory between requests. That is why this app holds no
server-side state — the alert list lives in the browser, and the webhook
endpoint verifies and responds without storing. A production system would write
to a database here.

### Render

Render runs a normal long-lived Node process instead, which suits Express more
naturally.

1. Push to GitHub.
2. Render → New → Web Service → pick the repo.
3. Build: `npm install` · Start: `npm start`
4. Environment variable: `WEBHOOK_SECRET`

Note that Render's free tier sleeps after inactivity, so the first request after
a quiet period takes around 30 seconds.

## Known limitations

Deliberately kept small.

| Limitation | What production would need |
|---|---|
| Alerts aren't persisted | A database. The webhook verifies and responds, but the on-screen list lives in the browser — serverless functions share no memory between requests |
| No caching on external calls | Weather for the same area doesn't change by the second; caching cuts load and avoids rate limits |
| No rate limiting on `/api/place` | Anyone could flood it and burn through the external API quota |
| A single webhook secret | Secret rotation — accepting both old and new during a changeover |
| Radius capped at 10 km | Wikipedia's own limit; a larger radius needs a different data source |
