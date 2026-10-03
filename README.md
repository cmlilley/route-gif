# route-gif

Generates a GIF of what a Google Maps route looks like from Street View.

Open the site, paste your own Google Maps Platform API key, enter a start and destination, get directions, choose how many Street View photos to sample along the route, then generate and download the GIF.

**Live site:** https://cmlilley.github.io/route-gif/

## How to use

1. Paste your Google Maps Platform API key into the page. The key is never hardcoded in this repo, is never sent anywhere except Google, and is kept only in page memory for the session — you will need to paste it again after a reload.
2. Enter a start and a destination, then click **Get directions**. The route is drawn on the map with distance and drive time.
3. Use the slider to choose how many Street View images to get along the route (5–120, default 30).
4. Click to load the Street View photos. Points are sampled evenly along the route; each photo faces the direction of travel. Green dots have coverage, red dots do not.
5. Click **Generate GIF**, preview it, then click **Download route.gif**.

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
