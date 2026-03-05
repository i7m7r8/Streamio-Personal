const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
// 🔧 CONFIGURATION — verified from moviebox-api1 source
// ============================================================
const CONFIG = {
  // Real API host (confirmed: h5.aoneroom.com)
  API_BASE: "https://h5.aoneroom.com",

  SITE_NAME: "MovieBox PH",
  SITE_LOGO: "https://pbcdnw.aoneroom.com/image/logo.webp",
  CDN_IMAGE: "https://pbcdnw.aoneroom.com",
  CDN_VIDEO: "https://valiw.hakunaymatata.com",  // confirmed video CDN
  PAGE_SIZE: 20,

  // Real endpoints (confirmed from moviebox-api1)
  ENDPOINTS: {
    SEARCH:   "/api/search",    // + /:query
    INFO:     "/api/info",      // + /:movieId
    SOURCES:  "/api/sources",   // + /:movieId?season=N&episode=N
    HOME:     "/api/homepage",
    TRENDING: "/api/trending",
  },

  // Mobile app headers for authentic access (confirmed technique)
  HEADERS: {
    "User-Agent":      "okhttp/4.12.0",
    "Accept":          "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://moviebox.ph",
    "Referer":         "https://moviebox.ph/",
    // IP spoofing headers for region bypass
    "X-Forwarded-For": "1.1.1.1",
    "X-Real-IP":       "1.1.1.1",
  }
};

// ============================================================
// 💾 IN-MEMORY CACHE (5 min TTL)
// ============================================================
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
async function apiGet(path, params = {}) {
  const cacheKey = path + JSON.stringify(params);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = CONFIG.API_BASE + path;
  try {
    const res = await axios.get(url, {
      params,
      headers: CONFIG.HEADERS,
      timeout: 15000,
      withCredentials: true
    });

    const body = res.data;

    // Response format: { status: "success", data: { ... } }
    if (body?.status === "error") {
      console.error(`❌ API error: ${body.message}`);
      return null;
    }

    const result = body?.data ?? body;
    cacheSet(cacheKey, result);
    return result;

  } catch (err) {
    console.error(`❌ API call failed [${path}]:`, err.message);
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

// Convert API item → Stremio meta
// Real ID format: large numeric string e.g. "8906247916759695608"
function toMeta(item, type) {
  // subject is the wrapper key in /api/info responses
  const data = item?.subject || item;

  const mbxId = String(data.id || data.videoId || data.movieId || "");
  const stremioId = `mbx_${type}_${mbxId}`;

  return {
    id:          stremioId,
    type,
    name:        data.name || data.title || data.videoName || "Unknown",
    poster:      normalizePoster(data.coverVerticalUrl || data.poster || data.coverUrl || data.cover),
    background:  normalizePoster(data.coverHorizontalUrl || data.backdrop || data.coverLandUrl),
    description: data.introduction || data.description || data.plot || "",
    year:        data.year ? parseInt(data.year) : undefined,
    genres:      Array.isArray(data.tagList)
                   ? data.tagList.map(t => t.name || t)
                   : (Array.isArray(data.genres) ? data.genres : []),
    imdbRating:  data.score ? String(data.score) : undefined,
    cast:        Array.isArray(data.starList)
                   ? data.starList.map(s => s.name || s).slice(0, 10)
                   : [],
    director:    data.director || undefined,
    runtime:     data.duration ? `${data.duration} min` : undefined,
    _mbxId:      mbxId,
  };
}

// Parse "mbx_movie_8906247916759695608" → { type, mbxId }
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
  version:     "3.0.0",
  name:        CONFIG.SITE_NAME,
  description: "Stream Movies & TV Series from MovieBox (API-based, mobile auth)",
  logo:        CONFIG.SITE_LOGO,
  catalogs: [
    {
      type: "movie",
      id:   "moviebox_trending_movies",
      name: "MovieBox Trending",
      extra: [{ name: "search", isRequired: false }]
    },
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

  const search = extra?.search || "";
  const skip   = parseInt(extra?.skip || 0);
  const page   = Math.floor(skip / CONFIG.PAGE_SIZE) + 1;

  let items = [];

  // --- SEARCH ---
  if (search) {
    const data = await apiGet(`${CONFIG.ENDPOINTS.SEARCH}/${encodeURIComponent(search)}`);
    // Response: { items: [...] } or { results: [...] }
    items = data?.items || data?.results || data?.list || [];

    // Filter by type
    items = items.filter(item => {
      const t = item.type || item.contentType || item.category;
      if (type === "movie")  return !t || t === 1 || t === "movie";
      if (type === "series") return t === 2 || t === "series" || t === "tv";
      return true;
    });

  // --- TRENDING catalog ---
  } else if (id === "moviebox_trending_movies") {
    const data = await apiGet(CONFIG.ENDPOINTS.TRENDING);
    items = data?.items || data?.list || data?.trending || [];

  // --- HOMEPAGE / BROWSE ---
  } else {
    const data = await apiGet(CONFIG.ENDPOINTS.HOME);
    // Homepage has sections; grab the right one
    const sections = data?.sections || data?.categories || [];
    const typeNum  = type === "movie" ? 1 : 2;

    for (const section of sections) {
      const sectionItems = section?.items || section?.list || [];
      const filtered = sectionItems.filter(item => {
        const t = item.type || item.contentType;
        return !t || t === typeNum || t === type;
      });
      items.push(...filtered);
    }

    // Fallback: if homepage returned flat array
    if (items.length === 0 && Array.isArray(data)) {
      items = data;
    }

    // Paginate manually
    items = items.slice(skip, skip + CONFIG.PAGE_SIZE);
  }

  if (!Array.isArray(items) || items.length === 0) {
    console.warn("⚠️ No items found or unexpected response shape");
    return { metas: [] };
  }

  const metas = items
    .filter(item => item && (item.id || item.videoId || item.movieId))
    .map(item => toMeta(item, type));

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

  const data = await apiGet(`${CONFIG.ENDPOINTS.INFO}/${parsed.mbxId}`);
  if (!data) return { meta: null };

  const meta = toMeta(data, type);

  // For series: build episode list
  if (type === "series") {
    const subject = data?.subject || data;
    const totalSeasons = subject?.seasonCount || subject?.totalSeasonNum || 1;
    meta.videos = [];

    for (let season = 1; season <= totalSeasons; season++) {
      // Episodes are usually in subject.episodeVo or fetched via sources
      const episodes = subject?.episodeVo?.[season - 1]?.seriesNo
        ? subject.episodeVo
        : [];

      if (Array.isArray(episodes) && episodes.length > 0) {
        // Inline episodes from detail response
        episodes.forEach((ep, idx) => {
          const epNum = ep.seriesNo || ep.episode || ep.num || (idx + 1);
          meta.videos.push({
            id:        `${id}:${season}:${epNum}`,
            title:     ep.name || ep.title || `Episode ${epNum}`,
            season,
            episode:   epNum,
            released:  ep.publishTime || undefined,
            thumbnail: normalizePoster(ep.cover || ep.thumb),
            overview:  ep.introduction || "",
          });
        });
      } else {
        // Fallback: get sources to determine episode count
        const srcData = await apiGet(
          `${CONFIG.ENDPOINTS.SOURCES}/${parsed.mbxId}`,
          { season, episode: 1 }
        );
        const epCount = srcData?.totalEpisodes || srcData?.episodeCount || 1;

        for (let ep = 1; ep <= epCount; ep++) {
          meta.videos.push({
            id:      `${id}:${season}:${ep}`,
            title:   `S${String(season).padStart(2,"0")}E${String(ep).padStart(2,"0")}`,
            season,
            episode: ep,
          });
        }
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

  // Series format: "mbx_series_ID:season:episode"
  const parts   = id.split(":");
  const baseId  = parts[0];
  const season  = parts[1] ? parseInt(parts[1]) : undefined;
  const episode = parts[2] ? parseInt(parts[2]) : undefined;

  const parsed = parseStremioId(baseId);
  if (!parsed) return { streams: [] };

  const params = {};
  if (season  !== undefined) params.season  = season;
  if (episode !== undefined) params.episode = episode;

  const data = await apiGet(
    `${CONFIG.ENDPOINTS.SOURCES}/${parsed.mbxId}`,
    params
  );

  if (!data) return { streams: [] };

  const streams = [];

  // Real response shape: { processedSources: [{ quality, url, proxyUrl, size }] }
  const sources = data?.processedSources
    || data?.sources
    || data?.mediaList
    || data?.streamList
    || (data?.url ? [data] : []);

  if (Array.isArray(sources)) {
    // Sort by quality descending (1080p first)
    const qualityOrder = { "1080p": 0, "720p": 1, "480p": 2, "360p": 3 };

    sources
      .sort((a, b) => {
        const qa = qualityOrder[a.quality] ?? 99;
        const qb = qualityOrder[b.quality] ?? 99;
        return qa - qb;
      })
      .forEach(source => {
        // Prefer direct URL; fall back to proxyUrl
        const streamUrl = source.url || source.proxyUrl || source.streamUrl || source.playUrl;
        if (!streamUrl) return;

        const quality = source.quality || source.definition || source.label || "HD";
        const size    = source.size ? ` (${Math.round(source.size / 1024 / 1024)}MB)` : "";

        streams.push({
          url:   streamUrl,
          title: `MovieBox — ${quality}${size}`,
          name:  "MovieBox",
          behaviorHints: {
            notWebReady: false,
            bingeGroup:  `movieboxph-${parsed.mbxId}`
          }
        });
      });
  }

  console.log(`✅ Found ${streams.length} streams`);
  return { streams };
});

// ============================================================
// 🚀 START
// ============================================================
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

console.log(`
🎬 MovieBox PH Stremio Addon v3 running!
📡 Manifest: http://localhost:${PORT}/manifest.json
🔗 Install:  stremio://localhost:${PORT}/manifest.json
`);
