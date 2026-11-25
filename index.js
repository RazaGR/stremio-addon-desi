const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
if (!TMDB_API_KEY) console.warn("TMDB_API_KEY is not set - catalogs will be empty");

const http = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  timeout: 10000,
  headers: { "User-Agent": "Stremio-Desi-Addon/2.0", Accept: "application/json" },
  httpAgent: new (require("http").Agent)({ keepAlive: true }),
  httpsAgent: new (require("https").Agent)({ keepAlive: true }),
});

// --- Tiny LRU with TTL ---
function createLRU(maxEntries, ttlMs) {
  const map = new Map();
  return {
    get(k) {
      const v = map.get(k);
      if (!v) return undefined;
      if (v.expires < Date.now()) { map.delete(k); return undefined; }
      map.delete(k); map.set(k, v);
      return v.value;
    },
    set(k, value) {
      if (map.has(k)) map.delete(k);
      map.set(k, { value, expires: Date.now() + ttlMs });
      if (map.size > maxEntries) map.delete(map.keys().next().value);
    },
  };
}
const HOUR = 60 * 60 * 1000;
const pageCache = createLRU(300, 3 * HOUR);   // discover/search pages
const imdbCache = createLRU(20000, 7 * 24 * HOUR); // tmdb id -> imdb id (rarely changes)
const metaCache = createLRU(800, 12 * HOUR);

async function tmdb(path, params = {}) {
  if (!TMDB_API_KEY) return null;
  const { data } = await http
    .get(path, { params: { api_key: TMDB_API_KEY, ...params } })
    .catch((err) => {
      console.error(`TMDB ${path} failed:`, err?.response?.status || err.message);
      return { data: null };
    });
  return data;
}

const img = (p, size = "w500") => (p ? `https://image.tmdb.org/t/p/${size}${p}` : undefined);
const today = () => new Date().toISOString().slice(0, 10);

// --- Catalog definitions ---
// TMDB does not track dubbed audio, so "Hindi Dubbed" uses South Indian
// originals (Telugu/Tamil/Malayalam/Kannada), which is what that category
// almost always contained. K-dramas are listed as Korean-language TV dramas.
const CATALOGS = {
  "desi-punjabi": {
    name: "Punjabi Movies", type: "movie", langs: ["pa"],
    discover: { with_original_language: "pa" },
  },
  "desi-hindi": {
    name: "Hindi Movies", type: "movie", langs: ["hi"],
    discover: { with_original_language: "hi" },
  },
  "desi-hindi-dubbed": {
    name: "Hindi Dubbed (South) Movies", type: "movie", langs: ["te", "ta", "ml", "kn"],
    discover: { with_original_language: "te|ta|ml|kn" },
  },
  "desi-kdrama": {
    name: "K-Dramas", type: "series", langs: ["ko"],
    discover: { with_original_language: "ko", with_genres: "18" }, // 18 = Drama
  },
  // No source records dub audio tracks. Best proxy: K-dramas streaming in
  // India on platforms whose K-drama catalogue is mostly Hindi dubs.
  "desi-kdrama-hindi": {
    name: "K-Dramas (Hindi Dubbed)", type: "series", langs: ["ko"], noSearch: true,
    discover: { with_original_language: "ko", watch_region: "IN" },
    providers: /minitv|mx ?player/i,
  },
};

// Resolve TMDB watch-provider ids by name (ids aren't documented, names are stable).
let providerIdsPromise = null;
function getProviderIds(pattern) {
  if (!providerIdsPromise) {
    providerIdsPromise = tmdb("/watch/providers/tv", { watch_region: "IN" }).then((d) => {
      if (!d) providerIdsPromise = null; // retry next time
      return d?.results || [];
    });
  }
  return providerIdsPromise.then((list) =>
    list.filter((p) => pattern.test(p.provider_name)).map((p) => p.provider_id).join("|")
  );
}

const SORTS = ["Latest", "Popular", "Top Rated"];

function sortParams(type, sort) {
  const dateField = type === "movie" ? "primary_release_date" : "first_air_date";
  switch (sort) {
    case "Popular":
      return { sort_by: "popularity.desc" };
    case "Top Rated":
      return { sort_by: "vote_average.desc", "vote_count.gte": 50 };
    default: // Latest: already released, with at least a little traction to skip junk
      return { sort_by: `${dateField}.desc`, [`${dateField}.lte`]: today(), "vote_count.gte": 2 };
  }
}

const TMDB_PAGE_SIZE = 20;

async function getImdbId(kind, tmdbId) {
  const key = `${kind}:${tmdbId}`;
  const cached = imdbCache.get(key);
  if (cached !== undefined) return cached;
  const ext = await tmdb(`/${kind}/${tmdbId}/external_ids`);
  const id = ext?.imdb_id || null;
  if (ext) imdbCache.set(key, id); // don't cache failures
  return id;
}

// Turn TMDB results into Stremio metas. Prefer IMDb ids so Cinemeta and
// stream addons recognise the items; movies without one fall back to a
// tmdb: id served by our own meta handler. Series need IMDb ids for
// episode lists, so those without one are skipped.
async function toMetas(results, type) {
  const kind = type === "movie" ? "movie" : "tv";
  const metas = await Promise.all(
    results.map(async (r) => {
      const imdbId = await getImdbId(kind, r.id);
      if (!imdbId && type === "series") return null;
      const date = r.release_date || r.first_air_date || "";
      return {
        id: imdbId || `tmdb:${r.id}`,
        type,
        name: r.title || r.name || r.original_title || r.original_name,
        poster: img(r.poster_path),
        background: img(r.backdrop_path, "original"),
        description: r.overview || undefined,
        releaseInfo: date.slice(0, 4) || undefined,
      };
    })
  );
  return metas.filter(Boolean);
}

async function fetchCatalogPage(cat, { page, sort, search }) {
  const kind = cat.type === "movie" ? "movie" : "tv";
  const cacheKey = JSON.stringify([cat.name, page, sort, search]);
  const cached = pageCache.get(cacheKey);
  if (cached) return cached;

  let results;
  if (search) {
    // TMDB search can't filter by language, so filter the results ourselves.
    const data = await tmdb(`/search/${kind}`, { query: search, page, include_adult: false });
    results = (data?.results || []).filter((r) => cat.langs.includes(r.original_language));
  } else {
    const extra = {};
    if (cat.providers) {
      extra.with_watch_providers = await getProviderIds(cat.providers);
      if (!extra.with_watch_providers) return [];
    }
    const data = await tmdb(`/discover/${kind}`, {
      ...cat.discover,
      ...extra,
      ...sortParams(cat.type, sort),
      include_adult: false,
      page,
    });
    results = data?.results || [];
  }

  const metas = await toMetas(results, cat.type);
  if (results.length) pageCache.set(cacheKey, metas);
  return metas;
}

const manifest = {
  id: "com.stremio.desicinemas",
  version: "2.1.0",
  name: "Desi Movies & K-Dramas",
  description: "Punjabi, Hindi and South Indian movies plus Korean dramas, powered by TMDB.",
  resources: ["catalog", { name: "meta", types: ["movie"], idPrefixes: ["tmdb:"] }],
  types: ["movie", "series"],
  catalogs: Object.entries(CATALOGS).map(([id, c]) => ({
    type: c.type,
    id,
    name: c.name,
    extra: [
      { name: "skip", isRequired: false },
      ...(c.noSearch ? [] : [{ name: "search", isRequired: false }]),
      { name: "genre", isRequired: false, options: SORTS },
    ],
  })),
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra = {} }) => {
  const cat = CATALOGS[id];
  if (!cat || cat.type !== type) return { metas: [] };

  const skip = parseInt(extra.skip || "0", 10) || 0;
  const page = Math.floor(skip / TMDB_PAGE_SIZE) + 1;
  const metas = await fetchCatalogPage(cat, {
    page,
    sort: SORTS.includes(extra.genre) ? extra.genre : "Latest",
    search: extra.search?.trim() || null,
  });
  return { metas, cacheMaxAge: 3 * 60 * 60 };
});

// Only used for movies that have no IMDb id (id "tmdb:<id>").
// Everything with an IMDb id gets its meta from Cinemeta.
function pickBestTrailer(videos, preferredLangs = ["en", "hi"]) {
  const yt = (videos || []).filter((v) => v.site === "YouTube" && v.key);
  const rank = (v) => {
    const typeScore = { Trailer: 3, Teaser: 2, Clip: 1 }[v.type] || 0;
    const langPref = preferredLangs.indexOf((v.iso_639_1 || "").toLowerCase());
    return typeScore * 10 + (v.official ? 5 : 0) + (langPref >= 0 ? preferredLangs.length - langPref : 0);
  };
  return yt.sort((a, b) => rank(b) - rank(a))[0];
}

builder.defineMetaHandler(async ({ type, id }) => {
  const tmdbId = id.startsWith("tmdb:") ? id.slice(5) : null;
  if (type !== "movie" || !tmdbId) return { meta: null };

  const cached = metaCache.get(id);
  if (cached) return { meta: cached };

  const d = await tmdb(`/movie/${tmdbId}`, { append_to_response: "videos,credits" });
  if (!d) return { meta: null };

  const trailer = pickBestTrailer(d.videos?.results);
  const crew = d.credits?.crew || [];
  const meta = {
    id,
    type: "movie",
    name: d.title || d.original_title,
    releaseInfo: (d.release_date || "").slice(0, 4),
    description: d.overview || undefined,
    runtime: d.runtime ? `${d.runtime} min` : undefined,
    genres: (d.genres || []).map((g) => g.name),
    cast: (d.credits?.cast || []).slice(0, 10).map((c) => c.name),
    director: crew.filter((c) => c.job === "Director").slice(0, 3).map((c) => c.name),
    poster: img(d.poster_path),
    background: img(d.backdrop_path, "original"),
    imdbRating: d.vote_average ? (Math.round(d.vote_average * 10) / 10).toString() : undefined,
    trailers: trailer ? [{ source: trailer.key, type: "Trailer" }] : undefined,
  };
  metaCache.set(id, meta);
  return { meta };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 8180 });
