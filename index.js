const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
// 🔧 CONFIGURATION — fully verified
// ============================================================
const CONFIG = {
  // BFF for catalog/search/trending (requires host param)
  API_BASE:  "https://h5-api.aoneroom.com",
  BFF:       "/wefeed-h5api-bff",
  PAGE_HOST: "h5.aoneroom.com",

  // Stream API (different host, requires cookies + region spoof)
  STREAM_HOST: "https://h5.aoneroom.com",
  STREAM_BFF:  "/wefeed-h5-bff",

  PAGE_SIZE: 24,

  // Philippines IP for region bypass
  PH_IP: "112.198.0.1",

  // Cookie cache
  _cookies: null,
  _cookieFetchedAt: 0,
};

// ============================================================
// 💾 CACHE (5 min TTL)
// ============================================================
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ============================================================
// 🍪 COOKIE MANAGEMENT
// Get cookies from app-info endpoint (required for stream API)
// ============================================================
async function getCookies() {
  // Refresh cookies every 30 minutes
  if (CONFIG._cookies && (Date.now() - CONFIG._cookieFetchedAt < 30 * 60 * 1000)) {
    return CONFIG._cookies;
  }
  try {
    const url = `${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`;
    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        "Accept": "application/json",
        "X-Forwarded-For": CONFIG.PH_IP,
        "X-Real-IP": CONFIG.PH_IP,
        "CF-IPCountry": "PH",
      },
      timeout: 10000,
    });
    // Extract Set-Cookie headers
    const setCookie = res.headers["set-cookie"] || [];
    if (setCookie.length > 0) {
      CONFIG._cookies = setCookie.map(c => c.split(";")[0]).join("; ");
    } else {
      CONFIG._cookies = "";
    }
    CONFIG._cookieFetchedAt = Date.now();
    console.log(`🍪 Cookies refreshed: ${CONFIG._cookies || "(none)"}`);
    return CONFIG._cookies;
  } catch (err) {
    console.error("❌ Cookie fetch failed:", err.message);
    return "";
  }
}

// ============================================================
// 📡 API CLIENT — Catalog/Search (h5-api.aoneroom.com)
// ============================================================
async function apiGet(endpoint, params = {}) {
  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
  const key = url + JSON.stringify(params);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await axios.get(url, {
      params: { host: CONFIG.PAGE_HOST, ...params },
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://h5.aoneroom.com",
        "Referer": "https://h5.aoneroom.com/",
      },
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
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://h5.aoneroom.com",
        "Referer": "https://h5.aoneroom.com/",
      },
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

// ============================================================
// 🔗 STREAM CLIENT — (h5.aoneroom.com with cookies + PH IP)
// ============================================================
async function getStreams(subjectId, detailPath, season, episode) {
  const cacheKey = `stream_${subjectId}_${season}_${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const cookies = await getCookies();

  const params = { subjectId };
  if (season  !== undefined && season  !== null) params.se = season;
  if (episode !== undefined && episode !== null) params.ep = episode;

  const url = `${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`;
  const referer = `https://h5.aoneroom.com/movies/${detailPath || subjectId}`;

  try {
    const res = await axios.get(url, {
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
    });

    const data = res.data;
    if (data?.code !== 0) {
      console.error(`❌ Stream API error: code=${data?.code} reason=${data?.reason} message=${data?.message}`);
      return [];
    }

    const streams = data?.data?.streams || [];
    cacheSet(cacheKey, streams);
    return streams;
  } catch (err) {
    console.error(`❌ Stream fetch failed:`, err.message);
    return [];
  }
}

// ============================================================
// 🔄 DATA TRANSFORMERS
// ============================================================
function normalizePoster(raw) {
  if (!raw) return null;
  if (raw.startsWith("http")) return raw;
  return "https://pbcdnw.aoneroom.com" + raw;
}

function toMeta(item, forceType) {
  const subjectId = String(item.subjectId || item.id || "");
  const type = forceType || (item.subjectType === 2 ? "series" : "movie");
  return {
    id:          `mbx_${type}_${subjectId}`,
    type,
    name:        item.title || "Unknown",
    poster:      normalizePoster(item.cover?.url),
    background:  normalizePoster(item.stills?.url),
    description: item.description || "",
    year:        item.releaseDate ? parseInt(item.releaseDate.slice(0, 4)) : undefined,
    genres:      item.genre ? item.genre.split(",").map(g => g.trim()) : [],
    imdbRating:  item.imdbRatingValue || undefined,
    runtime:     item.duration ? `${Math.round(item.duration / 60)} min` : undefined,
    // stored for stream lookups
    _subjectId:  subjectId,
    _detailPath: item.detailPath || "",
  };
}

// Store detailPath per subjectId for stream lookups
const detailPathCache = new Map();

function parseStremioId(id) {
  const match = id.match(/^mbx_(movie|series)_(.+)$/);
  if (!match) return null;
  return { type: match[1], subjectId: match[2] };
}

// ============================================================
// 📦 MANIFEST
// ============================================================
const manifest = {
  id:          "community.movieboxph",
  version:     "5.0.0",
  name:        "MovieBox",
  description: "MovieBox — Movies & TV Series with working streams",
  logo:        "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
  catalogs: [
    {
      type: "movie",
      id:   "mbx_trending_movies",
      name: "MovieBox Trending",
      extra: [{ name: "search", isRequired: false }]
    },
    {
      type: "series",
      id:   "mbx_trending_series",
      name: "MovieBox Trending Series",
      extra: [{ name: "search", isRequired: false }]
    },
  ],
  resources:  ["catalog", "meta", "stream"],
  types:      ["movie", "series"],
  idPrefixes: ["mbx_"]
};

const builder = new addonBuilder(manifest);

// ============================================================
// 📋 CATALOG HANDLER
// ============================================================
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`📋 Catalog: type=${type} id=${id}`, extra);

  const search = extra?.search || "";
  const skip   = parseInt(extra?.skip || 0);
  const page   = Math.floor(skip / CONFIG.PAGE_SIZE) + 1;
  const subjectType = type === "series" ? 2 : 1;

  let items = [];

  if (search) {
    const data = await apiPost("/subject/search", {
      keyword:     search,
      page:        String(page),
      perPage:     CONFIG.PAGE_SIZE,
    });
    items = (data?.items || []).filter(i => i.subjectType === subjectType);
  } else {
    // Use trending for browse
    const data = await apiGet("/subject/trending");
    items = (data?.subjectList || []).filter(i => i.subjectType === subjectType);
  }

  // Cache detailPaths
  items.forEach(i => {
    if (i.subjectId && i.detailPath) {
      detailPathCache.set(String(i.subjectId), i.detailPath);
    }
  });

  const metas = items.filter(i => i.subjectId).map(i => toMeta(i, type));
  console.log(`✅ Returning ${metas.length} items`);
  return { metas };
});

// ============================================================
// 🎬 META HANDLER
// ============================================================
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`🎬 Meta: ${id}`);
  const parsed = parseStremioId(id);
  if (!parsed) return { meta: null };

  // Use trending to find item details (search by id)
  const data = await apiPost("/subject/search", {
    keyword: parsed.subjectId,
    page: "1",
    perPage: 5,
  });

  const items = data?.items || [];
  const item = items.find(i => String(i.subjectId) === parsed.subjectId) || items[0];
  if (!item) return { meta: null };

  if (item.detailPath) detailPathCache.set(parsed.subjectId, item.detailPath);

  const meta = toMeta(item, type);

  // For series, build basic episode list from totalEpisode
  if (type === "series") {
    meta.videos = [];
    const totalEps = item.totalEpisode || item.episodeCount || 12;
    const season = item.season || 1;
    for (let ep = 1; ep <= Math.min(totalEps, 50); ep++) {
      meta.videos.push({
        id:      `${id}:${season}:${ep}`,
        title:   `S${season}E${ep}`,
        season,
        episode: ep,
      });
    }
  }

  return { meta };
});

// ============================================================
// 🔗 STREAM HANDLER
// ============================================================
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`🔗 Stream: ${id}`);

  const parts     = id.split(":");
  const baseId    = parts[0];
  const season    = parts[1] !== undefined ? parseInt(parts[1]) : 0;
  const episode   = parts[2] !== undefined ? parseInt(parts[2]) : 0;

  const parsed = parseStremioId(baseId);
  if (!parsed) return { streams: [] };

  const detailPath = detailPathCache.get(parsed.subjectId) || "";

  // Movies use se=0&ep=0, series use actual season/episode
  const se = type === "movie" ? 0 : season;
  const ep = type === "movie" ? 0 : episode;

  const rawStreams = await getStreams(parsed.subjectId, detailPath, se, ep);

  if (!rawStreams || rawStreams.length === 0) {
    console.warn("⚠️ No streams returned");
    return { streams: [] };
  }

  const qualityOrder = { "1080": 0, "720": 1, "480": 2, "360": 3 };

  const streams = rawStreams
    .sort((a, b) => (qualityOrder[a.resolutions] ?? 99) - (qualityOrder[b.resolutions] ?? 99))
    .map(s => {
      const sizeMB = s.size ? ` · ${Math.round(parseInt(s.size) / 1024 / 1024)}MB` : "";
      const quality = s.resolutions ? `${s.resolutions}p` : "HD";
      return {
        url:   s.url,
        name:  "MovieBox",
        title: `${quality}${sizeMB}`,
        behaviorHints: {
          notWebReady: false,
          bingeGroup:  `mbx-${parsed.subjectId}`
        }
      };
    });

  console.log(`✅ Found ${streams.length} streams for ${id}`);
  return { streams };
});

// ============================================================
// 🚀 START — also prefetch cookies on boot
// ============================================================
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
getCookies(); // warm up cookies immediately
console.log(`
🎬 MovieBox Stremio Addon v5 running!
📡 Manifest: http://localhost:${PORT}/manifest.json
`);
