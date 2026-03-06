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

let _cookies = {};
let _cookieFetchedAt = 0;

function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function parseCookies(setCookieHeader) {
  const cookies = {};
  if (!setCookieHeader) return cookies;
  const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const part of parts) {
    const [kv] = part.split(";");
    const eq = kv.indexOf("=");
    if (eq > 0) cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  return cookies;
}

async function ensureCookies() {
  if (Object.keys(_cookies).length > 0 && Date.now() - _cookieFetchedAt < 25 * 60 * 1000) return;
  try {
    const res = await fetch(`${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
        "X-Forwarded-For": CONFIG.PH_IP,
        "X-Real-IP": CONFIG.PH_IP,
        "CF-IPCountry": "PH",
        "CF-Connecting-IP": CONFIG.PH_IP,
      }
    });
    const setCookie = res.headers.get("set-cookie") || "";
    _cookies = parseCookies(setCookie);
    _cookieFetchedAt = Date.now();
  } catch (e) { console.error("Cookie fetch failed:", e.message); }
}

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
  "Accept": "application/json",
  "X-Forwarded-For": CONFIG.PH_IP,
  "X-Real-IP": CONFIG.PH_IP,
  "CF-IPCountry": "PH",
  "CF-Connecting-IP": CONFIG.PH_IP,
};

const CATALOG_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  "Accept": "application/json",
  "Origin": "https://h5.aoneroom.com",
  "Referer": "https://h5.aoneroom.com/",
};

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
  try {
    const res = await fetch(CONFIG.API_BASE + CONFIG.BFF + endpoint, {
      method: "POST",
      headers: { ...CATALOG_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ host: CONFIG.PAGE_HOST, ...body })
    });
    const d = await res.json();
    if (d?.code !== 0) return null;
    return d.data;
  } catch { return null; }
}

const detailPathCache = new Map();
const itemCache = new Map();

async function fetchDetail(subjectId) {
  await ensureCookies();
  const res = await fetch(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/detail?subjectId=${subjectId}`, {
    headers: { ...BASE_HEADERS, "Cookie": buildCookieHeader(_cookies) }
  }).then(r => r.json()).catch(() => null);
  if (res?.data?.subject) {
    const s = res.data.subject;
    itemCache.set(subjectId, s);
    if (s.detailPath) detailPathCache.set(subjectId, s.detailPath);
  }
  return res?.data || null;
}

async function fetchStreams(subjectId, detailPath, se, ep) {
  await ensureCookies();
  try {
    const url = new URL(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`);
    url.searchParams.set("subjectId", subjectId);
    url.searchParams.set("se", se);
    url.searchParams.set("ep", ep);
    const res = await fetch(url.toString(), {
      headers: {
        ...BASE_HEADERS,
        "Referer": `${CONFIG.STREAM_HOST}/movies/${detailPath || subjectId}`,
        "Origin": CONFIG.STREAM_HOST,
        "Cookie": buildCookieHeader(_cookies),
      }
    });
    const d = await res.json();
    if (d?.code !== 0 || !d?.data?.streams?.length) return [];
    return d.data.streams;
  } catch { return []; }
}

async function fetchCaptions(streamId, subjectId) {
  await ensureCookies();
  try {
    const url = new URL(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/caption`);
    url.searchParams.set("id", streamId);
    url.searchParams.set("subjectId", subjectId);
    const res = await fetch(url.toString(), {
      headers: { ...BASE_HEADERS, "Cookie": buildCookieHeader(_cookies) }
    });
    const d = await res.json();
    if (d?.code !== 0) return [];
    return d.data?.captions || [];
  } catch { return []; }
}

const DUB_LANGS = [
  { keyword: "hindi",   label: "Hindi Dub" },
  { keyword: "arabic",  label: "Arabic Dub" },
  { keyword: "french",  label: "French Dub" },
  { keyword: "turkish", label: "Turkish Dub" },
  { keyword: "urdu",    label: "Urdu Dub" },
];

async function findDubbedSubjects(title, type) {
  const subjectType = type === "series" ? 2 : 1;
  const results = [];
  await Promise.all(DUB_LANGS.map(async ({ keyword, label }) => {
    try {
      const res = await fetch(CONFIG.API_BASE + CONFIG.BFF + "/subject/search", {
        method: "POST",
        headers: { ...CATALOG_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ host: CONFIG.PAGE_HOST, keyword: `${title} ${keyword}`, page: "1", perPage: "3" }),
        signal: AbortSignal.timeout(4000)
      });
      const d = await res.json();
      if (d?.code !== 0) return;
      const items = (d.data?.items || []).filter(i =>
        i.subjectType === subjectType &&
        i.title?.toLowerCase().includes(keyword) &&
        i.title?.toLowerCase().includes(title.toLowerCase().slice(0, 5))
      );
      for (const item of items.slice(0, 1)) {
        if (item.detailPath) detailPathCache.set(String(item.subjectId), item.detailPath);
        results.push({ subjectId: String(item.subjectId), label, detailPath: item.detailPath || "" });
      }
    } catch {}
  }));
  return results;
}

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
    background: normalizePoster(item.stills?.url || item.cover?.url),
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
  id: "community.movieboxph", version: "15.8.0",
  name: "MovieBox", description: "MovieBox — Movies & Series with Dubbed & Subtitles",
  logo: "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
  catalogs: [
    { type: "movie",  id: "mbx_movies",  name: "MovieBox Movies",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "series", id: "mbx_series",  name: "MovieBox Series",
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
    if (pathname === "/manifest.json" || pathname === "/") return jsonResp(MANIFEST);

    if (pathname === "/debug") {
      await ensureCookies();
      return jsonResp({ version: "15.0.0", cookies: Object.keys(_cookies) });
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
        const keywords = ["love","action","drama","war","night","dead","dark","last","world","best"];
        const data = await apiPost("/subject/search", { keyword: keywords[(page-1) % keywords.length], page: "1", perPage: String(CONFIG.PAGE_SIZE) });
        items = (data?.items || []).filter(i => i.subjectType === 1);
      }

      return jsonResp({ metas: items.filter(i => i.subjectId).map(i => toMeta(i, type)) });
    }

    // Meta
    const metaMatch = pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);
    if (metaMatch) {
      const type = metaMatch[1];
      let id = metaMatch[2];
      let parsed = parseId(id);

      // If IMDB ID (tt...), resolve title via IMDB then search MovieBox
      if (!parsed && id.startsWith("tt")) {
        const imdbId = id;
        const subjectType = type === "series" ? 2 : 1;
        try {
          // Get title from Cinemeta (follows redirects)
          let title = null;
          const cinemeta = await fetch(`https://cinemeta-live.strem.io/meta/${type}/${imdbId}.json`)
            .then(r => r.json()).catch(() => null);
          title = cinemeta?.meta?.name;

          if (!title) return jsonResp({ meta: null });

          const searchData = await apiPost("/subject/search", { keyword: title, page: "1", perPage: "8" });
          const found = (searchData?.items || []).find(i => i.subjectType === subjectType);
          if (!found) return jsonResp({ meta: null });

          id = `mbx_${type}_${found.subjectId}`;
          parsed = parseId(id);
          if (found.detailPath) detailPathCache.set(String(found.subjectId), found.detailPath);
          itemCache.set(String(found.subjectId), found);
        } catch { return jsonResp({ meta: null }); }
      }

      if (!parsed) return jsonResp({ meta: null });

      const detail = await fetchDetail(parsed.subjectId);
      const subjectData = detail?.subject || null;
      const item = itemCache.get(parsed.subjectId) || subjectData || null;

      const meta = item ? toMeta(item, type) : { id, type, name: id };
      meta.id = id;

      // Real release date from subject
      if (subjectData?.releaseDate) meta.released = subjectData.releaseDate;

      if (type === "series") {
        meta.videos = [];
        const seasons = detail?.resource?.seasons || [];
        if (seasons.length > 0) {
          for (const season of seasons) {
            const maxEp = season.maxEp || 1;
            for (let ep = 1; ep <= maxEp; ep++) {
              meta.videos.push({
                id: `${id}:${season.se}:${ep}`,
                title: `S${season.se}E${ep}`,
                season: season.se,
                episode: ep,
                released: new Date(0).toISOString()
              });
            }
          }
        } else {
          for (let s = 1; s <= 3; s++)
            for (let ep = 1; ep <= 15; ep++)
              meta.videos.push({ id: `${id}:${s}:${ep}`, title: `S${s}E${ep}`, season: s, episode: ep, released: new Date(0).toISOString() });
        }
      }
      return jsonResp({ meta });
    }

    // Proxy
    if (pathname === "/proxy") {
      const target = url.searchParams.get("url");
      if (!target) return new Response("Missing url", { status: 400 });
      const range = request.headers.get("range") || "";
      const proxyRes = await fetch(target, {
        headers: {
          "Referer": "https://fmoviesunblocked.net/",
          "Origin": "https://fmoviesunblocked.net",
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0",
          ...(range ? { "Range": range } : {}),
        }
      });
      const headers = new Headers();
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Content-Type", proxyRes.headers.get("content-type") || "video/mp4");
      headers.set("Accept-Ranges", "bytes");
      if (proxyRes.headers.get("content-length")) headers.set("Content-Length", proxyRes.headers.get("content-length"));
      if (proxyRes.headers.get("content-range")) headers.set("Content-Range", proxyRes.headers.get("content-range"));
      return new Response(proxyRes.body, { status: proxyRes.status, headers });
    }

    // Stream
    const streamMatch = pathname.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (streamMatch) {
      const type = streamMatch[1];
      const id = decodeURIComponent(streamMatch[2]);
      const parts = id.split(":");
      const parsed = parseId(parts[0]);
      if (!parsed) return jsonResp({ streams: [] });

      const se = type === "movie" ? 0 : parseInt(parts[1] || 1);
      const ep = type === "movie" ? 0 : parseInt(parts[2] || 1);

      // Fetch detail for detailPath + title
      const detail = await fetchDetail(parsed.subjectId);
      const finalDetailPath = detailPathCache.get(parsed.subjectId) || parsed.subjectId;
      const itemTitle = detail?.subject?.title || itemCache.get(parsed.subjectId)?.title || "";

      // Fetch original streams + dubbed subjects in parallel
      const [rawStreams, dubbedSubjects] = await Promise.all([
        fetchStreams(parsed.subjectId, finalDetailPath, se, ep),
        itemTitle ? findDubbedSubjects(itemTitle, type) : Promise.resolve([])
      ]);

      if (!rawStreams.length) return jsonResp({ streams: [] });

      // Fetch captions + dubbed streams in parallel
      const [captions, ...dubbedStreamArrays] = await Promise.all([
        fetchCaptions(rawStreams[0].id, parsed.subjectId),
        ...dubbedSubjects.map(dub => fetchStreams(dub.subjectId, dub.detailPath, se, ep))
      ]);

      const subtitles = captions.map(c => ({ id: c.id, url: c.url, lang: c.lan, label: c.lanName }));
      const dubbedResults = dubbedSubjects.map((dub, i) => ({ label: dub.label, streams: dubbedStreamArrays[i] || [] }));

      const qualityOrder = { "1080": 0, "720": 1, "480": 2, "360": 3 };
      const host = request.headers.get("host");

      const buildEntry = (s, label) => ({
        url: `https://${host}/proxy?url=${encodeURIComponent(s.url)}`,
        name: "MovieBox 🎬",
        title: `${s.resolutions ? s.resolutions + "p" : "HD"}${s.size ? " · " + Math.round(parseInt(s.size)/1024/1024) + "MB" : ""} · ${label}`,
        subtitles,
        behaviorHints: { notWebReady: true, bingeGroup: `mbx-${parsed.subjectId}` }
      });

      const streams = rawStreams
        .filter(s => s.url)
        .sort((a, b) => (qualityOrder[a.resolutions] ?? 99) - (qualityOrder[b.resolutions] ?? 99))
        .map(s => buildEntry(s, "Original Audio"));

      for (const { label, streams: dubStreams } of dubbedResults) {
        dubStreams
          .filter(s => s.url)
          .sort((a, b) => (qualityOrder[a.resolutions] ?? 99) - (qualityOrder[b.resolutions] ?? 99))
          .forEach(s => streams.push(buildEntry(s, label)));
      }

      return jsonResp({ streams });
    }

    return new Response("Not found", { status: 404 });

  } catch (err) {
    return new Response("Error: " + err.message, { status: 500 });
  }
}
