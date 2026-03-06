const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")

const PORT = process.env.PORT || 7000

const API = "https://h5-api.aoneroom.com/wefeed-h5api-bff"

const manifest = {
    id: "moviebox.community",
    version: "1.0.0",
    name: "MovieBox",
    description: "MovieBox movies and series",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["mbx"],
    catalogs: [
        { type: "movie", id: "moviebox_movies", name: "MovieBox Movies" },
        { type: "series", id: "moviebox_series", name: "MovieBox Series" }
    ]
}

const builder = new addonBuilder(manifest)

async function apiGet(endpoint, params = {}) {

    const res = await axios.get(API + endpoint, {
        params: { host: "h5.aoneroom.com", ...params },
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://h5.aoneroom.com/"
        }
    })

    if (res.data.code !== 0) return null

    return res.data.data
}

function poster(url) {
    if (!url) return null
    if (url.startsWith("http")) return url
    return "https://pbcdnw.aoneroom.com" + url
}

function parseId(id) {
    const parts = id.split("_")
    return {
        type: parts[1],
        subjectId: parts[2]
    }
}

builder.defineCatalogHandler(async ({ type }) => {

    const subjectType = type === "series" ? 2 : 1

    const data = await apiGet("/subject/trending")

    if (!data) return { metas: [] }

    const metas = data.subjectList
        .filter(i => i.subjectType === subjectType)
        .slice(0, 50)
        .map(i => ({
            id: `mbx_${type}_${i.subjectId}`,
            type,
            name: i.title,
            poster: poster(i.cover?.url)
        }))

    return { metas }
})

builder.defineMetaHandler(async ({ type, id }) => {

    const p = parseId(id)

    const data = await apiGet("/subject/detail", {
        subjectId: p.subjectId
    })

    if (!data) return { meta: null }

    const meta = {
        id,
        type,
        name: data.title,
        poster: poster(data.cover?.url),
        description: data.description
    }

    if (type === "series") {

        meta.videos = []

        data.seasonList?.forEach(season => {

            season.episodeList?.forEach(ep => {

                meta.videos.push({
                    id: `${id}:${season.se}:${ep.ep}`,
                    season: season.se,
                    episode: ep.ep,
                    title: ep.title
                })

            })

        })

    }

    return { meta }
})

builder.defineStreamHandler(async ({ id }) => {

    const parts = id.split(":")

    const base = parts[0]

    const season = parts[1] || 1
    const episode = parts[2] || 1

    const p = parseId(base)

    const epData = await apiGet("/subject/episode", {
        subjectId: p.subjectId,
        se: season
    })

    if (!epData) return { streams: [] }

    const ep = epData.episodeList.find(e => e.ep == episode)

    if (!ep) return { streams: [] }

    const play = await apiGet("/play", {
        episodeId: ep.episodeId
    })

    if (!play) return { streams: [] }

    const streams = play.streamList.map(s => ({
        name: "MovieBox",
        title: s.resolution,
        url: s.url
    }))

    return { streams }
})

serveHTTP(builder.getInterface(), { port: PORT })

console.log("Addon running on " + PORT)
