# MovieBox PH — Stremio Addon v2

API-based addon (no cheerio/puppeteer needed).

## Setup

```bash
npm install
npm start
```

Then install in Stremio:
```
stremio://localhost:7000/manifest.json
```

---

## ⚠️ API Endpoint Verification (Important)

The API base URL and endpoints are **educated guesses** based on CDN domain patterns.
You MUST verify them with your browser's DevTools before the addon will work.

### How to find the real API endpoints:

1. Open **Chrome/Firefox DevTools** (F12)
2. Go to the **Network** tab → filter by **Fetch/XHR**
3. Visit `https://moviebox.ph` and browse movies
4. Look for JSON API calls — they'll contain movie data
5. Note the **Request URL** and **query parameters**

### What to update in `index.js`:

| Config Key        | What to change                          |
|-------------------|-----------------------------------------|
| `CONFIG.API_BASE` | The base domain of their API            |
| `ENDPOINTS.LIST`  | Path for movie/series listings          |
| `ENDPOINTS.SEARCH`| Path for search                         |
| `ENDPOINTS.DETAIL`| Path for individual movie/show detail   |
| `ENDPOINTS.EPISODE`| Path for episode list (series only)   |
| `ENDPOINTS.SOURCE`| Path that returns stream/video URLs     |

### Response shape adaptation

If the API returns data in a different shape than expected, update the
fallback chains in the handlers. Example in catalog handler:

```js
items = data?.list || data?.results || data?.videoList || data || [];
```

Add your observed key to this chain.

---

## Caching

Responses are cached in-memory for 5 minutes to avoid hammering the API.
Increase TTL in the `cacheGet` function if needed.

## Environment Variables

| Variable | Default | Description        |
|----------|---------|--------------------|
| `PORT`   | 7000    | HTTP server port   |
