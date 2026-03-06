// index.js - MovieBox Stremio addon (full file)
// Usage: BASE_URL=http://<your-ip>:7000 node index.js
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const http = require("http");
const https = require("https");

const PORT = parseInt(process.env.PORT || "7000", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`; // IMPORTANT: set to your device IP when testing with Stremio on another device

const CONFIG = {
  API_BASE: "https://h5-api.aoneroom.com",
  BFF: "/wefeed-h5api-bff",
  STREAM_HOST: "https://h5.aoneroom.com",
  STREAM_BFF: "/wefeed-h5-bff",
  PAGE_HOST: "h5.aoneroom.com",
  PH_IP: "112.198.0.1",
  PAGE_SIZE: 24,
  _cookies: null,
  _cookieFetchedAt: 0,
};

const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// --- Cookies
async function getCookies() {
  if (CONFIG._cookies !== null && (Date.now() - CONFIG._cookieFetchedAt < 30 * 60 * 1000))
    return CONFIG._cookies;
  try {
    const res = await axios.get(
      `${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
      { headers: { "User-Agent": "Mozilla/5.0", "X-Forwarded-For": CONFIG.PH_IP, "X-Real-IP": CONFIG.PH_IP, "CF-IPCountry": "PH" }, timeout: 10000 }
    );
    const setCookie = res.headers["set-cookie"] || [];
    CONFIG._cookies = setCookie.length > 0 ? setCookie.map(c => c.split(";")[0]).join("; ") : "";
    CONFIG._cookieFetchedAt = Date.now();
    console.log(`🍪 Cookies: ${CONFIG._cookies || "(none)"}`);
  } catch (err) {
    console.error("Cookie fetch failed:", err.message);
    CONFIG._cookies = "";
    CONFIG._cookieFetchedAt = Date.now();
  }
  return CONFIG._cookies;
}

// --- API helpers
const CATALOG_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  "Accept": "application/json",
  "Origin": "https://h5.aoneroom.com",
  "Referer": "https://h5.aoneroom.com/",
};

async function apiGet(endpoint, params = {}) {
  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
  const key = url + JSON.stringify(params);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await axios.get(url, { params: { host: CONFIG.PAGE_HOST, ...params }, headers: CATALOG_HEADERS, timeout: 15000 });
    if (res.data?.code !== 0) return null;
    cacheSet(key, res.data.data);
    return res.data.data;
  } catch (err) { console.error(`GET [${endpoint}]:`, err.message); return null; }
}

async function apiPost(endpoint, body = {}) {
  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
  const key = url + JSON.stringify(body);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await axios.post(url, { host: CONFIG.PAGE_HOST, ...body }, { headers: { ...CATALOG_HEADERS, "Content-Type": "application/json" }, timeout: 15000 });
    if (res.data?.code !== 0) return null;
    cacheSet(key, res.data.data);
    return res.data.data;
  } catch (err) { console.error(`POST [${endpoint}]:`, err.message); return null; }
}

// --- Resolve mirror / final URL (follows redirects up to a few hops)
async function resolveStreamUrl(url) {
  try {
    const r = await axios.get(url, {
      headers: { "Referer": "https://fmoviesunblocked.net/", "User-Agent": "Mozilla/5.0" },
      maxRedirects: 6,
      timeout: 15000,
      validateStatus: status => status >= 200 && status < 400
    });
    // axios exposes final URL differently across versions; robust attempt:
    const final = r.request?.res?.responseUrl || r.config?.url || url;
    return final;
  } catch (err) {
    // fallback to original
    return url;
  }
}

// --- Fetch streams (calls play API then resolves any mirror links)
async function fetchStreams(subjectId, se = 0, ep = 0, detailPath = "") {
  const key = `stream_${subjectId}_${se}_${ep}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const cookies = await getCookies();
  try {
    const res = await axios.get(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`, {
      params: { subjectId, se, ep },
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json", "Referer": `https://h5.aoneroom.com/movies/${detailPath || subjectId}`, "Cookie": cookies,
        "X-Forwarded-For": CONFIG.PH_IP, "X-Real-IP": CONFIG.PH_IP, "CF-IPCountry": "PH",
      },
      timeout: 15000
    });
    const d = res.data;
    if (d?.code !== 0) { console.error(`Stream error: ${d?.code} ${d?.reason}`); cacheSet(key, []); return []; }
    const streams = d?.data?.streams || [];
    const out = [];
    for (const s of streams) {
      if (!s.url) continue;
      // Try to resolve mirror to final CDN link
      const final = await resolveStreamUrl(s.url);
      out.push({ url: final, resolutions: s.resolutions, size: s.size });
    }
    cacheSet(key, out);
    return out;
  } catch (err) { console.error("Stream fetch failed:", err.message); cacheSet(key, []); return []; }
}

// --- Helpers for meta/catalog
const detailPathCache = new Map();
const itemCache = new Map();

function normalizePoster(url) {
  if (!url) return null;
  return url.startsWith("http") ? url : `https://pbcdnw.aoneroom.com${url}`;
}

function toMeta(item, type) {
  const subjectId = String(item.subjectId || "");
  if (item.detailPath) detailPathCache.set(subjectId, item.detailPath);
  itemCache.set(subjectId, item);
  return {
    id: `mbx_${type}_${subjectId}`, type,
    name: item.title || "Unknown",
    poster: normalizePoster(item.cover?.url || item.cover || item.coverUrl),
    background: normalizePoster(item.stills?.url),
    description: item.description || "",
    year: item.releaseDate ? parseInt(item.releaseDate.slice(0, 4)) : undefined,
    genres: item.genre ? item.genre.split(",").map(g => g.trim()) : [],
    imdbRating: item.imdbRatingValue || undefined,
    runtime: item.duration ? `${Math.round(item.duration / 60)} min` : undefined,
  };
}

function parseId(id) {
  const m = id.match(/^mbx_(movie|series)_(.+)$/);
  return m ? { type: m[1], subjectId: m[2] } : null;
}

// --- Manifest (include search/skip extras)
const manifest = {
  id: "community.movieboxph",
  version: "11.0.0",
  name: "MovieBox",
  description: "MovieBox — Movies & Series",
  logo: "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
  catalogs: [
    { type: "movie", id: "mbx_movies", name: "MovieBox Movies", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "mbx_series", name: "MovieBox Series", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
  ],
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["mbx_"],
};

const builder = new addonBuilder(manifest);

// --- Catalog handler (supports search + skip/paging)
const keywordRotation = ["the", "a", "man", "love", "war", "night", "dead", "dark", "last", "world"];

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const subjectType = type === "series" ? 2 : 1;
  const skip = parseInt(extra?.skip || 0);
  const page = Math.max(1, Math.floor(skip / CONFIG.PAGE_SIZE) + 1);
  let items = [];

  if (extra?.search) {
    const data = await apiPost("/subject/search", { keyword: extra.search, page: String(page), perPage: CONFIG.PAGE_SIZE });
    items = (data?.items || []).filter(i => i.subjectType === subjectType);
  } else if (type === "series") {
    const data = await apiGet("/subject/trending");
    items = (data?.subjectList || []).filter(i => i.subjectType === 2);
  } else {
    // movies: if trending fails, fallback to search rotation
    const data = await apiPost("/subject/search", { keyword: keywordRotation[(page - 1) % keywordRotation.length], page: String(page), perPage: CONFIG.PAGE_SIZE });
    items = (data?.items || []).filter(i => i.subjectType === 1);
  }

  const metas = items.filter(i => i.subjectId).map(i => toMeta(i, type));
  console.log(`✅ Catalog: type=${type} -> ${metas.length} items (page ${page})`);
  return { metas };
});

// --- Meta handler
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`🎬 Meta requested: ${id}`);
  const parsed = parseId(id);
  if (!parsed) return { meta: null };

  let item = itemCache.get(parsed.subjectId) || null;
  if (!item) {
    const trendData = await apiGet("/subject/trending");
    item = (trendData?.subjectList || []).find(i => String(i.subjectId) === parsed.subjectId) || null;
  }

  const meta = item ? toMeta(item, type) : { id, type, name: id };
  meta.id = id;

  // minimal episodes: leave empty or you can implement discoverEpisodes (heavy)
  if (type === "series") {
    meta.videos = []; // keep empty to avoid heavy discovery loop
  }

  return { meta };
});

// --- Stream handler (returns proxy URLs pointing to this server so headers are applied)
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`🔗 Stream request: ${id}`);
  const parts = id.split(":");
  const baseId = parts[0];
  const season = parts[1] !== undefined ? parseInt(parts[1]) : 0;
  const episode = parts[2] !== undefined ? parseInt(parts[2]) : 0;
  const parsed = parseId(baseId);
  if (!parsed) return { streams: [] };

  const detailPath = detailPathCache.get(parsed.subjectId) || "";
  const se = type === "movie" ? 0 : season;
  const ep = type === "movie" ? 0 : episode;

  const rawStreams = await fetchStreams(parsed.subjectId, se, ep, detailPath);
  if (!rawStreams.length) { console.warn("⚠️ No streams found for", id); return { streams: [] }; }

  const qualityOrder = { "1080": 0, "720": 1, "480": 2, "360": 3 };
  const streams = rawStreams
    .filter(s => s.url)
    .sort((a, b) => (qualityOrder[(a.resolutions || "").toString()] ?? 99) - (qualityOrder[(b.resolutions || "").toString()] ?? 99))
    .map(s => {
      const sizeMB = s.size ? ` · ${Math.round(parseInt(s.size || 0) / 1024 / 1024)}MB` : "";
      const quality = s.resolutions ? `${s.resolutions}p` : "HD";
      const directUrl = s.url;
      // Use proxy so we can set Referer/User-Agent and support range requests
      const proxyUrl = `${BASE_URL}/proxy?url=${encodeURIComponent(directUrl)}`;
      return {
        name: "MovieBox",
        title: quality + sizeMB,
        url: proxyUrl,
        externalUrl: directUrl,
        behaviorHints: { notWebReady: false, bingeGroup: `mbx-${parsed.subjectId}` }
      };
    });

  console.log(`✅ streams: ${streams.length} for ${id}`);
  return { streams };
});

// --- Proxy handler (same server) - supports range requests and forwards proper headers
const mainServer = http.createServer(async (req, res) => {
  try {
    if (!req.url) { res.writeHead(400); res.end("no url"); return; }
    const urlPath = req.url.split("?")[0];
    if (urlPath === "/proxy") {
      const q = new URL(req.url, `http://localhost`).searchParams;
      const target = q.get("url");
      if (!target) { res.writeHead(400); res.end("Missing url"); return; }

      const range = req.headers["range"] || "";
      console.log(`▶ Proxy ${range ? "[range] " : ""}${target.slice(0, 120)}`);

      const parsed = new URL(target);
      const lib = parsed.protocol === "https:" ? https : http;

      const proxyReq = lib.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "Referer": "https://fmoviesunblocked.net/",
          "Origin": "https://fmoviesunblocked.net",
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
          ...(range ? { "Range": range } : {}),
        }
      }, (proxyRes) => {
        const headers = {
          "Content-Type": proxyRes.headers["content-type"] || "video/mp4",
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        };
        if (proxyRes.headers["content-length"]) headers["Content-Length"] = proxyRes.headers["content-length"];
        if (proxyRes.headers["content-range"])  headers["Content-Range"]  = proxyRes.headers["content-range"];
        res.writeHead(proxyRes.statusCode || 200, headers);
        proxyRes.pipe(res, { end: true });
      });

      proxyReq.on("error", err => {
        console.error("Proxy error:", err.message);
        if (!res.headersSent) { res.writeHead(502); res.end("proxy error"); }
      });

      req.on("close", () => proxyReq.destroy());
      proxyReq.end();
      return;
    }

    // non-proxy path -> serve manifest endpoint via builder interface
    // The stremio addon server will handle /manifest.json, /catalog/*, /meta/*, /stream/*
    // We delegate everything to the stremio SDK listener by checking builder interface:
    // (we actually run builder via serveHTTP below; this extra server is here only to host proxy on same port)
    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error("Main server error:", err);
    if (!res.headersSent) { res.writeHead(500); res.end("server error"); }
  }
});

// Start the stremio SDK listener on same port and also start our main server listening on PORT
serveHTTP(builder.getInterface(), { port: PORT });
mainServer.listen(PORT);

console.log(`🎬 MovieBox addon running`);
console.log(`Manifest: ${BASE_URL}/manifest.json`);
console.log(`Note: set BASE_URL env var to your local IP (eg http://192.168.1.10:${PORT}) when testing with Stremio`);
