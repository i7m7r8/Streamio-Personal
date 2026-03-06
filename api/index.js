const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const manifest = {
    id: "community.movieboxph",
    version: "10.0.0",
    name: "MovieBox",
    description: "MovieBox — Movies & Series",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    idPrefixes: ["mbx_"],

    catalogs: [
        {
            type: "movie",
            id: "mbx_movies",
            name: "MovieBox Movies",
            extra: [{ name: "search", isRequired: false }]
        }
    ]
};

const builder = new addonBuilder(manifest);

const movies = [
    {
        id: "mbx_movie_batman",
        type: "movie",
        name: "Batman Begins",
        poster: "https://image.tmdb.org/t/p/w500/1P3ZyEq02wcTMd3iE4ebtLvncvH.jpg"
    }
];

builder.defineCatalogHandler(({ extra }) => {

    let metas = movies;

    if (extra?.search) {
        metas = movies.filter(m =>
            m.name.toLowerCase().includes(extra.search.toLowerCase())
        );
    }

    return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ id }) => {

    const meta = movies.find(m => m.id === id);

    return Promise.resolve({ meta });
});

builder.defineStreamHandler(() => {

    return Promise.resolve({
        streams: [
            {
                title: "Example Stream",
                url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
            }
        ]
    });
});

module.exports = serveHTTP(builder.getInterface());
