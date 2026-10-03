# route-gif

Generates a GIF of what a Google Maps route looks like from Street View.

Open the site, paste your own Google Maps Platform API key, enter a start and destination, get directions, choose how many Street View photos per mile to sample along the route, then generate and download the GIF.

**Live site:** https://cmlilley.github.io/route-gif/

## How to use

1. Paste your Google Maps Platform API key into the page. The key is never hardcoded in this repo, is never sent anywhere except Google, and is kept only in page memory for the session — you will need to paste it again after a reload.
2. Enter a start and a destination, then click **Get directions**. The route is drawn on the map with distance and drive time.
3. In its own card after the directions card, set three sliders: **Interstate photos per mile** (1–100, default 2), **Local streets photos per mile** (1–100, default 5), and **Photos per turn** (1–9, default 3). The route is classified into interstate vs local stretches from the directions, each stretch is sampled at its own density, and the page estimates the total — interstate photos + local photos + guaranteed between-turn photos + turn photos — plus the estimated GIF duration at your chosen frame delay.
4. Click to load the Street View photos. Every turn in the directions gets the chosen number of photos centred on the turn (~45 m apart; 3 = before / mid / after), and every section between turns (including start and destination sections) is guaranteed at least one photo at its midpoint if regular sampling would miss it. Each photo's heading faces the direction of travel, recomputed from the actual Street View panorama location, and is shown as `HDG` (with `INT`/`LOC` for its road class) on each frame. Green dots have coverage, red dots do not; amber dots are turn photos.
5. Click **Generate GIF**, preview it, then click **Download route.gif**. The finished GIF card sits directly under the map, above the frames list.

Street View photos are requested with `source=outdoor` so indoor/business panoramas are excluded. If a photo looks wrong, click **Copy frame debug info** in the Frames card to copy a JSON dump of every frame's requested location, snapped panorama ID/location/date, heading, and type (route / before-turn / mid-turn / after-turn) — it never includes your API key.

## Google Cloud setup

Billing must be enabled on the project. Enable these APIs for the key's project:

- **Maps JavaScript API** — draws the map and computes the route
- **Routes API** — route calculation (the page falls back to the legacy Directions API when available)
- **Street View Static API** — provides the photos. Coverage (metadata) checks are free; each photo loaded counts as one billed image request.
- **Places API (New)** — optional, only for address autocomplete. Addresses can always be typed manually.

Best practice: create a dedicated browser key just for this site, restrict it by HTTP referrer to `cmlilley.github.io/*`, allow only the APIs listed above, and set a quota cap.

## Hosting

This is a single self-contained `index.html` with no build step and no backend — everything runs in the visitor's browser.

To host on GitHub Pages: repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**, then visit https://cmlilley.github.io/route-gif/.
