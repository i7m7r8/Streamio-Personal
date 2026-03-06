const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")
const http = require("http")
const https = require("https")

const PORT = process.env.PORT || 7000

const CONFIG = {
  API_BASE: "https://h5-api.aoneroom.com",
  BFF: "/wefeed-h5api-bff",
  STREAM_HOST: "https://h5.aoneroom.com",
  STREAM_BFF: "/wefeed-h5-bff",
  PAGE_HOST: "h5.aoneroom.com",
  PH_IP: "112.198.0.1",
  PAGE_SIZE: 24,
  cookies: null,
  cookieTime: 0
}

const cache = new Map()

function cacheGet(k){
  const v = cache.get(k)
  if(!v) return null
  if(Date.now() - v.t > 300000){
    cache.delete(k)
    return null
  }
  return v.d
}

function cacheSet(k,d){
  cache.set(k,{d,t:Date.now()})
}

async function getCookies(){

  if(CONFIG.cookies && Date.now()-CONFIG.cookieTime < 1800000)
    return CONFIG.cookies

  try{

    const r = await axios.get(
      `${CONFIG.STREAM_HOST}/wefeed-h5-bff/app/get-latest-app-pkgs?app_name=moviebox`,
      {
        headers:{
          "User-Agent":"Mozilla/5.0",
          "X-Forwarded-For":CONFIG.PH_IP,
          "X-Real-IP":CONFIG.PH_IP,
          "CF-IPCountry":"PH"
        }
      }
    )

    const sc = r.headers["set-cookie"] || []

    CONFIG.cookies = sc.map(c=>c.split(";")[0]).join("; ")
    CONFIG.cookieTime = Date.now()

  }catch(e){
    CONFIG.cookies = ""
  }

  return CONFIG.cookies
}

const HEADERS = {
  "User-Agent":"Mozilla/5.0",
  "Accept":"application/json",
  "Origin":"https://h5.aoneroom.com",
  "Referer":"https://h5.aoneroom.com/"
}

async function apiGet(endpoint,params={}){

  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint

  const key = url + JSON.stringify(params)

  const c = cacheGet(key)

  if(c) return c

  try{

    const r = await axios.get(url,{
      params:{host:CONFIG.PAGE_HOST,...params},
      headers:HEADERS
    })

    if(r.data?.code !== 0) return null

    cacheSet(key,r.data.data)

    return r.data.data

  }catch{
    return null
  }
}

async function apiPost(endpoint,body={}){

  const url = CONFIG.API_BASE + CONFIG.BFF + endpoint

  const key = url + JSON.stringify(body)

  const c = cacheGet(key)

  if(c) return c

  try{

    const r = await axios.post(
      url,
      {host:CONFIG.PAGE_HOST,...body},
      {headers:{...HEADERS,"Content-Type":"application/json"}}
    )

    if(r.data?.code !== 0) return null

    cacheSet(key,r.data.data)

    return r.data.data

  }catch{
    return null
  }
}

async function resolveStream(url){

  try{

    const r = await axios.get(url,{
      headers:{
        "Referer":"https://fmoviesunblocked.net/",
        "User-Agent":"Mozilla/5.0"
      },
      maxRedirects:5,
      timeout:15000
    })

    if(r.request?.res?.responseUrl)
      return r.request.res.responseUrl

    return url

  }catch{
    return url
  }
}

async function fetchStreams(subjectId,se,ep){

  const cookies = await getCookies()

  try{

    const r = await axios.get(
      `${CONFIG.STREAM_HOST}${CONFIG.STREAM_BFF}/web/subject/play`,
      {
        params:{subjectId,se,ep},
        headers:{
          "User-Agent":"Mozilla/5.0",
          "Referer":`https://h5.aoneroom.com/movies/${subjectId}`,
          "Cookie":cookies,
          "X-Forwarded-For":CONFIG.PH_IP,
          "X-Real-IP":CONFIG.PH_IP,
          "CF-IPCountry":"PH"
        }
      }
    )

    if(r.data?.code !== 0) return []

    const streams = r.data?.data?.streams || []

    const out = []

    for(const s of streams){

      if(!s.url) continue

      const finalUrl = await resolveStream(s.url)

      out.push({
        url:finalUrl,
        res:s.resolutions || "HD",
        size:s.size || ""
      })
    }

    return out

  }catch(e){

    console.log("stream fetch error",e.message)

    return []
  }
}

function normalizePoster(url){

  if(!url) return null

  if(url.startsWith("http")) return url

  return `https://pbcdnw.aoneroom.com${url}`
}

function parseId(id){

  const m = id.match(/^mbx_(movie|series)_(.+)$/)

  if(!m) return null

  return {type:m[1],subjectId:m[2]}
}

const manifest = {
  id:"community.moviebox",
  version:"10.0.0",
  name:"MovieBox",
  description:"MovieBox Movies & Series",
  logo:"https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",
  resources:["catalog","meta","stream"],
  types:["movie","series"],
  idPrefixes:["mbx_"],
  catalogs:[
    {type:"movie",id:"mbx_movies",name:"MovieBox Movies"},
    {type:"series",id:"mbx_series",name:"MovieBox Series"}
  ]
}

const builder = new addonBuilder(manifest)

builder.defineCatalogHandler(async ({type})=>{

  const subjectType = type === "series" ? 2 : 1

  const data = await apiGet("/subject/trending")

  const items = (data?.subjectList || [])
  .filter(i=>i.subjectType === subjectType)

  const metas = items.map(i=>({

    id:`mbx_${type}_${i.subjectId}`,
    type,
    name:i.title,
    poster:normalizePoster(i.cover?.url),
    description:i.description || ""

  }))

  return {metas}
})

builder.defineMetaHandler(async ({type,id})=>{

  const p = parseId(id)

  if(!p) return {meta:null}

  const data = await apiGet("/subject/trending")

  const item = (data?.subjectList || [])
  .find(i => String(i.subjectId) === p.subjectId)

  if(!item) return {meta:null}

  return {
    meta:{
      id,
      type,
      name:item.title,
      poster:normalizePoster(item.cover?.url),
      description:item.description || ""
    }
  }
})

builder.defineStreamHandler(async ({type,id})=>{

  const parts = id.split(":")

  const base = parts[0]

  const season = parts[1] ? parseInt(parts[1]) : 0
  const episode = parts[2] ? parseInt(parts[2]) : 0

  const p = parseId(base)

  if(!p) return {streams:[]}

  const raw = await fetchStreams(p.subjectId,season,episode)

  const streams = raw.map(s=>({

    name:"MovieBox",
    title:`${s.res} ${s.size ? "· "+Math.round(s.size/1024/1024)+"MB":""}`,
    url:s.url

  }))

  return {streams}
})

serveHTTP(builder.getInterface(),{port:PORT})

console.log("MovieBox addon running")
console.log(`http://localhost:${PORT}/manifest.json`)
