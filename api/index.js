export const config = { runtime: "edge" };

const CONFIG = {
  API_BASE:    "https://h5-api.aoneroom.com",
  BFF:         "/wefeed-h5api-bff",
  PAGE_HOST:   "h5.aoneroom.com",
  STREAM_HOST: "https://h5.aoneroom.com",
  STREAM_BFF:  "/wefeed-h5-bff",
  PAGE_SIZE:   24,
  PH_IP:       "112.198.0.1",
};

const CATALOG_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  "Accept": "application/json",
  "Origin": "https://h5.aoneroom.com",
  "Referer": "https://h5.aoneroom.com/",
};

let _cookies = null;
let _cookieFetchedAt = 0;

async function getCookies() {
  if (_cookies !== null && (Date.now() - _cookieFetchedAt < 25 * 60 * 1000)) return _cookies;
  try {
    const res = await fetch(`${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`, {
      headers: { "User-Agent": "Mozilla/5.0", "X-Forwarded-For": CONFIG.PH_IP, "X-Real-IP": CONFIG.PH_IP, "CF-IPCountry": "PH" }
    });
    const setCookie = res.headers.get("set-cookie") || "";
    _cookies = setCookie ? setCookie.split(";")[0] : "";
    _cookieFetchedAt = Date.now();
  } catch { _cookies = ""; }
  return _cookies;
}

async function apiGet(endpoint, params = {}) {
  const url = new URL(CONFIG.API_BASE + CONFIG.BFF + endpoint);
  url.searchParams.set("host", CONFIG.PAGE_HOST);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), { headers: CATALOG_HEADERS });
    const d = await res.json();
    if (d?.code !== 0) return null;
    return d.data;
  } catch { return null; }
}

async function apiPost(endpoint, body = {}) {
  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...CATALOG_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ host: CONFIG.PAGE_HOST, ...body })
    });
    const d = await res.json();
    if (d?.code !== 0) return null;
    return d.data;
  } catch { return null; }
}

async function fetchStreams(subjectId, se, ep) {
  const cookies = await getCookies();
  try {
    const url = new URL(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`);
    url.searchParams.set("subjectId", subjectId);
    url.searchParams.set("se", se);
    url.searchParams.set("ep", ep);
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        "Accept": "application/json",
        "Origin": "https://h5.aoneroom.com",
        "Referer": `https://h5.aoneroom.com/movies/${subjectId}`,
        "Cookie": cookies,
        "X-Forwarded-For": CONFIG.PH_IP,
        "X-Real-IP": CONFIG.PH_IP,
        "CF-IPCountry": "PH",
      }
    });
    const d = await res.json();
    if (d?.code !== 0 || !d?.data?.streams?.length) return { streams: [], hasResource: d?.data?.hasResource };
    return { streams: d.data.streams, hasResource: true };
  } catch (e) { return { streams: [], error: e.message }; }
}

function normalizePoster(url) {
  if (!url) return null;
  return url.startsWith("http") ? url : `https://pbcdnw.aoneroom.com${url}`;
}

const itemCache = new Map();

function toMeta(item, type) {
  const subjectId = String(item.subjectId || "");
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

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

const MANIFEST = {
  id: "community.movieboxph", version: "12.0.0",
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
};

export default async function handler(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }

  try {
    // Manifest
    if (pathname === "/manifest.json" || pathname === "/") return jsonResp(MANIFEST);

    // Debug
    const debugMatch = pathname.match(/^\/debug\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (debugMatch) {
      const result = await fetchStreams(debugMatch[1], debugMatch[2], debugMatch[3]);
      return jsonResp(result);
    }

    // Catalog
    const catalogMatch = pathname.match(/^\/catalog\/(movie|series)\/[^/]+(?:\/([^/]+))?\.json$/);
    if (catalogMatch) {
      const type = catalogMatch[1];
      const extraStr = catalogMatch[2] || "";
      const extra = {};
      if (extraStr) extraStr.split("&").forEach(part => {
        const eq = part.indexOf("=");
        if (eq > 0) extra[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
      });
      if (url.searchParams.get("search")) extra.search = url.searchParams.get("search");
      if (url.searchParams.get("skip")) extra.skip = url.searchParams.get("skip");

      const subjectType = type === "series" ? 2 : 1;
      const page = Math.floor(parseInt(extra.skip || 0) / CONFIG.PAGE_SIZE) + 1;
      let items = [];

      if (extra.search) {
        const data = await apiPost("/subject/search", { keyword: extra.search, page: String(page), perPage: String(CONFIG.PAGE_SIZE) });
        items = (data?.items || []).filter(i => i.subjectType === subjectType);
      } else if (type === "series") {
        const data = await apiGet("/subject/trending");
        items = (data?.subjectList || []).filter(i => i.subjectType === 2);
      } else {
        const keywords = ["the","a","man","love","war","night","dead","dark","last","world"];
        const data = await apiPost("/subject/search", { keyword: keywords[(page-1) % keywords.length], page: "1", perPage: String(CONFIG.PAGE_SIZE) });
        items = (data?.items || []).filter(i => i.subjectType === 1);
      }

      return jsonResp({ metas: items.filter(i => i.subjectId).map(i => toMeta(i, type)) });
    }

    // Meta
    const metaMatch = pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const type = metaMatch[1];
      const id = metaMatch[2];
      const parsed = parseId(id);
      if (!parsed) return jsonResp({ meta: null });

      let item = itemCache.get(parsed.subjectId) || null;
      if (!item) {
        const trendData = await apiGet("/subject/trending");
        item = (trendData?.subjectList || []).find(i => String(i.subjectId) === parsed.subjectId) || null;
      }

      const meta = item ? toMeta(item, type) : { id, type, name: id };
      meta.id = id;

      if (type === "series") {
        meta.videos = [];
        for (let s = 1; s <= 6; s++)
          for (let ep = 1; ep <= 30; ep++)
            meta.videos.push({ id: `${id}:${s}:${ep}`, title: `S${s}E${ep}`, season: s, episode: ep, released: new Date(0).toISOString() });
      }
      return jsonResp({ meta });
    }

    // Stream
    const streamMatch = pathname.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (streamMatch) {
      const type = streamMatch[1];
      const id = decodeURIComponent(streamMatch[2]);
      const parts = id.split(":");
      const parsed = parseId(parts[0]);
      if (!parsed) return jsonResp({ streams: [] });

      const se = type === "movie" ? 0 : parseInt(parts[1] || 0);
      const ep = type === "movie" ? 0 : parseInt(parts[2] || 0);

      const { streams: rawStreams } = await fetchStreams(parsed.subjectId, se, ep);
      if (!rawStreams.length) return jsonResp({ streams: [] });

      const qualityOrder = { "1080": 0, "720": 1, "480": 2, "360": 3 };
      const streams = rawStreams
        .filter(s => s.url)
        .sort((a, b) => (qualityOrder[a.resolutions] ?? 99) - (qualityOrder[b.resolutions] ?? 99))
        .map(s => ({
          url: s.url,
          name: "MovieBox",
          title: `${s.resolutions ? s.resolutions + "p" : "HD"}${s.size ? " · " + Math.round(parseInt(s.size)/1024/1024) + "MB" : ""}`,
          behaviorHints: { notWebReady: true, bingeGroup: `mbx-${parsed.subjectId}` }
        }));

      return jsonResp({ streams });
    }

    return new Response("Not found", { status: 404 });

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}
