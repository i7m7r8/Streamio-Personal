const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
// 🔧 CONFIGURATION
// ============================================================
const CONFIG = {
  // moviebox.ph's internal API (intercepted from network traffic)
  API_BASE: "https://mbpapi.aoneroom.com",
  SITE_NAME: "MovieBox PH",
  SITE_LOGO: "https://pbcdnw.aoneroom.com/image/logo.webp",
  CDN_IMAGE: "https://pbcdnw.aoneroom.com",
  CDN_VIDEO: "https://macdn.aoneroom.com",
  PAGE_SIZE: 20,

  // API endpoints discovered via DevTools network interception
  ENDPOINTS: {
    LIST:   "/web/class-list",    // ?type=1 (movie) &type=2 (series) &page=N
    SEARCH: "/web/searchResult",  // ?keyword=xxx
    DETAIL: "/web/detail",        // ?id=xxx
    EPISODE:"/web/episode",       // ?id=xxx&season=N
    SOURCE: "/web/source",        // ?id=xxx (stream URLs)
  },

  HEADERS: {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://moviebox.ph",
    "Referer":         "https://moviebox.ph/",
  }
};

// Simple in-memory cache (5 min TTL)
const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ============================================================
// 📡 API CLIENT
// ============================================================
async function apiGet(endpoint, params = {}) {
  const cacheKey = endpoint + JSON.stringify(params);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = CONFIG.API_BASE + endpoint;
  try {
    const res = await axios.get(url, {
      params,
      headers: CONFIG.HEADERS,
      timeout: 15000
    });

    const data = res.data;
    // moviebox API wraps responses: { code: 0, data: { ... } }
    if (data?.code !== undefined && data.code !== 0) {
      console.error(`API error ${data.code}: ${data.msg || "unknown"}`);
      return null;
    }

    const result = data?.data ?? data;
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`❌ API call failed [${endpoint}]:`, err.message);
    return null;
  }
}

// ============================================================
// 🔄 DATA TRANSFORMERS
// ============================================================

function normalizePoster(raw) {
  if (!raw) return null;
  if (raw.startsWith("http")) return raw;
  if (raw.startsWith("/")) return CONFIG.CDN_IMAGE + raw;
  return raw;
}

// Convert API item → Stremio meta object
function toMeta(item, type) {
  const mbxId = item.id || item.videoId || item.movieId;
  const id = `mbx_${type}_${mbxId}`;

  return {
    id,
    type,
    name:        item.name || item.title || item.videoName || "Unknown",
    poster:      normalizePoster(item.coverVerticalUrl || item.poster || item.coverUrl),
    background:  normalizePoster(item.coverHorizontalUrl || item.backdrop),
    description: item.introduction || item.description || item.plot || "",
    year:        item.year ? parseInt(item.year) : undefined,
    genres:      Array.isArray(item.tagList) ? item.tagList.map(t => t.name || t) : [],
    imdbRating:  item.score ? String(item.score) : undefined,
    // Store raw mbxId for later lookups
    _mbxId:      mbxId,
    _slug:       item.slug || item.aliasName || "",
  };
}

// Parse "mbx_movie_12345" → { type, mbxId }
function parseStremioId(id) {
  const match = id.match(/^mbx_(movie|series)_(.+)$/);
  if (!match) return null;
  return { type: match[1], mbxId: match[2] };
}

// ============================================================
// 📦 MANIFEST
// ============================================================
const manifest = {
  id:          "community.movieboxph",
  version:     "2.0.0",
  name:        CONFIG.SITE_NAME,
  description: "Stream Movies & TV Series from MovieBox PH (API-based)",
  logo:        CONFIG.SITE_LOGO,
  catalogs: [
    {
      type: "movie",
      id:   "moviebox_movies",
      name: "MovieBox Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip",   isRequired: false }
      ]
    },
    {
      type: "series",
      id:   "moviebox_series",
      name: "MovieBox TV Series",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip",   isRequired: false }
      ]
    }
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

  const skip   = parseInt(extra?.skip || 0);
  const search = extra?.search || "";
  const page   = Math.floor(skip / CONFIG.PAGE_SIZE) + 1;

  // type=1 → movies, type=2 → series
  const contentType = type === "movie" ? 1 : 2;

  let items = [];

  if (search) {
    const data = await apiGet(CONFIG.ENDPOINTS.SEARCH, {
      keyword: search,
      type:    contentType,
      page,
      size:    CONFIG.PAGE_SIZE
    });

    // Handle various response shapes
    items = data?.list || data?.results || data?.videoList || data || [];
  } else {
    const data = await apiGet(CONFIG.ENDPOINTS.LIST, {
      type: contentType,
      page,
      size: CONFIG.PAGE_SIZE
    });

    items = data?.list || data?.results || data?.videoList || data || [];
  }

  if (!Array.isArray(items)) {
    console.warn("⚠️ Unexpected API response shape:", items);
    return { metas: [] };
  }

  const metas = items
    .filter(item => item && (item.id || item.videoId || item.movieId))
    .map(item => toMeta(item, type));

  console.log(`✅ Returning ${metas.length} items for catalog`);
  return { metas };
});

// ============================================================
// 🎬 META HANDLER
// ============================================================
builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`🎬 Meta: ${id}`);

  const parsed = parseStremioId(id);
  if (!parsed) return { meta: null };

  const data = await apiGet(CONFIG.ENDPOINTS.DETAIL, { id: parsed.mbxId });
  if (!data) return { meta: null };

  const meta = toMeta(data, type);

  // For series: fetch seasons/episodes
  if (type === "series") {
    const totalSeasons = data.seasonCount || data.totalSeasonNum || 1;
    meta.videos = [];

    for (let season = 1; season <= totalSeasons; season++) {
      const epData = await apiGet(CONFIG.ENDPOINTS.EPISODE, {
        id:     parsed.mbxId,
        season
      });

      const episodes = epData?.list || epData?.episodeList || epData || [];

      if (Array.isArray(episodes)) {
        episodes.forEach(ep => {
          const epNum = ep.episode || ep.episodeNum || ep.num || ep.index;
          meta.videos.push({
            id:       `${id}:${season}:${epNum}`,
            title:    ep.name || ep.title || `S${season}E${epNum}`,
            season,
            episode:  epNum,
            released: ep.publishTime || ep.releaseDate || undefined,
            thumbnail:normalizePoster(ep.cover || ep.thumb),
            overview: ep.introduction || ep.description || "",
          });
        });
      }
    }
  }

  return { meta };
});

// ============================================================
// 🔗 STREAM HANDLER
// ============================================================
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`🔗 Stream: ${id}`);

  // id format for series: "mbx_series_12345:1:3" (season:episode)
  const parts   = id.split(":");
  const baseId  = parts[0];
  const season  = parts[1] ? parseInt(parts[1]) : undefined;
  const episode = parts[2] ? parseInt(parts[2]) : undefined;

  const parsed = parseStremioId(baseId);
  if (!parsed) return { streams: [] };

  // Fetch source URLs
  const sourceParams = { id: parsed.mbxId };
  if (season  !== undefined) sourceParams.season  = season;
  if (episode !== undefined) sourceParams.episode = episode;

  const sourceData = await apiGet(CONFIG.ENDPOINTS.SOURCE, sourceParams);
  if (!sourceData) return { streams: [] };

  const streams = [];

  // Handle various stream payload shapes
  const mediaList = sourceData?.mediaList
    || sourceData?.streamList
    || sourceData?.urlList
    || (sourceData?.url ? [sourceData] : []);

  if (Array.isArray(mediaList)) {
    for (const media of mediaList) {
      const streamUrl = media.url || media.streamUrl || media.playUrl;
      if (!streamUrl) continue;

      const quality = media.quality || media.definition || media.label || "HD";

      streams.push({
        url:   streamUrl,
        title: `MovieBox PH — ${quality}`,
        name:  `MovieBox`,
        behaviorHints: {
          notWebReady: false,
          bingeGroup:  `movieboxph-${parsed.mbxId}`
        }
      });
    }
  }

  // Direct URL fallback
  if (streams.length === 0) {
    const directUrl = sourceData?.url || sourceData?.playUrl || sourceData?.streamUrl;
    if (directUrl) {
      streams.push({
        url:   directUrl,
        title: "MovieBox PH",
        name:  "MovieBox",
        behaviorHints: { notWebReady: false }
      });
    }
  }

  console.log(`✅ Found ${streams.length} streams`);
  return { streams };
});

// ============================================================
// 🚀 START SERVER
// ============================================================
const PORT = process.env.PORT || 7000;

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`
🎬 MovieBox PH Stremio Addon running!
📡 Manifest: http://localhost:${PORT}/manifest.json
🔗 Install:  stremio://localhost:${PORT}/manifest.json
`);


