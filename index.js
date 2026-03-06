const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const http = require("http");
const https = require("https");

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

const PORT = process.env.PORT || 7000;

const cache = new Map();
function cacheGet(k){const e=cache.get(k);if(!e)return null;if(Date.now()-e.ts>5*60*1000){cache.delete(k);return null;}return e.data;}
function cacheSet(k,d){cache.set(k,{data:d,ts:Date.now()});}

async function getCookies(){
  if(CONFIG._cookies && Date.now()-CONFIG._cookieFetchedAt<30*60*1000) return CONFIG._cookies;
  try{
    const res = await axios.get(`${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,{
      headers:{
        "User-Agent":"Mozilla/5.0",
        "X-Forwarded-For":CONFIG.PH_IP,
        "X-Real-IP":CONFIG.PH_IP,
        "CF-IPCountry":"PH"
      }
    });
    const sc = res.headers["set-cookie"] || [];
    CONFIG._cookies = sc.length ? sc.map(c=>c.split(";")[0]).join("; ") : "";
    CONFIG._cookieFetchedAt = Date.now();
  }catch(e){
    CONFIG._cookies="";
  }
  return CONFIG._cookies;
}

const CATALOG_HEADERS = {
  "User-Agent":"Mozilla/5.0",
  "Accept":"application/json",
  "Origin":"https://h5.aoneroom.com",
  "Referer":"https://h5.aoneroom.com/"
};

async function apiGet(endpoint,params={}){
  const url=CONFIG.API_BASE+CONFIG.BFF+endpoint;
  try{
    const res=await axios.get(url,{params:{host:CONFIG.PAGE_HOST,...params},headers:CATALOG_HEADERS});
    if(res.data?.code!==0)return null;
    return res.data.data;
  }catch(e){return null;}
}

async function apiPost(endpoint,body={}){
  const url=CONFIG.API_BASE+CONFIG.BFF+endpoint;
  try{
    const res=await axios.post(url,{host:CONFIG.PAGE_HOST,...body},{
      headers:{...CATALOG_HEADERS,"Content-Type":"application/json"}
    });
    if(res.data?.code!==0)return null;
    return res.data.data;
  }catch(e){return null;}
}

async function fetchStreams(subjectId,detailPath,se,ep){
  const cookies=await getCookies();
  try{
    const res = await axios.get(`${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`,{
      params:{subjectId,se,ep},
      headers:{
        "User-Agent":"Mozilla/5.0",
        "Referer":`https://h5.aoneroom.com/movies/${detailPath||subjectId}`,
        "Cookie":cookies,
        "X-Forwarded-For":CONFIG.PH_IP,
        "X-Real-IP":CONFIG.PH_IP,
        "CF-IPCountry":"PH"
      }
    });

    if(res.data?.code!==0) return [];
    return res.data?.data?.streams || [];

  }catch(e){return [];}
}

function normalizePoster(url){
  if(!url) return null;
  return url.startsWith("http") ? url : `https://pbcdnw.aoneroom.com${url}`;
}

function parseId(id){
  const m=id.match(/^mbx_(movie|series)_(.+)$/);
  return m?{type:m[1],subjectId:m[2]}:null;
}

const manifest={
  id:"community.movieboxph",
  version:"9.0.0",
  name:"MovieBox",
  description:"MovieBox Movies & Series",
  logo:"https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
  catalogs:[
    {type:"movie",id:"mbx_movies",name:"Movies"},
    {type:"series",id:"mbx_series",name:"Series"}
  ],
  resources:["catalog","meta","stream"],
  types:["movie","series"],
  idPrefixes:["mbx_"]
};

const builder=new addonBuilder(manifest);

builder.defineCatalogHandler(async({type})=>{
  const subjectType = type==="series"?2:1;
  const data = await apiGet("/subject/trending");
  const items = (data?.subjectList||[]).filter(i=>i.subjectType===subjectType);

  const metas = items.map(i=>({
    id:`mbx_${type}_${i.subjectId}`,
    type,
    name:i.title,
    poster:normalizePoster(i.cover?.url),
    description:i.description||""
  }));

  return {metas};
});

builder.defineMetaHandler(async({type,id})=>{
  const p=parseId(id);
  if(!p) return {meta:null};

  const data = await apiGet("/subject/trending");
  const item=(data?.subjectList||[]).find(i=>String(i.subjectId)===p.subjectId);

  if(!item) return {meta:null};

  return{
    meta:{
      id,
      type,
      name:item.title,
      poster:normalizePoster(item.cover?.url),
      description:item.description||""
    }
  };
});

builder.defineStreamHandler(async({type,id})=>{
  const p=parseId(id);
  if(!p) return {streams:[]};

  const raw=await fetchStreams(p.subjectId,"",0,0);

  const streams = raw.filter(s=>s.url).map(s=>({
    name:"MovieBox",
    title:s.resolutions?`${s.resolutions}p`:"HD",
    url:`/proxy?url=${encodeURIComponent(s.url)}`,
    behaviorHints:{
      notWebReady:true
    }
  }));

  return {streams};
});

const addon = serveHTTP(builder.getInterface(),{port:PORT});

http.createServer((req,res)=>{

  if(req.url.startsWith("/proxy")){
    const q = new URL(req.url,"http://x").searchParams;
    const target = q.get("url");

    if(!target){res.writeHead(400);res.end();return;}

    const u=new URL(target);
    const lib=u.protocol==="https:"?https:http;

    const pr = lib.request({
      hostname:u.hostname,
      path:u.pathname+u.search,
      headers:{
        "Referer":"https://fmoviesunblocked.net/",
        "User-Agent":"Mozilla/5.0"
      }
    },r=>{
      res.writeHead(r.statusCode,r.headers);
      r.pipe(res);
    });

    pr.on("error",()=>res.end());
    pr.end();
  }

}).listen(PORT+1);

console.log(`Addon running on ${PORT}`);
