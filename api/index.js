const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const http = require("http");
const https = require("https");

// ---------------- CONFIG ----------------
const CONFIG = {
  API_BASE:    "https://h5-api.aoneroom.com",
  BFF:         "/wefeed-h5api-bff",
  STREAM_HOST: "https://h5.aoneroom.com",
  STREAM_BFF:  "/wefeed-h5-bff",
  PAGE_HOST:   "h5.aoneroom.com",
  PAGE_SIZE:   24,
  PH_IP:       "112.198.0.1",
  _cookies:    null,
  _cookieFetchedAt: 0,
};

const cache = new Map();
const detailPathCache = new Map();
const itemCache = new Map();

// ---------------- CACHE HELPERS ----------------
const cacheGet = key => {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > 5*60*1000) { cache.delete(key); return null; }
  return e.data;
};
const cacheSet = (key, data) => cache.set(key, { data, ts: Date.now() });

// ---------------- COOKIES ----------------
async function getCookies() {
  if (CONFIG._cookies && Date.now() - CONFIG._cookieFetchedAt < 30*60*1000) return CONFIG._cookies;
  try {
    const res = await axios.get(`${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`, {
      headers: { 
        "User-Agent": "Mozilla/5.0",
        "X-Forwarded-For": CONFIG.PH_IP,
        "X-Real-IP": CONFIG.PH_IP,
        "CF-IPCountry": "PH"
      },
      timeout:10000
    });
    const setCookie = res.headers["set-cookie"] || [];
    CONFIG._cookies = setCookie.length > 0 ? setCookie.map(c=>c.split(";")[0]).join("; ") : "";
    CONFIG._cookieFetchedAt = Date.now();
  } catch(err) {
    CONFIG._cookies = "";
    console.error("Cookie fetch failed:", err.message);
  }
  return CONFIG._cookies;
}

// ---------------- API HELPERS ----------------
const CATALOG_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  "Accept": "application/json",
  "Origin": "https://h5.aoneroom.com",
  "Referer": "https://h5.aoneroom.com/"
};

async function apiGet(endpoint, params={}) {
  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
  const key = url + JSON.stringify(params);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await axios.get(url, { params:{ host: CONFIG.PAGE_HOST, ...params }, headers: CATALOG_HEADERS, timeout:15000 });
    if (res.data?.code !== 0) return null;
    cacheSet(key,res.data.data);
    return res.data.data;
  } catch(err) { console.error(`GET [${endpoint}]:`, err.message); return null; }
}

async function apiPost(endpoint, body={}) {
  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint;
  const key = url + JSON.stringify(body);
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const res = await axios.post(url, { host: CONFIG.PAGE_HOST, ...body }, { headers:{...CATALOG_HEADERS,"Content-Type":"application/json"}, timeout:15000 });
    if (res.data?.code !== 0) return null;
    cacheSet(key,res.data.data);
    return res.data.data;
  } catch(err) { console.error(`POST [${endpoint}]:`, err.message); return null; }
}

// ---------------- STREAM FETCH ----------------
async function fetchStreams(subjectId, se=0, ep=0) {
  const key = `stream_${subjectId}_${se}_${ep}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const cookies = await getCookies();
  try {
    const res = await axios.get(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`, {
      params:{ subjectId, se, ep },
      headers:{
        "User-Agent":"Mozilla/5.0",
        "Referer":`https://h5.aoneroom.com/movies/${subjectId}`,
        "Cookie":cookies,
        "X-Forwarded-For":CONFIG.PH_IP,
        "X-Real-IP":CONFIG.PH_IP,
        "CF-IPCountry":"PH"
      },
      timeout:15000
    });
    if (res.data?.code !== 0) return [];
    const streams = res.data?.data?.streams || [];
    cacheSet(key,streams);
    return streams;
  } catch(err){ console.error("Stream fetch failed:", err.message); return []; }
}

// ---------------- HELPERS ----------------
function toMeta(item,type){
  const subjectId = String(item.subjectId||"");
  if(item.detailPath) detailPathCache.set(subjectId,item.detailPath);
  itemCache.set(subjectId,item);
  return {
    id:`mbx_${type}_${subjectId}`,
    type,
    name:item.title||"Unknown",
    poster:item.cover?.url?`https://pbcdnw.aoneroom.com${item.cover.url}`:null,
    description:item.description||"",
  };
}
function parseId(id){
  const m = id.match(/^mbx_(movie|series)_(.+)$/);
  return m?{ type:m[1], subjectId:m[2] }:null;
}

// ---------------- MANIFEST ----------------
const manifest = {
  id: "community.movieboxph",
  version: "10.0.0",
  name: "MovieBox",
  description: "MovieBox — Movies & Series",
  logo: "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
  catalogs:[
    { type:"movie", id:"mbx_movies", name:"MovieBox Movies", extra:[{name:"search"}] },
    { type:"series", id:"mbx_series", name:"MovieBox Series", extra:[{name:"search"}] }
  ],
  resources:["catalog","meta","stream"],
  types:["movie","series"],
  idPrefixes:["mbx_"]
};
const builder = new addonBuilder(manifest);

// ---------------- CATALOG ----------------
builder.defineCatalogHandler(async ({ type, extra })=>{
  let items=[];
  if(extra?.search){
    const data = await apiPost("/subject/search",{ keyword:extra.search, page:"1", perPage:CONFIG.PAGE_SIZE });
    items = (data?.items||[]).filter(i=>i.subjectType=== (type==="series"?2:1));
  } else {
    const data = await apiGet("/subject/trending");
    items = (data?.subjectList||[]).filter(i=>i.subjectType=== (type==="series"?2:1));
  }
  const metas = items.map(i=>toMeta(i,type));
  return { metas };
});

// ---------------- META ----------------
builder.defineMetaHandler(async ({ id })=>{
  const parsed = parseId(id);
  if(!parsed) return { meta:null };
  const type = parsed.type;
  const subjectId = parsed.subjectId;
  const data = await apiGet("/subject/detail",{ subjectId });
  if(!data) return { meta:null };
  const meta = toMeta(data,type);
  return { meta };
});

// ---------------- STREAM ----------------
builder.defineStreamHandler(async ({ id })=>{
  const parsed = parseId(id);
  if(!parsed) return { streams:[] };
  const streams = await fetchStreams(parsed.subjectId,0,0);
  return { streams: streams.map(s=>({ title:s.resolutions+"p", url:s.url })) };
});

// ---------------- EXPORT FOR VERCEL ----------------
module.exports = serveHTTP(builder.getInterface());
