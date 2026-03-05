const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

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

// ── Cache (5 min TTL) ──────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Cookie management ──────────────────────────────────────
async function getCookies() {
  if (CONFIG._cookies !== null && (Date.now() - CONFIG._cookieFetchedAt < 30 * 60 * 1000)) {
    return CONFIG._cookies;
  }
  try {
    const res = await axios.get(
      `${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
          "Accept": "application/json",
          "X-Forwarded-For": CONFIG.PH_IP,
          "X-Real-IP": CONFIG.PH_IP,
          "CF-IPCountry": "PH",
        },
        timeout: 10000,
      }
    );
    const setCookie = res.headers["set-cookie"] || [];
    CONFIG._cookies = setCookie.length > 0
      ? setCookie.map(c => c.split(";")[0]).join("; ")
      : "";
    CONFIG._cookieFetchedAt = Date.now();
    console.log(`🍪 Cookies: ${CONFIG._cookies || "(none)"}`);
  } catch (err) {
    console.error("❌ Cookie fetch failed:", err.message);
    CONFIG._cookies = "";
  }
  return CONFIG._cookies;
}

// ── Catalog API client (h5-api.aoneroom.com) ───────────────
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
    const res = await axios.get(url, {
      params: { host: CONFIG.PAGE_HOST, ...params },
      headers: CATALOG_HEADERS,
      timeout: 15000
    });
    if (res.data?.code !== 0) return null;
    cacheSet(key, res.data.data);
    return res.data.data;
  } catch (err) {
    console.error(`❌ GET [${endpoint}]:`, err.message);
    return null;
  }
}

async function apiPost(endpoint, body = {}) {
  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
  const key = url + JSON.stringify(body);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await axios.post(url, { host: CONFIG.PAGE_HOST, ...body }, {
      headers: { ...CATALOG_HEADERS, "Content-Type": "application/json" },
      timeout: 15000
    });
    if (res.data?.code !== 0) return null;
    cacheSet(key, res.data.data);
    return res.data.data;
  } catch (err) {
    console.error(`❌ POST [${endpoint}]:`, err.message);
    return null;
  }
}

// ── Stream API client (h5.aoneroom.com) ───────────────────
async function fetchStreams(subjectId, detailPath, se, ep) {
  const key = `stream_${subjectId}_${se}_${ep}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const cookies = await getCookies();
  const params  = { subjectId, se, ep };
  const referer = `https://h5.aoneroom.com/movies/${detailPath || subjectId}`;

  try {
    const res = await axios.get(
      `${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`,
      {
        params,
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
          "Accept": "application/json",
          "Referer": referer,
          "Cookie": cookies,
          "X-Forwarded-For": CONFIG.PH_IP,
          "X-Real-IP": CONFIG.PH_IP,
          "CF-IPCountry": "PH",
        },
        timeout: 15000
      }
    );
    const d = res.data;
    if (d?.code !== 0) {
      console.error(`❌ Stream error: code=${d?.code} ${d?.reason} ${d?.message}`);
      return [];
    }
    const streams = d?.data?.streams || [];
    cacheSet(key, streams);
    return streams;
  } catch (err) {
    console.error("❌ Stream fetch failed:", err.message);
    return [];
  }
}

// ── Helpers ────────────────────────────────────────────────
const detailPathCache = new Map();
const itemCache = new Map(); // subjectId -> full item object

function normalizePoster(url) {
  if (!url) return null;
  return url.startsWith("http") ? url : `https://pbcdnw.aoneroom.com${url}`;
}

function toMeta(item, type) {
  const subjectId = String(item.subjectId || "");
  if (item.detailPath) detailPathCache.set(subjectId, item.detailPath);
  itemCache.set(subjectId, item); // cache for meta lookups
  return {
    id:         `mbx_${type}_${subjectId}`,
    type,
    name:       item.title || "Unknown",
    poster:     normalizePoster(item.cover?.url),
    background: normalizePoster(item.stills?.url),
    description: item.description || "",
    year:       item.releaseDate ? parseInt(item.releaseDate.slice(0, 4)) : undefined,
    genres:     item.genre ? item.genre.split(",").map(g => g.trim()) : [],
    imdbRating: item.imdbRatingValue || undefined,
    runtime:    item.duration ? `${Math.round(item.duration / 60)} min` : undefined,
  };
}

function parseId(id) {
  const m = id.match(/^mbx_(movie|series)_(.+)$/);
  return m ? { type: m[1], subjectId: m[2] } : null;
}

// ── Manifest ───────────────────────────────────────────────
const manifest = {
  id:          "community.movieboxph",
  version:     "5.0.0",
  name:        "MovieBox",
  description: "MovieBox — Movies & Series with direct MP4 streams",
  logo:        "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
  catalogs: [
    { type: "movie",  id: "mbx_movies",  name: "MovieBox Movies",
      extra: [{ name: "search" }, { name: "skip" }] },
    { type: "series", id: "mbx_series",  name: "MovieBox Series",
      extra: [{ name: "search" }, { name: "skip" }] },
  ],
  resources:  ["catalog", "meta", "stream"],
  types:      ["movie", "series"],
  idPrefixes: ["mbx_"]
};

const builder = new addonBuilder(manifest);

// ── Catalog ────────────────────────────────────────────────
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`📋 Catalog type=${type} id=${id}`, extra);
  const search      = extra?.search || "";
  const skip        = parseInt(extra?.skip || 0);
  const page        = Math.floor(skip / CONFIG.PAGE_SIZE) + 1;
  const subjectType = type === "series" ? 2 : 1;

  let items = [];

  if (search) {
    const data = await apiPost("/subject/search", {
      keyword: search, page: String(page), perPage: CONFIG.PAGE_SIZE,
    });
    items = (data?.items || []).filter(i => i.subjectType === subjectType);
  } else {
    const data = await apiGet("/subject/trending");
    items = (data?.subjectList || []).filter(i => i.subjectType === subjectType);
  }

  const metas = items.filter(i => i.subjectId).map(i => toMeta(i, type));
  console.log(`✅ ${metas.length} items`);
  return { metas };
});

// ── Meta ───────────────────────────────────────────────────
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`🎬 Meta: ${id}`);
  const parsed = parseId(id);
  if (!parsed) return { meta: null };

  // Try to find item: check itemCache first (populated by catalog), then trending, then search
  let item = itemCache.get(parsed.subjectId) || null;

  // 2) Check trending
  if (!item) {
    const trendData = await apiGet("/subject/trending");
    const trendList = trendData?.subjectList || [];
    item = trendList.find(i => String(i.subjectId) === parsed.subjectId) || null;
  }

  // 3) Fallback: minimal meta so streams still work
  if (!item) {
    console.warn(`No item found for ${parsed.subjectId}, using minimal meta`);
    const meta = { id, type, name: id };
    if (type === "series") {
      meta.videos = [];
      for (let ep = 1; ep <= 30; ep++)
        meta.videos.push({ id: `${id}:1:${ep}`, title: `S1E${ep}`, season: 1, episode: ep });
    }
    return { meta };
  }

  const meta = toMeta(item, type);
  meta.id = id;

  if (type === "series") {
    meta.videos = [];
    const maxSeason = Math.max(item.season || 1, 1);
    for (let s = 1; s <= maxSeason; s++)
      for (let ep = 1; ep <= 30; ep++)
        meta.videos.push({ id: `${id}:${s}:${ep}`, title: `S${s}E${ep}`, season: s, episode: ep });
  }

  console.log(`Meta OK: ${meta.name}`);
  return { meta };
});

// ── Stream ─────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`🔗 Stream: ${id}`);

  const parts   = id.split(":");
  const baseId  = parts[0];
  const season  = parts[1] !== undefined ? parseInt(parts[1]) : 0;
  const episode = parts[2] !== undefined ? parseInt(parts[2]) : 0;

  const parsed = parseId(baseId);
  if (!parsed) return { streams: [] };

  const detailPath = detailPathCache.get(parsed.subjectId) || "";
  const se = type === "movie" ? 0 : season;
  const ep = type === "movie" ? 0 : episode;

  const rawStreams = await fetchStreams(parsed.subjectId, detailPath, se, ep);

  if (!rawStreams.length) {
    console.warn("⚠️ No streams");
    return { streams: [] };
  }

  const qualityOrder = { "1080": 0, "720": 1, "480": 2, "360": 3 };
  const streams = rawStreams
    .filter(s => s.url)
    .sort((a, b) => (qualityOrder[a.resolutions] ?? 99) - (qualityOrder[b.resolutions] ?? 99))
    .map(s => ({
      url:   s.url,
      name:  "MovieBox",
      title: `${s.resolutions ? s.resolutions + "p" : "HD"}${s.size ? " · " + Math.round(parseInt(s.size)/1024/1024) + "MB" : ""}`,
      behaviorHints: { notWebReady: false, bingeGroup: `mbx-${parsed.subjectId}` }
    }));

  console.log(`✅ ${streams.length} streams`);
  return { streams };
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
getCookies(); // warm up cookies on boot
console.log(`\n🎬 MovieBox v5\n📡 http://localhost:${PORT}/manifest.json\n`);
