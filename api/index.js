const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")

const PORT = process.env.PORT || 7000

const API = "https://movieboxapi.simatwa.dev"

function buildPoster(url) {
    if (!url) return null
    if (url.startsWith("http")) return url
    return "https://image.tmdb.org/t/p/w500" + url
}

const manifest = {
    id: "community.moviebox",
    version: "1.0.0",
    name: "MovieBox",
    description: "MovieBox streaming addon",
    types: ["movie", "series"],
    resources: ["catalog", "meta", "stream"],
    idPrefixes: ["mbx"],
    catalogs: [
        {
            type: "movie",
            id: "moviebox_movies",
            name: "MovieBox Movies",
            extra: [{ name: "search", isRequired: false }]
        },
        {
            type: "series",
            id: "moviebox_series",
            name: "MovieBox Series",
            extra: [{ name: "search", isRequired: false }]
        }
    ]
}

const builder = new addonBuilder(manifest)

builder.defineCatalogHandler(async ({ type, extra }) => {

    try {

        let url

        if (extra && extra.search) {
            url = `${API}/search?q=${encodeURIComponent(extra.search)}`
        } else {
            url = `${API}/trending`
        }

        const res = await axios.get(url)

        const items = res.data.results || []

        const metas = items
            .filter(i => type === "movie" ? i.type === "movie" : i.type === "series")
            .map(i => ({
                id: `mbx_${i.type}_${i.id}`,
                type: i.type,
                name: i.title,
                poster: buildPoster(i.poster)
            }))

        return { metas }

    } catch (e) {

        console.log("Catalog error:", e.message)

        return { metas: [] }
    }

})

builder.defineMetaHandler(async ({ type, id }) => {

    try {

        const parts = id.split("_")
        const mediaId = parts[2]

        const res = await axios.get(`${API}/info?id=${mediaId}`)

        const data = res.data

        const meta = {
            id,
            type,
            name: data.title,
            poster: buildPoster(data.poster),
            description: data.description
        }

        if (type === "series") {

            meta.videos = []

            data.episodes.forEach(ep => {

                meta.videos.push({
                    id: `${id}:${ep.season}:${ep.episode}`,
                    season: ep.season,
                    episode: ep.episode,
                    title: ep.title
                })

            })
        }

        return { meta }

    } catch (e) {

        console.log("Meta error:", e.message)

        return { meta: null }
    }

})

builder.defineStreamHandler(async ({ id }) => {

    try {

        const parts = id.split(":")

        const base = parts[0]

        const season = parts[1]
        const episode = parts[2]

        const mediaId = base.split("_")[2]

        let url

        if (season && episode) {
            url = `${API}/stream?id=${mediaId}&season=${season}&episode=${episode}`
        } else {
            url = `${API}/stream?id=${mediaId}`
        }

        const res = await axios.get(url)

        const streams = (res.data.streams || []).map(s => ({
            name: "MovieBox",
            title: s.quality || "Stream",
            url: s.url
        }))

        return { streams }

    } catch (e) {

        console.log("Stream error:", e.message)

        return { streams: [] }
    }

})

serveHTTP(builder.getInterface(), { port: PORT })

console.log("Addon running at http://localhost:" + PORT)
