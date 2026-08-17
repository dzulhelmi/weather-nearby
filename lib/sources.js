/**
 * Connections to external APIs.
 *
 * One user search = three calls to two different services:
 *
 *   1. Area name   -> coordinates                  (Open-Meteo Geocoding)
 *   2. Coordinates -> weather forecast             (Open-Meteo Forecast)
 *   3. Coordinates -> nearby places within radius  (Wikipedia GeoSearch)
 *
 * Steps 2 and 3 both depend on step 1, but not on each other -- so they run
 * concurrently rather than one after the other.
 *
 * None of them requires an API key.
 */

const TIMEOUT_MS = 6000;

/**
 * fetch with a time limit.
 *
 * Plain fetch() has no timeout. If an external service hangs, our request hangs
 * forever with it and the user just sees a loading spinner. AbortController is
 * the standard way to put a ceiling on that.
 */
async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'weather-nearby-demo/1.0 (learning project)' },
    });
    if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} did not respond within ${TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 1. Area name -> coordinates
 *
 * Every geo API speaks in latitude and longitude, but people type place
 * names. Geocoding bridges that gap, and it has to run first because the
 * other two calls need its output.
 * ------------------------------------------------------------------ */
async function geocode(name) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(name)}&count=1&format=json`;

  const body = await fetchJson(url, 'Geocoding API');
  const hit = body?.results?.[0];

  // No result is not a system failure -- the user just typed a name nobody
  // knows. Return null and let the route decide the right status code.
  if (!hit) return null;

  return {
    name: hit.name,
    region: [hit.admin1, hit.country].filter(Boolean).join(', '),
    latitude: hit.latitude,
    longitude: hit.longitude,
    timezone: hit.timezone,
  };
}

/* ------------------------------------------------------------------ *
 * 2. Coordinates -> weather
 * ------------------------------------------------------------------ */

/**
 * Open-Meteo returns weather as numeric WMO codes, not text. Turning those
 * into words is our job, not the user's.
 */
const WEATHER_CODES = {
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Foggy', '🌫️'],
  48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Moderate drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌦️'],
  61: ['Light rain', '🌧️'],
  63: ['Moderate rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Moderate snow', '🌨️'],
  75: ['Heavy snow', '🌨️'],
  80: ['Light showers', '🌦️'],
  81: ['Moderate showers', '🌧️'],
  82: ['Violent showers', '⛈️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with hail', '⛈️'],
  99: ['Severe thunderstorm', '⛈️'],
};

function describeCode(code) {
  const [text, icon] = WEATHER_CODES[code] || ['Unknown', '❓'];
  return { text, icon };
}

async function getWeather(lat, lon) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=auto&forecast_days=4';

  const body = await fetchJson(url, 'Weather API');

  // The API returns parallel arrays (one array per field). Zip them into one
  // object per day, which is far easier to render.
  const days = body.daily.time.map((date, i) => ({
    date,
    ...describeCode(body.daily.weather_code[i]),
    max: body.daily.temperature_2m_max[i],
    min: body.daily.temperature_2m_min[i],
    rainChance: body.daily.precipitation_probability_max[i],
  }));

  return {
    now: {
      temperature: body.current.temperature_2m,
      humidity: body.current.relative_humidity_2m,
      wind: body.current.wind_speed_10m,
      ...describeCode(body.current.weather_code),
    },
    days,
  };
}

/* ------------------------------------------------------------------ *
 * 3. Coordinates + radius -> nearby places
 * ------------------------------------------------------------------ */

/**
 * Wikipedia GeoSearch is a true radius search: give it a centre point and a
 * distance in metres, and it returns articles inside that circle, sorted
 * nearest first.
 */
async function getNearby(lat, lon, radiusKm) {
  const meters = Math.min(Math.max(radiusKm * 1000, 1000), 10000); // API limit: 10km
  const url = 'https://en.wikipedia.org/w/api.php'
    + '?action=query&list=geosearch&format=json'
    + `&gscoord=${lat}%7C${lon}&gsradius=${meters}&gslimit=8`;

  const body = await fetchJson(url, 'Wikipedia API');

  return (body?.query?.geosearch || []).map((p) => ({
    title: p.title,
    distanceKm: Number((p.dist / 1000).toFixed(2)),
    url: `https://en.wikipedia.org/?curid=${p.pageid}`,
  }));
}

/* ------------------------------------------------------------------ *
 * Combining the three
 * ------------------------------------------------------------------ */

/**
 * @returns {null|{place, weather, nearby, nearbyError}}
 *   null means the area name was not found.
 */
async function lookupPlace(name, radiusKm) {
  const place = await geocode(name);
  if (!place) return null;

  // Promise.allSettled, not Promise.all: if Wikipedia fails, the user should
  // still get their weather. One source going down should not take the whole
  // page with it.
  const [weather, nearby] = await Promise.allSettled([
    getWeather(place.latitude, place.longitude),
    getNearby(place.latitude, place.longitude, radiusKm),
  ]);

  // Weather is the point of the page, so if that fails there is nothing worth
  // showing. Nearby places are a bonus, so we degrade instead of failing.
  if (weather.status === 'rejected') throw weather.reason;

  return {
    place,
    radiusKm,
    weather: weather.value,
    nearby: nearby.status === 'fulfilled' ? nearby.value : [],
    nearbyError: nearby.status === 'rejected' ? nearby.reason.message : null,
  };
}

module.exports = { lookupPlace };
