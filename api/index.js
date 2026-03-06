const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 7000;
const PROXY_PORT = 7001;

const CONFIG = {
    API_BASE: "https://h5-api.aoneroom.com",
    BFF: "/wefeed-h5api-bff",
    PAGE_HOST: "h5.aoneroom.com",
    STREAM_HOST: "https://h5.aoneroom.com",
    STREAM_BFF: "/wefeed-h5-bff",
    PAGE_SIZE: 24,
    PH_IP: "112.198.0.1",
    _cookies: null,
    _cookieFetchedAt: 0,
};

// ── Cache ─────────────────────────────
const cache = new Map();
function cacheGet(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > 5 * 60 * 1000) { cache.delete(key); return null; }
    return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Cookies ────────────────────────────
async function getCookies() {
    if (CONFIG._cookies && (Date.now() - CONFIG._cookieFetchedAt < 30 * 60 * 1000))
        return CONFIG._cookies;
    try {
        const res = await axios.get(`${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "X-Forwarded-For": CONFIG.PH_IP,
                "X-Real-IP": CONFIG.PH_IP,
                "CF-IPCountry": "PH"
            },
            timeout: 10000
        });
        const setCookie = res.headers["set-cookie"] || [];
        CONFIG._cookies = setCookie.length ? setCookie.map(c => c.split(";")[0]).join("; ") : "";
        CONFIG._cookieFetchedAt = Date.now();
        console.log("🍪 Cookies fetched");
    } catch (e) {
        console.error("Cookie fetch failed:", e.message);
        CONFIG._cookies = "";
    }
    return CONFIG._cookies;
}

// ── API Helpers ───────────────────────
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10)",
    "Accept": "application/json",
    "Origin": "https://h5.aoneroom.com",
    "Referer": "https://h5.aoneroom.com/"
};

async function apiGet(endpoint, params = {}) {
    const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
    const key = url + JSON.stringify(params);
    const cached = cacheGet(key);
    if (cached) return cached;
    try {
        const res = await axios.get(url, {
            params: { host: CONFIG.PAGE_HOST, ...params },
            headers: HEADERS,
            timeout: 15000
        });
        if (res.data?.code !== 0) return null;
        cacheSet(key, res.data.data);
        return res.data.data;
    } catch (e) { console.error(`GET ${endpoint}:`, e.message); return null; }
}

async function apiPost(endpoint, body = {}) {
    const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
    const key = url + JSON.stringify(body);
    const cached = cacheGet(key);
    if (cached) return cached;
    try {
        const res = await axios.post(url, { host: CONFIG.PAGE_HOST, ...body }, {
            headers: { ...HEADERS, "Content-Type": "application/json" },
            timeout: 15000
        });
        if (res.data?.code !== 0) return null;
        cacheSet(key, res.data.data);
        return res.data.data;
    } catch (e) { console.error(`POST ${endpoint}:`, e.message); return null; }
}

// ── Streams ───────────────────────────
async function fetchStreams(subjectId, se = 0, ep = 0) {
    const key = `stream_${subjectId}_${se}_${ep}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const cookies = await getCookies();
    try {
        const res = await axios.get(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`, {
            params: { subjectId, se, ep },
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": `https://h5.aoneroom.com/movies/${subjectId}`,
                "Cookie": cookies,
                "X-Forwarded-For": CONFIG.PH_IP,
                "X-Real-IP": CONFIG.PH_IP,
                "CF-IPCountry": "PH"
            },
            timeout: 15000
        });
        const streams = res.data?.data?.streams || [];
        cacheSet(key, streams);
        return streams;
    } catch (e) { console.error("Stream fetch failed:", e.message); return []; }
}

// ── Helpers ───────────────────────────
function toMeta(item, type) {
    return {
        id: `mbx_${type}_${item.subjectId}`,
        type,
        name: item.title,
        poster: item.cover?.url ? "https://pbcdnw.aoneroom.com" + item.cover.url : null,
        background: item.stills?.url ? "https://pbcdnw.aoneroom.com" + item.stills.url : null,
        description: item.description || "",
        year: item.releaseDate ? parseInt(item.releaseDate.slice(0, 4)) : undefined,
        genres: item.genre?.split(",")?.map(g => g.trim()) || [],
    };
}

function parseId(id) {
    const m = id.match(/^mbx_(movie|series)_(.+)$/);
    return m ? { type: m[1], subjectId: m[2] } : null;
}

// ── Manifest ──────────────────────────
const manifest = {
    id: "community.movieboxph",
    version: "9.0.0",
    name: "MovieBox",
    description: "MovieBox — Movies & Series",
    logo: "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
    catalogs: [
        { type: "movie", id: "mbx_movies", name: "MovieBox Movies", extra: [{ name: "search" }] },
        { type: "series", id: "mbx_series", name: "MovieBox Series", extra: [{ name: "search" }] }
    ],
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["mbx_"]
};

const builder = new addonBuilder(manifest);

// ── Catalog Handler ───────────────────
builder.defineCatalogHandler(async ({ type, extra }) => {
    let items = [];
    try {
        if (extra?.search) {
            const data = await apiPost("/subject/search", { keyword: extra.search, page: "1", perPage: CONFIG.PAGE_SIZE });
            items = (data?.items || []).filter(i => (type === "series" ? i.subjectType === 2 : i.subjectType === 1));
        } else {
            const data = await apiGet("/subject/trending");
            items = (data?.subjectList || []).filter(i => (type === "series" ? i.subjectType === 2 : i.subjectType === 1));
        }
        const metas = items.map(i => toMeta(i, type));
        return { metas };
    } catch (e) {
        console.error("Catalog error:", e.message);
        return { metas: [] };
    }
});

// ── Meta Handler ──────────────────────
builder.defineMetaHandler(async ({ type, id }) => {
    const parsed = parseId(id);
    if (!parsed) return { meta: null };
    const meta = { id, type, name: id };
    return { meta };
});

// ── Stream Handler ────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
    const parsed = parseId(id);
    if (!parsed) return { streams: [] };
    const streams = await fetchStreams(parsed.subjectId);
    return {
        streams: streams.map(s => ({
            name: "MovieBox",
            title: s.resolutions ? s.resolutions + "p" : "HD",
            url: s.url
        }))
    };
});

// ── Start Addon ──────────────────────
serveHTTP(builder.getInterface(), { port: PORT });
getCookies();
console.log(`MovieBox addon running at http://localhost:${PORT}/manifest.json`);
