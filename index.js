const axios = require("axios");
const http = require("http");
const https = require("https");

const CONFIG = {
  API_BASE:    "https://h5-api.aoneroom.com",
  BFF:         "/wefeed-h5api-bff",
  PAGE_HOST:   "h5.aoneroom.com",
  STREAM_HOST: "https://h5.aoneroom.com",
  STREAM_BFF:  "/wefeed-h5-bff",
  PAGE_SIZE:   24,
  PH_IP:       "112.198.0.1",
  _cookies:    null,
  _cookieFetchedAt: 0,
};

const PORT = process.env.PORT || 7000;

// ── Cache ──────────────────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Cookies ────────────────────────────────────────────────
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
  }
  return CONFIG._cookies;
}

// ── Catalog API ────────────────────────────────────────────
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

// ── Stream API ─────────────────────────────────────────────
async function fetchStreams(subjectId, detailPath, se, ep) {
  const key = `stream_${subjectId}_${se}_${ep}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const cookies = await getCookies();
  const referer = `https://h5.aoneroom.com/movies/${detailPath || subjectId}`;
  try {
    const res = await axios.get(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`, {
      params: { subjectId, se, ep },
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        "Accept": "application/json", "Referer": referer, "Cookie": cookies,
        "X-Forwarded-For": CONFIG.PH_IP, "X-Real-IP": CONFIG.PH_IP, "CF-IPCountry": "PH",
      },
      timeout: 15000
    });
    const d = res.data;
    if (d?.code !== 0) { console.error(`Stream error: ${d?.code} ${d?.reason}`); return []; }
    const streams = d?.data?.streams || [];
    cacheSet(key, streams);
    return streams;
  } catch (err) { console.error("Stream fetch failed:", err.message); return []; }
}

// ── Episode discovery ─────────────────────────────────────
const episodeCountCache = new Map();
async function discoverEpisodes(subjectId, detailPath) {
  const cacheKey = `eps_${subjectId}`;
  const cached = episodeCountCache.get(cacheKey);
  if (cached) return cached;
  const result = {};
  for (let s = 1; s <= 10; s++) {
    const firstEp = await fetchStreams(subjectId, detailPath, s, 1);
    if (!firstEp || firstEp.length === 0) break;
    let lastEp = 1;
    for (let e = 2; e <= 60; e++) {
      const ep = await fetchStreams(subjectId, detailPath, s, e);
      if (!ep || ep.length === 0) break;
      lastEp = e;
    }
    result[s] = lastEp;
  }
  if (Object.keys(result).length === 0) result[1] = 1;
  episodeCountCache.set(cacheKey, result);
  console.log(`📺 Episodes for ${subjectId}:`, result);
  return result;
}

// ── Helpers ────────────────────────────────────────────────
const detailPathCache = new Map();
const itemCache = new Map();

function normalizePoster(url) {
  if (!url) return null;
  return url.startsWith("http") ? url : `https://pbcdnw.aoneroom.com${url}`;
}

function toStremioMeta(item, type) {
  const subjectId = String(item.subjectId || "");
  if (item.detailPath) detailPathCache.set(subjectId, item.detailPath);
  itemCache.set(subjectId, item);
  return {
    id: `mbx_${type}_${subjectId}`, type,
    name: item.title || "Unknown",
    poster: normalizePoster(item.cover?.url),
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

function jsonResp(res, data) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

// ── Route handlers ─────────────────────────────────────────
async function handleManifest(res) {
  jsonResp(res, {
    id: "community.movieboxph", version: "7.0.0",
    name: "MovieBox", description: "MovieBox — Movies & Series",
    logo: "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
    catalogs: [
      { type: "movie",  id: "mbx_movies", name: "MovieBox Movies",
        extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
      { type: "series", id: "mbx_series", name: "MovieBox Series",
        extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    ],
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["mbx_"],
    behaviorHints: { adult: false, p2p: false },
  });
}

async function handleCatalog(type, extra, res) {
  console.log(`📋 Catalog type=${type}`, extra.search ? `search=${extra.search}` : "trending");
  const subjectType = type === "series" ? 2 : 1;
  const skip = parseInt(extra.skip || 0);
  const page = Math.floor(skip / CONFIG.PAGE_SIZE) + 1;
  let items = [];
  if (extra.search) {
    const data = await apiPost("/subject/search", { keyword: extra.search, page: String(page), perPage: CONFIG.PAGE_SIZE });
    items = (data?.items || []).filter(i => i.subjectType === subjectType);
  } else {
    const data = await apiGet("/subject/trending");
    items = (data?.subjectList || []).filter(i => i.subjectType === subjectType);
  }
  const metas = items.filter(i => i.subjectId).map(i => toStremioMeta(i, type));
  console.log(`✅ ${metas.length} items`);
  jsonResp(res, { metas });
}

async function handleMeta(type, id, res) {
  console.log(`🎬 Meta: ${id}`);
  const parsed = parseId(id);
  if (!parsed) { jsonResp(res, { meta: null }); return; }

  let item = itemCache.get(parsed.subjectId) || null;
  if (!item) {
    const trendData = await apiGet("/subject/trending");
    item = (trendData?.subjectList || []).find(i => String(i.subjectId) === parsed.subjectId) || null;
  }

  const meta = item ? toStremioMeta(item, type) : { id, type, name: id };
  meta.id = id;

  if (type === "series") {
    const detailPath = detailPathCache.get(parsed.subjectId) || "";
    const episodeMap = await discoverEpisodes(parsed.subjectId, detailPath);
    meta.videos = [];
    for (const [season, epCount] of Object.entries(episodeMap)) {
      const s = parseInt(season);
      for (let ep = 1; ep <= epCount; ep++) {
        meta.videos.push({ id: `${id}:${s}:${ep}`, title: `S${s}E${ep}`, season: s, episode: ep, released: new Date(0).toISOString() });
      }
    }
    console.log(`📺 ${meta.videos.length} episodes for ${meta.name || id}`);
  }
  jsonResp(res, { meta });
}

async function handleStream(type, id, res) {
  console.log(`🔗 Stream: ${id}`);
  const parts = id.split(":");
  const baseId = parts[0];
  const season = parts[1] !== undefined ? parseInt(parts[1]) : 0;
  const episode = parts[2] !== undefined ? parseInt(parts[2]) : 0;
  const parsed = parseId(baseId);
  if (!parsed) { jsonResp(res, { streams: [] }); return; }

  const detailPath = detailPathCache.get(parsed.subjectId) || "";
  const se = type === "movie" ? 0 : season;
  const ep = type === "movie" ? 0 : episode;

  const rawStreams = await fetchStreams(parsed.subjectId, detailPath, se, ep);
  if (!rawStreams.length) { console.warn("⚠️ No streams"); jsonResp(res, { streams: [] }); return; }

  const qualityOrder = { "1080": 0, "720": 1, "480": 2, "360": 3 };
  const streams = rawStreams
    .filter(s => s.url)
    .sort((a, b) => (qualityOrder[a.resolutions] ?? 99) - (qualityOrder[b.resolutions] ?? 99))
    .map(s => ({
      url: `http://127.0.0.1:${PORT}/proxy?url=${encodeURIComponent(s.url)}`,
      name: "MovieBox",
      title: `${s.resolutions ? s.resolutions + "p" : "HD"}${s.size ? " · " + Math.round(parseInt(s.size) / 1024 / 1024) + "MB" : ""}`,
      behaviorHints: { notWebReady: false, bingeGroup: `mbx-${parsed.subjectId}` }
    }));

  console.log(`✅ ${streams.length} streams`);
  jsonResp(res, { streams });
}

function handleProxy(targetUrl, req, res) {
  console.log(`🎥 Proxy: ${targetUrl.slice(0, 70)}...`);
  const parsed = new URL(targetUrl);
  const lib = parsed.protocol === "https:" ? https : http;
  const proxyReq = lib.request({
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: "GET",
    headers: {
      "Referer": "https://fmoviesunblocked.net/",
      "Origin": "https://fmoviesunblocked.net",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
      "Range": req.headers["range"] || "",
    }
  }, (proxyRes) => {
    const headers = {
      "Content-Type": proxyRes.headers["content-type"] || "video/mp4",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    };
    if (proxyRes.headers["content-length"]) headers["Content-Length"] = proxyRes.headers["content-length"];
    if (proxyRes.headers["content-range"])  headers["Content-Range"]  = proxyRes.headers["content-range"];
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", err => { console.error("Proxy error:", err.message); res.writeHead(500); res.end(); });
  proxyReq.end();
}

// ── HTTP Server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const rawUrl = req.url || "/";
  const qIdx = rawUrl.indexOf("?");
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const qs = qIdx >= 0 ? new URLSearchParams(rawUrl.slice(qIdx + 1)) : new URLSearchParams();

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
    res.end(); return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    // Proxy
    if (pathname === "/proxy" && qs.get("url")) {
      handleProxy(qs.get("url"), req, res); return;
    }

    // Manifest
    if (pathname === "/manifest.json" || pathname === "/") {
      await handleManifest(res); return;
    }

    // Catalog: /:type/catalog/:catalogId.json  or  /:type/catalog/:catalogId/:extra.json
    const catalogMatch = pathname.match(/^\/(movie|series)\/catalog\/[^/]+(?:\/([^/]+))?\.json$/);
    if (catalogMatch) {
      const type = catalogMatch[1];
      const extraStr = catalogMatch[2] || "";
      const extra = {};
      if (extraStr) {
        extraStr.split("&").forEach(part => {
          const [k, v] = part.split("=");
          if (k) extra[decodeURIComponent(k)] = decodeURIComponent(v || "");
        });
      }
      // Also check query params
      if (qs.get("search")) extra.search = qs.get("search");
      if (qs.get("skip")) extra.skip = qs.get("skip");
      await handleCatalog(type, extra, res); return;
    }

    // Meta: /:type/meta/:id.json
    const metaMatch = pathname.match(/^\/(movie|series)\/meta\/(.+)\.json$/);
    if (metaMatch) {
      await handleMeta(metaMatch[1], metaMatch[2], res); return;
    }

    // Stream: /:type/stream/:id.json
    const streamMatch = pathname.match(/^\/(movie|series)\/stream\/(.+)\.json$/);
    if (streamMatch) {
      await handleStream(streamMatch[1], streamMatch[2], res); return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", path: pathname }));

  } catch (err) {
    console.error("Handler error:", err);
    res.writeHead(500); res.end("Server error");
  }
});

server.listen(PORT, () => {
  getCookies();
  console.log(`\n🎬 MovieBox v7\n📡 http://localhost:${PORT}/manifest.json\n`);
});
