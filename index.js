const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const nameToImdb = require("name-to-imdb");


const BASE_URLS = {
  punjabi: "https://desicinemas.tv/category/punjabi/",
  hindiDubbed: "https://desicinemas.tv/category/hindi-dubbed/",
};

async function fetchMovies(url) {
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    const movies = [];

    $("main ul.MovieList li").each((index, element) => {
      let title = $(element).find(".Title").first().text().trim(); // Movie title
      title = title.replace(/\s*\([^)]*\)/g, ""); // Remove text within parentheses
      const year = $(element).find(".Qlty.Yr").text().trim(); // Year
      const img = $(element).find(".Image img").attr("data-src") || $(element).find(".Image img").attr("src"); // Image URL
      const href = $(element).find("a").first().attr("href"); // Movie link
      const genres = [];

      // Extract genres
      $(element).find(".Genre a").each((i, genreEl) => {
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


    // Get total number of pages
    const navLinks = $("div.nav-links a.page-link");
    if (navLinks.length > 0) {
      const lastPageLink = navLinks.last(); // Get the last link
      const lastPageText = lastPageLink.text().trim();
      totalPages = parseInt(lastPageText, 10) || 1; // Parse the text to a number
    }


    return { movies, totalPages };
  } catch (error) {
    return [];
  }
}

// Define Stremio Add-on
const manifest = {
  id: "com.stremio.desicinemas",
  version: "1.0.1",
  name: "DesiCinemas Movies",
  description: "Shows movies from DesiCinemas.tv (Punjabi and Hindi Dubbed)",
  resources: ["catalog", "meta"],
  types: ["movie"],
  catalogs: [
    {
      type: "movie",
      id: "desicinemas-punjabi",
      name: "Punjabi Movies",
      "extra": [
        {
          "name": "skip",
          "isRequired": false
        }
      ]
    },
    {
      type: "movie",
      id: "desicinemas-hindi-dubbed",
      name: "Hindi Dubbed Movies",
      "extra": [
        {
          "name": "skip",
          "isRequired": false
        }
      ]
    },
  ],
};

const builder = new addonBuilder(manifest);

const ITEMS_PER_PAGE = 29; // Define how many items you have per page
// Cache for total pages
const totalPagesCache = {
  punjabi: 1,
  hindiDubbed: 1,
};

// Catalog resource
builder.defineCatalogHandler(async (args) => {
  // Calculate the page number based on the skip value
  const skip = parseInt(args.extra.skip || "0", 10); // Default to 0 if skip is not provided
  const pageNumber = Math.floor(skip / ITEMS_PER_PAGE) + 1; // Convert skip to page number

  let movies = [];
  if (args.type === "movie") {
    if (args.id === "desicinemas-punjabi") {
      // Check if skip exceeds cached total pages
      if (pageNumber > totalPagesCache.punjabi) {
        return { metas: [] };
      }
      const url = pageNumber === 1 ? BASE_URLS.punjabi : `${BASE_URLS.punjabi}page/${pageNumber}/`;
      const result = await fetchMovies(url);
      movies = result.movies;

      // Update cache with the latest total pages
      if (result.totalPages) {
        totalPagesCache.punjabi = result.totalPages;
      }
    } else if (args.id === "desicinemas-hindi-dubbed") {
      // Check if skip exceeds cached total pages
      if (pageNumber > totalPagesCache.hindiDubbed) {
        return { metas: [] };
      }
      const url = pageNumber === 1 ? BASE_URLS.hindiDubbed : `${BASE_URLS.hindiDubbed}page/${pageNumber}/`;
      const result = await fetchMovies(url);
      movies = result.movies;

      // Update cache with the latest total pages
      if (result.totalPages) {
        totalPagesCache.hindiDubbed = result.totalPages;
      }
    }

    // Map movies to Stremio's meta format
    const metas = movies.map((movie) => ({
      id: movie.title, // Use URL or title as ID
      name: movie.title,
      poster: movie.img,
      releaseInfo: movie.year,
      type: "movie",
    }));

    return { metas };
  }
});

builder.defineMetaHandler(async (args) => {
  const { id } = args;
  const decodedId = decodeURIComponent(id);


  const imdbId = await new Promise((resolve, _reject) => {
    nameToImdb({ name: decodedId }, function (err, res, _inf) {
      if (err) {
        resolve(null);
      } else {
        resolve(res);
      }
    });
  });

  return Promise.resolve({
    meta: {
      id: imdbId || decodedId,
      name: id,
      type: "movie",
    },
  });
});


module.exports = (req, res) => {
  serveHTTP(builder.getInterface(), { req, res });
};

