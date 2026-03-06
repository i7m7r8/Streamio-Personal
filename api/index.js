const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const manifest = {
    id: "community.movieboxph",
    version: "10.0.0",
    name: "MovieBox",
    description: "MovieBox — Movies & Series",
    logo: "https://h5-static.aoneroom.com/oneroomStatic/public/favicon.ico",

    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],

    idPrefixes: ["mbx_"],

    catalogs: [
        {
            type: "movie",
            id: "mbx_movies",
            name: "MovieBox Movies",
            extra: [{ name: "search", isRequired: false }]
        },
        {
            type: "series",
            id: "mbx_series",
            name: "MovieBox Series",
            extra: [{ name: "search", isRequired: false }]
        }
    ]
};

const builder = new addonBuilder(manifest);

/* -------------------------
   SAMPLE DATA (test data)
------------------------- */

const movies = [
    {
        id: "mbx_movie_batman",
        type: "movie",
        name: "Batman Begins",
        poster: "https://image.tmdb.org/t/p/w500/1P3ZyEq02wcTMd3iE4ebtLvncvH.jpg"
    },
    {
        id: "mbx_movie_interstellar",
        type: "movie",
        name: "Interstellar",
        poster: "https://image.tmdb.org/t/p/w500/rAiYTfKGqDCRIIqo664sY9XZIvQ.jpg"
    }
];

/* -------------------------
   CATALOG
------------------------- */

builder.defineCatalogHandler(async ({ type, id, extra }) => {

    let metas = movies;

    if (extra?.search) {
        const q = extra.search.toLowerCase();

        metas = movies.filter(m =>
            m.name.toLowerCase().includes(q)
        );
    }

    return { metas };
});

/* -------------------------
   META
------------------------- */

builder.defineMetaHandler(async ({ id }) => {

    const meta = movies.find(m => m.id === id);

    if (!meta) return { meta: null };

    return { meta };
});

/* -------------------------
   STREAM
------------------------- */

builder.defineStreamHandler(async ({ id }) => {

    return {
        streams: [
            {
                title: "Example Stream",
                url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
            }
        ]
    };
});

/* -------------------------
   EXPORT FOR VERCEL
------------------------- */

module.exports = serveHTTP(builder.getInterface());
