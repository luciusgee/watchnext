/*
 * A fake TMDB for the feed's tests: enough films for many pages, in the
 * shapes the real API returns, with posters served from tools/posters when
 * they exist so screenshots look like the app.
 */
const fs = require('fs');
const path = require('path');

const POSTER_DIR = path.join(__dirname, 'posters');
const POSTERS = fs.existsSync(POSTER_DIR) ? fs.readdirSync(POSTER_DIR).filter((f) => f.endsWith('.jpg')) : [];
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

const GENRES = [27, 53, 35, 878, 18, 28, 80, 16, 10749, 99, 9648, 14];
const NAMES = { 27: 'Horror', 53: 'Thriller', 35: 'Comedy', 878: 'Science Fiction', 18: 'Drama', 28: 'Action', 80: 'Crime', 16: 'Animation', 10749: 'Romance', 99: 'Documentary', 9648: 'Mystery', 14: 'Fantasy' };

/* 600 films and 60 series. Film n has two genres, a year, a rating. */
const FILMS = Array.from({ length: 600 }, (_, n) => ({
  id: 1000 + n,
  title: `Film Number ${n}`,
  year: 1960 + (n % 66),
  genres: [GENRES[n % GENRES.length], GENRES[(n * 7 + 3) % GENRES.length]],
  rating: 5 + ((n * 37) % 45) / 10,
  votes: 100 + ((n * 53) % 4000),
}));
const SERIES = Array.from({ length: 60 }, (_, n) => ({ id: 9000 + n, title: `Series Number ${n}`, year: 2000 + (n % 26), genres: [18, 80], rating: 7.5, votes: 900 }));

/* Films with UK release dates relative to today, for New and Coming soon:
     0–19  in UK cinemas n×3 days ago, on digital 30 days after that
    20–39  coming to UK cinemas in (n−19)×4 days
    40–49  digital only, n×5 days ago
    50–54  no UK dates at all (a US release only)
    55–59  old films re-released in UK cinemas 10 days ago */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return ymd(d); };
const DATED = Array.from({ length: 60 }, (_, n) => {
  let gb = [];
  let primary;
  if (n < 20) { gb = [{ type: 3, date: shift(-n * 3) }, { type: 4, date: shift(-n * 3 + 30) }]; primary = shift(-n * 3); }
  else if (n < 40) { gb = [{ type: 3, date: shift((n - 19) * 4) }]; primary = shift((n - 19) * 4); }
  else if (n < 50) { gb = [{ type: 4, date: shift(-(n - 40) * 5) }]; primary = shift(-(n - 40) * 5); }
  else if (n < 55) { primary = shift(-(n - 49) * 4); }
  else { gb = [{ type: 3, date: shift(-10) }]; primary = `1985-0${(n % 5) + 1}-10`; }
  return {
    id: 5000 + n,
    title: n < 20 ? `Fresh Out ${n}` : n < 40 ? `Coming Up ${n}` : n < 50 ? `Digital Drop ${n}` : n < 55 ? `Elsewhere ${n}` : `Old Again ${n}`,
    year: Number(primary.slice(0, 4)),
    primary,
    gb,
    genres: [GENRES[n % GENRES.length], GENRES[(n * 5 + 1) % GENRES.length]],
    rating: 6.5,
    votes: n < 20 ? 30 : 0,
  };
});

const lite = (f, tv) => (tv
  ? { id: f.id, media_type: 'tv', name: f.title, first_air_date: `${f.year}-03-01`, poster_path: `/p${f.id}.jpg`, backdrop_path: `/b${f.id}.jpg`, overview: `The story of ${f.title}. `.repeat(6), vote_average: f.rating, vote_count: f.votes, genre_ids: f.genres }
  : { id: f.id, media_type: 'movie', title: f.title, release_date: f.primary || `${f.year}-03-01`, poster_path: `/p${f.id}.jpg`, backdrop_path: `/b${f.id}.jpg`, overview: `The story of ${f.title}. `.repeat(6), vote_average: f.rating, vote_count: f.votes, genre_ids: f.genres });

function page(rows, p, tv) {
  const start = (p - 1) * 20;
  return { page: p, total_pages: Math.ceil(rows.length / 20), results: rows.slice(start, start + 20).map((f) => lite(f, tv)) };
}

/** Route handler for api.themoviedb.org. `hits` collects request paths. */
function tmdbRoute(route, hits = []) {
  const u = new URL(route.request().url());
  hits.push(u.pathname + u.search);
  const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
  const p = Number(u.searchParams.get('page') || 1);
  const key = u.searchParams.get('api_key');
  if (key === 'bad') return json({ status_code: 7, status_message: 'Invalid API key' }, 401);
  const path = u.pathname.replace(/^\/3/, '');

  if (path === '/trending/movie/week' || path === '/movie/popular') return json(page(FILMS, p));
  if (path === '/movie/top_rated') return json(page([...FILMS].sort((a, b) => b.rating - a.rating), p));
  if (path === '/trending/tv/week') return json(page(SERIES, p, true));
  if (path === '/discover/movie') {
    /* with_genres: a|b is any of them, a,b is all of them. */
    const wg = u.searchParams.get('with_genres') || '';
    const any = wg.includes('|') ? wg.split('|').map(Number) : null;
    const all = !any && wg ? wg.split(',').map(Number) : [];
    const genreOk = (f) => (any ? any.some((g) => f.genres.includes(g)) : all.every((g) => f.genres.includes(g)));
    const gte = u.searchParams.get('release_date.gte');
    const lte = u.searchParams.get('release_date.lte');
    if (u.searchParams.get('region') === 'GB' && (gte || lte)) {
      /* TMDB: with a region, release_date.* read that country's dates of
         the listed types, and the row's release_date is the first match. */
      const types = (u.searchParams.get('with_release_type') || '1|2|3|4|5|6').split('|').map(Number);
      const pgte = u.searchParams.get('primary_release_date.gte');
      const rows = DATED.filter((f) => genreOk(f) && (!pgte || f.primary >= pgte))
        .map((f) => {
          const hit = types.map((t) => f.gb.find((r) => r.type === t && (!gte || r.date >= gte) && (!lte || r.date <= lte))).find(Boolean);
          return hit ? { ...f, primary: hit.date } : null;
        })
        .filter(Boolean);
      return json(page(rows, p));
    }
    const rows = FILMS.filter(genreOk);
    return json(page(rows, p));
  }
  let m = path.match(/^\/(movie|tv)\/(\d+)\/recommendations$/);
  if (m) return json(page(FILMS.slice(300), p));
  m = path.match(/^\/(movie|tv)\/(\d+)$/);
  if (m) {
    const tv = m[1] === 'tv';
    const f = (tv ? SERIES : [...FILMS, ...DATED]).find((x) => String(x.id) === m[2]);
    if (!f) return json({}, 404);
    const base = lite(f, tv);
    const genres = f.genres.map((id) => ({ id, name: NAMES[id] }));
    const imdb = `tt${String(f.id).padStart(7, '0')}`;
    const cast = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Hedy Lamarr'].map((name, i) => ({ name, order: i }));
    const videos = { results: [{ site: 'YouTube', type: 'Trailer', key: `yt${f.id}` }] };
    return json(tv
      ? { ...base, genres, episode_run_time: [52], number_of_seasons: 3, created_by: [{ name: 'Mary Shelley' }], tagline: 'Every season, a new door.', aggregate_credits: { cast }, external_ids: { imdb_id: imdb }, content_ratings: { results: [{ iso_3166_1: 'GB', rating: '15' }] }, videos }
      : { ...base, genres, runtime: 90 + (f.id % 60), tagline: `They never saw ${f.title} coming.`, imdb_id: imdb, credits: { cast, crew: [{ job: 'Director', name: 'Agnès Varda' }] }, external_ids: { imdb_id: imdb }, release_dates: { results: [{ iso_3166_1: 'GB', release_dates: f.gb ? f.gb.map((r) => ({ type: r.type, release_date: `${r.date}T00:00:00.000Z`, certification: '15' })) : [{ certification: '15' }] }, ...(f.gb ? [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: `${f.primary}T00:00:00.000Z`, certification: 'R' }] }] : [])] }, videos });
  }
  m = path.match(/^\/find\/(tt\d+)$/);
  if (m) {
    const id = Number(m[1].slice(2));
    const f = FILMS.find((x) => x.id === id);
    return json({ movie_results: f ? [lite(f)] : [], tv_results: [] });
  }
  if (path === '/search/multi') return json(page(FILMS.slice(0, 20), 1));
  if (path === '/configuration' || path === '/authentication') return json({ success: true });
  return json({}, 404);
}

function imageRoute(route) {
  const u = route.request().url();
  let h = 0;
  for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) >>> 0;
  return route.fulfill({
    status: 200,
    contentType: POSTERS.length ? 'image/jpeg' : 'image/gif',
    body: POSTERS.length ? fs.readFileSync(path.join(POSTER_DIR, POSTERS[h % POSTERS.length])) : GIF,
  });
}

module.exports = { tmdbRoute, imageRoute, FILMS, SERIES, DATED };
