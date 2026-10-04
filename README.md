# No Roll Models — Safer Bike Routing

A web app that scores San Francisco streets on three safety factors (crash
history, bike lane quality, highway/arterial exposure), visualizes them as
color-coded danger zones on a map, and computes a safer alternative bike
route that avoids the worst of them - instead of just the fastest route like
typical navigation apps.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the whole project fits
together, the data model, and a running build log.

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up a Google Maps API key

Copy the example env file:

```bash
cp .env.local.example .env.local
```

Then fill in `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` with a key from the
[Google Cloud Console](https://console.cloud.google.com/google/maps-apis).
You need to enable these APIs on that project: **Maps JavaScript API**,
**Places API**, **Geocoding API**, and **Directions API**. See the comments
in `.env.local.example` for details.

### 3. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Running tests

```bash
npm test
```

Runs the Vitest unit test suite (`lib/**/*.test.ts`).

### Testing navigation

After choosing a route, press **Confirm route**, then:

- **Simulate ride**: a synthetic rider follows the route through the same
  matching, instruction and rerouting code as real GPS. Use 1× / 4× / 10× to
  change speed, and **Go off route** to check rerouting. Works on any desktop.
- **Start navigation**: live GPS from the browser's geolocation API.

### Testing GPS on a phone

Browsers only share location with a **secure** page: `https://...`, or
`http://localhost` on the same machine. Opening `http://192.168.x.x:3000` on a
phone is *not* secure, and the browser refuses location without even asking.
So give the dev server an https URL:

**Option A — tunnel (recommended; works on iPhone and Android, no warnings)**

```bash
npm run dev                                      # terminal 1
brew install cloudflared                         # once
cloudflared tunnel --url http://localhost:3000   # terminal 2
```

Open the `https://<random>.trycloudflare.com` URL it prints on your phone and
allow location when asked. (`ngrok http 3000` works the same way.) Both domains
are already allowed in `next.config.ts`. If your Google Maps key restricts HTTP
referrers, add `*.trycloudflare.com/*` to the key in Google Cloud Console, or
the base map will not load on the tunnel URL.

**Option B — self-signed https on your network**

```bash
npm run dev:https
```

Then open `https://<your-mac-ip>:3000` on the phone and accept the certificate
warning. Android Chrome then allows location; iOS Safari is less reliable with
self-signed certificates, so prefer Option A there.

On the phone, keep the screen on and the page in front while riding. A web page
cannot get location in the background; that needs the future native/PWA app.

## Project status

This project is being built in phases - see `ARCHITECTURE.md`'s build log
for what currently exists. Road geometry (OpenStreetMap) and bike-lane
infrastructure quality (SFMTA's official bike-network data) are real; crash
and highway/arterial data are currently mock data shaped to resemble real
BikeMaps.org/NHTSA records - see `lib/dataSources/bikemaps.ts` for notes on
wiring up real crash data later.
