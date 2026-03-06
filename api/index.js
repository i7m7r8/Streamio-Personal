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
  if (CONFIG._cookies !== null && CONFIG._cookies !== undefined &&
      (Date.now() - CONFIG._cookieFetchedAt < 25 * 60 * 1000))
    return CONFIG._cookies;
  try {
    const res = await axios.get(
      `${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
      { headers: { "User-Agent": "Mozilla/5.0", "X-Forwarded-For": CONFIG.PH_IP, "X-Real-IP": CONFIG.PH_IP, "CF-IPCountry": "PH" }, timeout: 10000 }
    );
    const setCookie = res.headers["set-cookie"] || [];
    CONFIG._cookies = setCookie.length > 0 ? setCookie.map(c => c.split(";")[0]).join("; ") : "";
    CONFIG._cookieFetchedAt = Date.now();
  } catch (err) {
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
  } catch (err) { return null; }
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
  } catch (err) { return null; }
}

// ── Stream API ─────────────────────────────────────────────
async function fetchStreams(subjectId, detailPath, se, ep) {
  const key = `stream_${subjectId}_${se}_${ep}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const cookies = await getCookies();

  console.log("fetchStreams called:", { subjectId, se, ep });
  console.log("cookies:", cookies ? "got cookies" : "NO COOKIES");

  const referer = `https://h5.aoneroom.com/movies/${detailPath || subjectId}`;
  // List of free PH proxies to try
  const proxies = [
    { host: "103.152.112.162", port: 80 },
    { host: "103.105.49.20", port: 8080 },
    { host: "112.198.232.110", port: 8082 },
  ];
  
  let res = null;
  // First try without proxy (in case server is in PH region)
  for (let attempt = 0; attempt <= proxies.length; attempt++) {
    try {
      const axiosConfig = {
        params: { subjectId, se, ep },
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
          "Origin": "https://h5.aoneroom.com",
          "Accept": "application/json", "Referer": referer, "Cookie": cookies,
          "X-Forwarded-For": CONFIG.PH_IP, "X-Real-IP": CONFIG.PH_IP, "CF-IPCountry": "PH",
        },
        timeout: 10000
      };
      if (attempt > 0) {
        axiosConfig.proxy = { host: proxies[attempt-1].host, port: proxies[attempt-1].port, protocol: "http" };
      }
      res = await axios.get(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`, axiosConfig);
      const d = res.data;
      console.log(`Attempt ${attempt} response: hasResource=${d?.data?.hasResource} streams=${d?.data?.streams?.length}`);
      if (d?.code === 0 && d?.data?.streams?.length > 0) break;
      if (attempt === proxies.length) break;
    } catch(e) {
      console.log(`Attempt ${attempt} error: ${e.message}`);
      if (attempt === proxies.length) break;
    }
  }
  try {
    if (!res) return [];
    const d = res.data;
    if (d?.code !== 0) return [];
    const streams = d?.data?.streams || [];
    cacheSet(key, streams);
    return streams;
  } catch (err) {
    console.error("fetchStreams error:", err.message);
    return [];
  }
}

// ── Helpers ────────────────────────────────────────────────
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
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(data));
}

// ── Serverless handler ─────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const url = req.url || "/";
  const qIdx = url.indexOf("?");
  const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const qs = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : new URLSearchParams();

  const host = `https://${req.headers.host}`;

  try {
    // Manifest
    if (pathname === "/manifest.json" || pathname === "/" || pathname === "") {
      jsonResp(res, {
        id: "community.movieboxph", version: "9.0.3",
        name: "MovieBox", description: "MovieBox — Movies & Series",
        logo: "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
        catalogs: [
          {
            type: "movie", id: "mbx_movies", name: "MovieBox Movies",
            extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
            behaviorHints: { configurable: false, defaultSortOrder: "asc" },
          },
          {
            type: "series", id: "mbx_series", name: "MovieBox Series",
            extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
            behaviorHints: { configurable: false, defaultSortOrder: "asc" },
          },
        ],
        resources: ["catalog", "meta", "stream"],
        types: ["movie", "series"],
        idPrefixes: ["mbx_"],
      });
      return;
    }

    // Proxy endpoint
    if (pathname === "/proxy") {
      const targetUrl = qs.get("url");
      if (!targetUrl) { res.status(400).end("Missing url"); return; }
      const https = require("https");
      const http = require("http");
      const parsed = new URL(targetUrl);
      const lib = parsed.protocol === "https:" ? https : http;
      const proxyReq = lib.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "Referer": "https://fmoviesunblocked.net/",
          "Origin": "https://fmoviesunblocked.net",
          "User-Agent": "Mozilla/5.0",
          ...(req.headers["range"] ? { "Range": req.headers["range"] } : {}),
        }
      }, (proxyRes) => {
        res.setHeader("Content-Type", proxyRes.headers["content-type"] || "video/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (proxyRes.headers["content-length"]) res.setHeader("Content-Length", proxyRes.headers["content-length"]);
        if (proxyRes.headers["content-range"]) res.setHeader("Content-Range", proxyRes.headers["content-range"]);
        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res);
      });
      proxyReq.on("error", () => { res.status(500).end(); });
      proxyReq.end();
      return;
    }

    // Catalog: /catalog/type/id or /catalog/type/id/extra
    const catalogMatch = pathname.match(/^\/catalog\/(movie|series)\/[^/]+(?:\/([^/]+))?\.json$/);
    if (catalogMatch) {
      const type = catalogMatch[1];
      const extraStr = catalogMatch[2] || "";
      const extra = {};
      if (extraStr) {
        extraStr.split("&").forEach(part => {
          const eq = part.indexOf("=");
          if (eq > 0) extra[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
        });
      }
      if (qs.get("search")) extra.search = qs.get("search");
      if (qs.get("skip")) extra.skip = qs.get("skip");

      const subjectType = type === "series" ? 2 : 1;
      const skip = parseInt(extra.skip || 0);
      const page = Math.floor(skip / CONFIG.PAGE_SIZE) + 1;
      let items = [];

      if (extra.search) {
        const data = await apiPost("/subject/search", { keyword: extra.search, page: String(page), perPage: String(CONFIG.PAGE_SIZE) });
        items = (data?.items || []).filter(i => i.subjectType === subjectType);
      } else if (type === "series") {
        const data = await apiGet("/subject/trending");
        items = (data?.subjectList || []).filter(i => i.subjectType === 2);
      } else {
        const keywords = ["the","a","man","love","war","night","dead","dark","last","world"];
        const keyword = keywords[(page - 1) % keywords.length];
        const data = await apiPost("/subject/search", { keyword, page: "1", perPage: String(CONFIG.PAGE_SIZE) });
        items = (data?.items || []).filter(i => i.subjectType === 1);
      }

      const metas = items.filter(i => i.subjectId).map(i => toMeta(i, type));
      jsonResp(res, { metas });
      return;
    }

    // Meta: /meta/type/id
    const metaMatch = pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const type = metaMatch[1];
      const id = metaMatch[2];
      const parsed = parseId(id);
      if (!parsed) { jsonResp(res, { meta: null }); return; }

      let item = itemCache.get(parsed.subjectId) || null;
      if (!item) {
        const trendData = await apiGet("/subject/trending");
        item = (trendData?.subjectList || []).find(i => String(i.subjectId) === parsed.subjectId) || null;
      }

      const meta = item ? toMeta(item, type) : { id, type, name: id };
      meta.id = id;

      if (type === "series") {
        meta.videos = [];
        for (let s = 1; s <= 5; s++) {
          for (let ep = 1; ep <= 30; ep++) {
            meta.videos.push({ id: `${id}:${s}:${ep}`, title: `S${s}E${ep}`, season: s, episode: ep, released: new Date(0).toISOString() });
          }
        }
      }
      jsonResp(res, { meta });
      return;
    }

    // Stream: /stream/type/id
    const streamMatch = pathname.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (streamMatch) {
      const type = streamMatch[1];
      const id = decodeURIComponent(streamMatch[2]);
      const parts = id.split(":");
      const baseId = parts[0];
      const season = parts[1] !== undefined ? parseInt(parts[1]) : 0;
      const episode = parts[2] !== undefined ? parseInt(parts[2]) : 0;
      const parsed = parseId(baseId);
      if (!parsed) { jsonResp(res, { streams: [] }); return; }

      const se = type === "movie" ? 0 : season;
      const ep = type === "movie" ? 0 : episode;

      const rawStreams = await fetchStreams(parsed.subjectId, "", se, ep);
      if (!rawStreams.length) { jsonResp(res, { streams: [] }); return; }

      const qualityOrder = { "1080": 0, "720": 1, "480": 2, "360": 3 };
      const streams = rawStreams
        .filter(s => s.url)
        .sort((a, b) => (qualityOrder[a.resolutions] ?? 99) - (qualityOrder[b.resolutions] ?? 99))
        .map(s => ({
          url: `${host}/proxy?url=${encodeURIComponent(s.url)}`,
          name: "MovieBox",
          title: `${s.resolutions ? s.resolutions + "p" : "HD"}${s.size ? " · " + Math.round(parseInt(s.size)/1024/1024) + "MB" : ""}`,
          behaviorHints: { notWebReady: false, bingeGroup: `mbx-${parsed.subjectId}` }
        }));

      jsonResp(res, { streams });
      return;
    }

    res.status(404).end("Not found");

  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).end("Server error");
  }
};
 
