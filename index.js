const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const nameToImdb = require("name-to-imdb");

// ==== Add under your existing imports (axios, cheerio, etc.) ====
const http = axios.create({
  timeout: 10000,
  headers: {
    "User-Agent": "Stremio-DesiCinemas-Addon/1.1",
    Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  },
  httpAgent: new (require("http").Agent)({ keepAlive: true }),
  httpsAgent: new (require("https").Agent)({ keepAlive: true }),
});

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const OMDB_API_KEY = process.env.OMDB_API_KEY || "";

// --- Tiny LRU with TTL (same idea as before) ---
function createLRU(maxEntries = 800, ttlMs = 12 * 60 * 60 * 1000) {
  const map = new Map();
  return {
    get(k) {
      const v = map.get(k);
      if (!v) return null;
      if (v.expires < Date.now()) { map.delete(k); return null; }
      map.delete(k); map.set(k, v);
      return v.value;
    },
    set(k, value) {
      if (map.has(k)) map.delete(k);
      map.set(k, { value, expires: Date.now() + ttlMs });
      if (map.size > maxEntries) map.delete(map.keys().next().value);
    }
  };
}
const metaCache = createLRU();
const inflight = new Map();

// --- Helpers ---
function normalizeTitleYear(idOrName) {
  const s = decodeURIComponent(idOrName);
  const yearMatch = s.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;
  const title = s.replace(/\b(19|20)\d{2}\b/, "").trim();
  return { title, year };
}

// Pick the "best" trailer from TMDb 'videos'
function pickBestTrailer(videos, preferredLangs = ["en", "hi"]) {
  if (!Array.isArray(videos) || !videos.length) return null;
  const yt = videos.filter(v => v.site === "YouTube" && v.key);

  const rank = (v) => {
    const typeScore =
      v.type === "Trailer" ? 3 :
        v.type === "Teaser" ? 2 :
          v.type === "Clip" ? 1 : 0;
    const officialScore = v.official ? 2 : 0;
    const langPref = preferredLangs.indexOf((v.iso_639_1 || "").toLowerCase());
    const langScore = langPref >= 0 ? (preferredLangs.length - langPref) : 0;
    return typeScore * 10 + officialScore * 5 + langScore;
  };

  const best = yt.sort((a, b) => rank(b) - rank(a))[0];
  return best?.key ? `https://www.youtube.com/watch?v=${best.key}` : null;
}

async function tmdbSearchAndDetails(title, year) {
  if (!TMDB_API_KEY) return null;

  // 1) Search
  const q = new URLSearchParams({ api_key: TMDB_API_KEY, query: title });
  if (year) q.set("year", year);
  const searchUrl = `https://api.themoviedb.org/3/search/movie?${q.toString()}`;
  const search = await http.get(searchUrl).then(r => r.data).catch(() => null);
  const hit = search?.results?.[0];
  if (!hit) return null;

  // 2) Details (+videos, credits, external_ids) in one call
  const dUrl = `https://api.themoviedb.org/3/movie/${hit.id}?api_key=${TMDB_API_KEY}&append_to_response=videos,credits,external_ids,release_dates`;
  const d = await http.get(dUrl).then(r => r.data).catch(() => null);
  if (!d) return null;

  const poster = d.poster_path ? `https://image.tmdb.org/t/p/original${d.poster_path}` : null;
  const background = d.backdrop_path ? `https://image.tmdb.org/t/p/original${d.backdrop_path}` : null;
  const genres = (d.genres || []).map(g => g.name);
  const cast = (d.credits?.cast || []).slice(0, 10).map(c => c.name);

  const trailer = pickBestTrailer(d.videos?.results || [], ["en", "hi"]);

  // Directors/Writers
  const crew = d.credits?.crew || [];
  const directors = crew.filter(c => c.job === "Director").slice(0, 3).map(c => c.name);
  const writers = crew.filter(c => ["Writer", "Screenplay", "Author"].includes(c.job)).slice(0, 3).map(c => c.name);

  // Certification (optional nice-to-have)
  let certification = null;
  const rel = d.release_dates?.results || [];
  const inCert = rel.find(r => r.iso_3166_1 === "IN") || rel.find(r => r.iso_3166_1 === "US");
  if (inCert?.release_dates?.length) {
    certification = inCert.release_dates.find(r => r.certification)?.certification || null;
  }

  return {
    tmdbId: d.id,
    imdbId: d.external_ids?.imdb_id || null,
    title: d.title || d.original_title || title,
    year: (d.release_date || "").slice(0, 4) || year || "",
    description: d.overview || "",
    runtime: d.runtime || null,
    genres,
    cast,
    poster,
    background,
    trailer,
    directors,
    writers,
    certification,
    tmdbRating: typeof d.vote_average === "number" ? Math.round(d.vote_average * 10) / 10 : null,
    tmdbVotes: d.vote_count || null
  };
}

async function omdbByImdbOrTitle({ imdbId, title, year }) {
  if (!OMDB_API_KEY) return null;
  let url;
  if (imdbId) {
    url = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${encodeURIComponent(imdbId)}&plot=full`;
  } else {
    const q = new URLSearchParams({ apikey: OMDB_API_KEY, t: title, plot: "full" });
    if (year) q.set("y", year);
    url = `https://www.omdbapi.com/?${q.toString()}`;
  }
  const d = await http.get(url).then(r => r.data).catch(() => null);
  if (!d || d.Response === "False") return null;

  return {
    imdbId: d.imdbID || imdbId || null,
    imdbRating: d.imdbRating && d.imdbRating !== "N/A" ? Number(d.imdbRating) : null,
    imdbVotes: d.imdbVotes || null,
    plot: d.Plot && d.Plot !== "N/A" ? d.Plot : null,
    runtime: d.Runtime && d.Runtime.endsWith("min") ? parseInt(d.Runtime) : null,
    genres: d.Genre ? d.Genre.split(",").map(s => s.trim()) : null,
    cast: d.Actors ? d.Actors.split(",").map(s => s.trim()) : null,
    poster: d.Poster && d.Poster !== "N/A" ? d.Poster : null,
    rated: d.Rated || null
  };
}

// --- Correct base URLs ---
const BASE_URLS = {
  punjabi: "https://desicinemas.to/category/punjabi-movies/",
  hindiDubbed: "https://desicinemas.to/category/hindi-dubbed-movies/",
  hindi: "https://desicinemas.to/category/bollywood-movies/",
};

// Stremio's effective page size for 'skip' from your logs (skip=28 -> next page)
const STREMIO_PAGE_SIZE = 28; // translate skip -> page with this

// Optional headers to look more like a browser
const HTTP_OPTS = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
};

async function fetchMovies(url) {
  try {
    const { data } = await axios.get(url, HTTP_OPTS);
    const $ = cheerio.load(data);

    const movies = [];
    let totalPages = 1; // Default to 1 page

    $("main ul.MovieList li").each((_, element) => {
      let title = $(element).find(".Title").first().text().trim(); // Movie title
      title = title.replace(/\s*\([^)]*\)/g, ""); // Remove text within parentheses
      const year = $(element).find(".Qlty.Yr").text().trim(); // Year
      const img =
        $(element).find(".Image img").attr("data-src") ||
        $(element).find(".Image img").attr("src"); // Image URL
      const href = $(element).find("a").first().attr("href"); // Movie link
      const genres = [];

      // Extract genres
      $(element)
        .find(".Genre a")
        .each((i, genreEl) => {
          genres.push($(genreEl).text().trim());
        });

      if (title && href && img) {
        movies.push({
          title,
          year,
          img,
          href,
          genres,
        });
      }
    });

    // Robust pager parsing: take MAX numeric page among common pager selectors
    const nums = [];
    $("div.nav-links a, .nav-links a, a.page-link, a.page-numbers").each(
      (_, el) => {
        const t = $(el).text().trim();
        const n = parseInt(t, 10);
        if (!Number.isNaN(n)) nums.push(n);
      }
    );
    if (nums.length) totalPages = Math.max(...nums);

    return { movies, totalPages };
  } catch (error) {
    console.error(`fetchMovies error for ${url}:`, error?.message || error);
    // Always return consistent shape
    return { movies: [], totalPages: 1 };
  }
}

// Define Stremio Add-on
const manifest = {
  id: "com.stremio.desicinemas",
  version: "1.0.8",
  name: "DesiCinemas Movies",
  description:
    "Shows movies from DesiCinemas.to (Punjabi, Hindi Dubbed, and Hindi)",
  resources: ["catalog", "meta"],
  types: ["movie"],
  catalogs: [
    {
      type: "movie",
      id: "desicinemas-punjabi",
      name: "Punjabi Movies",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "movie",
      id: "desicinemas-hindi-dubbed",
      name: "Hindi Dubbed Movies",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "movie",
      id: "desicinemas-hindi",
      name: "Hindi Movies",
      extra: [{ name: "skip", isRequired: false }],
    },
  ],
};

const builder = new addonBuilder(manifest);

// Keep a cache (optional, informative)
const totalPagesCache = {
  punjabi: 1,
  hindiDubbed: 1,
  hindi: 1,
};

// Helper to resolve catalog key + base URL by args.id
function resolveCatalog(argsId) {
  if (argsId === "desicinemas-punjabi") return { key: "punjabi", base: BASE_URLS.punjabi };
  if (argsId === "desicinemas-hindi-dubbed") return { key: "hindiDubbed", base: BASE_URLS.hindiDubbed };
  if (argsId === "desicinemas-hindi") return { key: "hindi", base: BASE_URLS.hindi };
  return null;
}

// Catalog resource
builder.defineCatalogHandler(async (args) => {
  if (args.type !== "movie") return { metas: [] };

  const resolved = resolveCatalog(args.id);
  if (!resolved) return { metas: [] };

  // Use **Stremio page size** to translate skip -> page
  const skip = parseInt(args.extra?.skip || "0", 10) || 0;
  const pageNumber = Math.floor(skip / STREMIO_PAGE_SIZE) + 1;

  // Build URL: first page is base, further pages are /page/N/
  const url = pageNumber === 1 ? resolved.base : `${resolved.base}page/${pageNumber}/`;

  const { movies = [], totalPages = 1 } = await fetchMovies(url);

  // Update cache (optional)
  if (totalPages && totalPages > (totalPagesCache[resolved.key] || 1)) {
    totalPagesCache[resolved.key] = totalPages;
  }

  // Map movies to Stremio meta format
  const metas = movies.map((movie) => ({
    id: encodeURIComponent(`${movie.title} ${movie.year || ""}`.trim()),
    name: movie.title,
    poster: movie.img,
    releaseInfo: movie.year,
    type: "movie",
  }));

  return { metas };
});

// builder.defineMetaHandler(async ({ id }) => {
//   const decodedId = decodeURIComponent(id);
//
//   const imdbId = await new Promise((resolve) => {
//     nameToImdb({ name: decodedId }, (err, res) => resolve(err ? null : res));
//   });
//
//   return {
//     meta: {
//       id: imdbId || decodedId,
//       name: decodedId,
//       type: "movie",
//     },
//   };
// });

builder.defineMetaHandler(async ({ id }) => {
  const { title, year } = normalizeTitleYear(id);
  const cacheKey = `meta:${title}:${year || ""}`;

  // Serve from cache
  const cached = metaCache.get(cacheKey);
  if (cached) return { meta: cached };

  // Dedupe concurrent same lookups
  if (inflight.has(cacheKey)) {
    const meta = await inflight.get(cacheKey);
    return { meta };
  }

  const p = (async () => {
    const tmdb = await tmdbSearchAndDetails(title, year);

    // Fallback minimal meta if TMDb fails (still works, just without rich fields)
    if (!tmdb) {
      const minimal = {
        id: decodeURIComponent(id),
        type: "movie",
        name: decodeURIComponent(id),
        releaseInfo: year || "",
      };
      metaCache.set(cacheKey, minimal);
      return minimal;
    }

    const meta = {
      id: tmdb.imdbId || String(tmdb.tmdbId), // prefer imdbId if available
      type: "movie",
      name: tmdb.title,
      releaseInfo: tmdb.year,
      description: tmdb.description,
      runtime: tmdb.runtime,
      genres: tmdb.genres,
      cast: tmdb.cast,
      poster: tmdb.poster,
      background: tmdb.background,
      trailer: tmdb.trailer,
      // Stremio will show this; label it as TMDb rating if no IMDb:
      imdbRating: tmdb.rating || undefined,
    };

    metaCache.set(cacheKey, meta);
    return meta;
  })();

  inflight.set(cacheKey, p);
  try {
    const meta = await p;
    return { meta };
  } finally {
    inflight.delete(cacheKey);
  }
});
// Serve the add-on
serveHTTP(builder.getInterface(), { port: 8180 });
