const { addonBuilder, serveHTTP } = require("stremio-addon-sdk")
const axios = require("axios")

const PORT = process.env.PORT || 7000

const API = "https://h5-api.aoneroom.com/wefeed-h5api-bff"
const STREAM_API = "https://h5.aoneroom.com/wefeed-h5-bff"

const headers = {
    "User-Agent": "Mozilla/5.0",
    "Origin": "https://h5.aoneroom.com",
    "Referer": "https://h5.aoneroom.com/"
}

function poster(url) {
    if (!url) return null
    if (url.startsWith("http")) return url
    return "https://pbcdnw.aoneroom.com" + url
}

const manifest = {
    id: "community.moviebox",
    version: "2.0.0",
    name: "MovieBox",
    description: "MovieBox Movies & Series",
    types: ["movie", "series"],
    resources: ["catalog", "meta", "stream"],
    idPrefixes: ["mbx"],
    catalogs: [
        {
            type: "movie",
            id: "movies",
            name: "MovieBox Movies",
            extra: [{ name: "search", isRequired: false }]
        },
        {
            type: "series",
            id: "series",
            name: "MovieBox Series",
            extra: [{ name: "search", isRequired: false }]
        }
    ]
}

const builder = new addonBuilder(manifest)

function toMeta(item) {

    const type = item.subjectType === 2 ? "series" : "movie"

    return {
        id: `mbx_${type}_${item.subjectId}`,
        type,
        name: item.title,
        poster: poster(item.cover?.url)
    }
}

builder.defineCatalogHandler(async ({ type, extra }) => {

    try {

        let items = []

        if (extra && extra.search) {

            const res = await axios.post(
                API + "/subject/search",
                {
                    keyword: extra.search,
                    page: "1",
                    perPage: 20
                },
                { headers }
            )

            items = res.data.data.items || []

        } else {

            const res = await axios.get(
                API + "/subject/trending",
                { headers }
            )

            items = res.data.data.subjectList || []
        }

        const metas = items
            .map(toMeta)
            .filter(m => m.type === type)

        return { metas }

    } catch (e) {

        console.log("Catalog error:", e.message)

        return { metas: [] }
    }

})

builder.defineMetaHandler(async ({ id }) => {

    const parts = id.split("_")
    const type = parts[1]
    const subjectId = parts[2]

    return {
        meta: {
            id,
            type,
            name: "MovieBox Item"
        }
    }

})

builder.defineStreamHandler(async ({ type, id }) => {

    try {

        const parts = id.split(":")
        const base = parts[0]

        const subjectId = base.split("_")[2]

        const season = parts[1] || 0
        const episode = parts[2] || 0

        const res = await axios.get(
            STREAM_API + "/web/subject/play",
            {
                params: {
                    subjectId,
                    se: season,
                    ep: episode
                },
                headers
            }
        )

        const raw = res.data?.data?.streams || []

        const streams = raw.map(s => ({
            name: "MovieBox",
            title: s.resolutions + "p",
            url: s.url
        }))

        return { streams }

    } catch (e) {

        console.log("Stream error:", e.message)

        return { streams: [] }
    }

})

serveHTTP(builder.getInterface(), { port: PORT })

console.log("MovieBox addon running on port " + PORT)
