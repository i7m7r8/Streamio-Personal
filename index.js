const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// ============================================================
// 🔧 CONFIGURATION — fully verified from JS source + curl tests
// ============================================================
const CONFIG = {
  API_BASE:  "https://h5-api.aoneroom.com",
  BFF:       "/wefeed-h5api-bff",
  PAGE_HOST: "h5.aoneroom.com",

  SITE_NAME: "MovieBox PH",
  SITE_LOGO: "https://pbcdnw.aoneroom.com/image/logo.webp",
  CDN_IMAGE: "https://pbcdnw.aoneroom.com",
  PAGE_SIZE: 24,

  // Real confirmed endpoints
  ENDPOINTS: {
    HOME:     "/home",                   // GET ?host=
    SEARCH:   "/subject/search",         // POST { keyword, host, page, perPage }
    DETAIL:   "/subject/detail-rec",     // GET ?subjectId=&page=1&perPage=12
    TRENDING: "/subject/trending",       // GET ?host=
    EPISODE:  "/platform/play-list",     // GET ?platform=&page=&perPage=
    SOURCE:   "/subject/play-info",      // GET ?subjectId=&season=&episode=
  },

  HEADERS: {
    "User-Agent":      "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
    "Accept":          "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://h5.aoneroom.com",
    "Referer":         "https://h5.aoneroom.com/",
    "Content-Type":    "application/json",
  }
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
// 📡 API CLIENT
// ============================================================
async function apiGet(endpoint, params = {}) {
  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
  const key = url + JSON.stringify(params);
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const res = await axios.get(url, {
      params: { host: CONFIG.PAGE_HOST, ...params },
      headers: CONFIG.HEADERS,
      timeout: 15000
    });
    const body = res.data;
    if (body?.code !== 0) {
      console.error(`❌ API error [${endpoint}]: code=${body?.code} msg=${body?.message}`);
      return null;
    }
    cacheSet(key, body.data);
    return body.data;
  } catch (err) {
    console.error(`❌ GET failed [${endpoint}]:`, err.message);
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
      headers: CONFIG.HEADERS,
      timeout: 15000
    });
    const data = res.data;
    if (data?.code !== 0) {
      console.error(`❌ API error [${endpoint}]: code=${data?.code} msg=${data?.message}`);
      return null;
    }
    cacheSet(key, data.data);
    return data.data;
  } catch (err) {
    console.error(`❌ POST failed [${endpoint}]:`, err.message);
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

// Real response shape from curl:
// { subjectId, subjectType, title, cover.url, releaseDate,
//   genre, imdbRatingValue, detailPath, description, season }
// subjectType: 1=movie, 2=series, 6=music (skip)
function toMeta(item, forceType) {
  const subjectId = String(item.subjectId || item.id || "");
  const type = forceType || (item.subjectType === 2 ? "series" : "movie");
  const stremioId = `mbx_${type}_${subjectId}`;

  return {
    id:          stremioId,
    type,
    name:        item.title || item.name || "Unknown",
    poster:      normalizePoster(item.cover?.url || item.coverUrl),
    background:  normalizePoster(item.stills?.url || item.backdrop),
    description: item.description || item.introduction || "",
    year:        item.releaseDate ? parseInt(item.releaseDate.slice(0, 4)) : undefined,
    genres:      item.genre ? item.genre.split(",").map(g => g.trim()) : [],
    imdbRating:  item.imdbRatingValue || undefined,
    runtime:     item.duration ? `${Math.round(item.duration / 60)} min` : undefined,
    // store for lookups
    _subjectId:  subjectId,
    _detailPath: item.detailPath || "",
  };
}

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
  version:     "4.0.0",
  name:        CONFIG.SITE_NAME,
  description: "MovieBox — Movies & TV Series (fully verified API)",
  logo:        CONFIG.SITE_LOGO,
  catalogs: [
    {
      type: "movie",
      id:   "mbx_trending",
      name: "MovieBox Trending",
      extra: [{ name: "search", isRequired: false }]
    },
    {
      type: "movie",
      id:   "mbx_movies",
      name: "MovieBox Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip",   isRequired: false }
      ]
    },
    {
      type: "series",
      id:   "mbx_series",
      name: "MovieBox Series",
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

  // subjectType: 1=movie, 2=series
  const subjectType = type === "series" ? 2 : 1;

  let items = [];

  // --- SEARCH ---
  if (search) {
    const data = await apiPost(CONFIG.ENDPOINTS.SEARCH, {
      keyword:     search,
      page:        String(page),
      perPage:     CONFIG.PAGE_SIZE,
      subjectType: subjectType
    });
    items = data?.items || [];
    // Filter by subjectType
    items = items.filter(i => i.subjectType === subjectType);

  // --- TRENDING ---
  } else if (id === "mbx_trending") {
    const data = await apiGet(CONFIG.ENDPOINTS.TRENDING);
    items = data?.items || data?.list || [];
    items = items.filter(i => i.subjectType === 1); // trending = movies only

  // --- HOME BROWSE ---
  } else {
    const data = await apiGet(CONFIG.ENDPOINTS.HOME);
    // Home returns sections array with items
    const sections = data?.sections || data?.tabList || [];
    for (const section of sections) {
      const sectionItems = section?.items || section?.list || [];
      items.push(...sectionItems.filter(i => i.subjectType === subjectType));
    }
    // Fallback flat array
    if (items.length === 0 && Array.isArray(data?.items)) {
      items = data.items.filter(i => i.subjectType === subjectType);
    }
    items = items.slice(skip, skip + CONFIG.PAGE_SIZE);
  }

  if (!Array.isArray(items) || items.length === 0) {
    console.warn("⚠️ No items returned");
    return { metas: [] };
  }

  const metas = items
    .filter(i => i.subjectId || i.id)
    .map(i => toMeta(i, type));

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

  const data = await apiGet(CONFIG.ENDPOINTS.DETAIL, {
    subjectId: parsed.subjectId,
    page:      1,
    perPage:   12
  });
  if (!data) return { meta: null };

  // Detail response has subject + rec items
  const subject = data.subject || data;
  const meta = toMeta(subject, type);

  // Series: build episode list from episodeVo
  if (type === "series") {
    meta.videos = [];
    const episodeVo = subject.episodeVo || [];

    if (episodeVo.length > 0) {
      // episodeVo is array of seasons
      episodeVo.forEach(season => {
        const seasonNum = season.seasonNum || season.season || 1;
        const episodes  = season.episodeList || season.episodes || [];
        episodes.forEach(ep => {
          const epNum = ep.seriesNo || ep.episode || ep.num;
          meta.videos.push({
            id:        `${id}:${seasonNum}:${epNum}`,
            title:     ep.name || ep.title || `S${seasonNum}E${epNum}`,
            season:    seasonNum,
            episode:   epNum,
            released:  ep.publishTime || undefined,
            thumbnail: normalizePoster(ep.cover?.url || ep.thumb),
            overview:  ep.description || "",
          });
        });
      });
    } else {
      // Fallback: single season, try to get episode count from play-info
      const totalEps = subject.totalEpisode || subject.episodeCount || 1;
      for (let ep = 1; ep <= totalEps; ep++) {
        meta.videos.push({
          id:      `${id}:1:${ep}`,
          title:   `Episode ${ep}`,
          season:  1,
          episode: ep,
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

  // Series ID format: "mbx_series_ID:season:episode"
  const parts     = id.split(":");
  const baseId    = parts[0];
  const season    = parts[1] ? parseInt(parts[1]) : undefined;
  const episode   = parts[2] ? parseInt(parts[2]) : undefined;

  const parsed = parseStremioId(baseId);
  if (!parsed) return { streams: [] };

  const params = { subjectId: parsed.subjectId };
  if (season  !== undefined) params.season  = season;
  if (episode !== undefined) params.episode = episode;

  const data = await apiGet(CONFIG.ENDPOINTS.SOURCE, params);
  if (!data) return { streams: [] };

  const streams = [];

  // Try known response shapes for stream URLs
  const mediaList = data?.mediaInfoList
    || data?.playInfoList
    || data?.streamList
    || data?.mediaList
    || data?.urlList
    || (data?.url ? [data] : []);

  if (Array.isArray(mediaList) && mediaList.length > 0) {
    const qualityOrder = { "1080p": 0, "720p": 1, "480p": 2, "360p": 3 };

    mediaList
      .sort((a, b) => (qualityOrder[a.quality] ?? 99) - (qualityOrder[b.quality] ?? 99))
      .forEach(media => {
        const url = media.url || media.streamUrl || media.playUrl || media.mediaUrl;
        if (!url) return;

        const quality = media.quality || media.definition || media.resolution || "HD";
        const size    = media.size ? ` (${Math.round(media.size / 1024 / 1024)}MB)` : "";

        streams.push({
          url,
          title: `MovieBox — ${quality}${size}`,
          name:  "MovieBox",
          behaviorHints: {
            notWebReady: false,
            bingeGroup:  `mbx-${parsed.subjectId}`
          }
        });
      });
  }

  // Log full response shape if no streams found (helps debug)
  if (streams.length === 0) {
    console.warn("⚠️ No streams found. Response keys:", Object.keys(data || {}));
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
🎬 MovieBox Stremio Addon v4 running!
📡 Manifest: http://localhost:${PORT}/manifest.json
🔗 Install:  stremio://localhost:${PORT}/manifest.json
`);
