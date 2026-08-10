/*
 * Recommendation scoring.
 *
 * The previous version's "Suggested for you" was: take your three most-watched
 * genres, filter unwatched titles to those genres, sort by IMDb rating. That
 * surfaces the same handful of highly-rated films forever and ignores whether
 * you can actually watch them tonight.
 *
 * This scores on taste, availability, effort and novelty, and is deliberately
 * deterministic per day so the home screen doesn't reshuffle every render.
 */

/** Genre affinity from watch history, weighted towards recent viewing. */
export function tasteProfile(items) {
  const watched = items.filter((i) => i.watched);
  const genres = new Map();
  let totalWeight = 0;

  const now = Date.now();
  const YEAR = 365 * 24 * 3600 * 1000;

  for (const item of watched) {
    if (!item.genre) continue;
    /* Something watched last month says more about current taste than
       something watched two years ago. Unknown dates get a middling weight. */
    const age = item.watchedAt ? (now - item.watchedAt) / YEAR : 1;
    const weight = 1 / (1 + Math.max(0, age));
    genres.set(item.genre, (genres.get(item.genre) || 0) + weight);
    totalWeight += weight;
  }

  const affinity = new Map();
  if (totalWeight > 0) {
    for (const [g, w] of genres) affinity.set(g, w / totalWeight);
  }

  return {
    affinity,
    sampleSize: watched.length,
    top: [...genres.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g),
  };
}

/** Stable pseudo-random in [0,1) from a string — same result all day. */
function jitter(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function dayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Score a single candidate. Returns { score, why } where `why` is a short
 * human-readable reason we can show in the UI — a recommendation the user
 * can't interrogate is just noise.
 */
export function scoreItem(item, profile, ctx) {
  /* Told not to suggest this. Checked before anything else because a muted item
     is not a low-scoring item — it is not a candidate at all, and letting it
     score means it reappears the moment the rest of the library is exhausted. */
  const muted = ctx.muted;
  if (muted) {
    if (muted.never?.includes(item.uid)) return null;
    if (item.genre && muted.genres?.includes(item.genre)) return null;
    if (muted.franchises?.length) {
      const title = String(item.title || '').toLowerCase();
      if (muted.franchises.some((f) => f && title.includes(String(f).toLowerCase()))) return null;
    }
  }

  /* Owned libraries are overwhelmingly re-watch libraries. A film you rated
     highly and last saw three years ago is a perfectly good answer to "what
     tonight" — every incumbent tracker throws that signal away. */
  /* Whose re-watch? In a household, a film his partner has seen and he has not
     is a first watch for him, and offering it as a re-watch — penalised, and
     only if he loved it — would hide it entirely. `viewerSeen` is the set of
     uids the person being answered for has watched; without one, the shared
     flag is the answer, which is the solo case and the default. */
  const isRewatch = ctx.viewerSeen ? ctx.viewerSeen.has(item.uid) : item.watched;
  if (isRewatch && !ctx.allowRewatch) return null;

  /* In "tonight" mode, ownership is a hard filter, not a bonus: the whole
     premise is ranking what you can actually play right now. */
  if (ctx.ownedOnly && !item.owned) return null;

  let score = 0;
  const why = [];

  /* Taste — the dominant term once there's history to learn from. */
  const aff = profile.affinity.get(item.genre) || 0;
  if (profile.sampleSize >= 3 && aff > 0) {
    score += aff * 40;
    if (aff >= 0.18) why.push(`you watch a lot of ${item.genre.toLowerCase()}`);
  }

  /* Quality — real but secondary; a 9.0 you don't fancy is still not tonight. */
  if (item.rating) {
    score += (item.rating - 6) * 3.2;
    if (item.rating >= 8) why.push(`rated ${item.rating.toFixed(1)}`);
  }

  /* Availability. This is the app's whole premise, so it outranks the
     watchlist: something you can press play on right now beats something you
     once meant to find. */
  if (item.owned) {
    score += 18;
    why.push('you already have this');
  }

  /* Quality you actually hold. Nobody else ranks on this — trackers store
     resolution and never use it. */
  if (item.owned && item.quality) {
    if (item.quality === '4K') {
      score += ctx.primeTime ? 7 : 3;
      if (ctx.primeTime) why.push('4K, and it is a good hour for it');
    } else if (item.quality === '1080p') {
      score += 2;
    }
  }

  /* Bought and never played.
     Replaces a +12 bonus for being on a watchlist, back when there was one.
     Deliberately flat rather than scaled by age: `addedAt` is when a title
     entered the app, not when it was bought, and on a library imported in one
     go every title carries the same date. An earlier version of this scaled by
     that gap and told the user "on the shelf 3 years, never played" — a claim
     the app has no way to know, and which scored exactly zero of 295 eligible
     titles on the real library because they were all added the same week.
     A purchase date would make the age version honest; there isn't one yet. */
  if (item.owned && !item.watched) {
    score += 6;
    why.push('you own it and have not watched it');
  }

  /* Re-watches need to earn their place: only genuinely loved films, and
     only once enough time has passed that it feels like a treat. */
  if (isRewatch) {
    const yearsSince = item.watchedAt ? (Date.now() - item.watchedAt) / (365 * 24 * 3600 * 1000) : 3;
    if (yearsSince < 1) return null;
    score -= 14;
    score += Math.min(yearsSince, 6) * 2.5;
    if (item.rating >= 7.5) {
      score += 6;
      why.length = 0;
      why.push(`you loved this ${Math.round(yearsSince)} years ago`);
    } else {
      return null;
    }
  }

  /* Effort fit — late at night, a 3-hour epic is the wrong answer. */
  if (item.runtime && ctx.hour !== null) {
    const late = ctx.hour >= 22 || ctx.hour < 2;
    if (late && item.runtime <= 105) {
      score += 6;
      why.push('short enough for tonight');
    } else if (late && item.runtime >= 150) {
      score -= 7;
    }
  }

  /* Novelty — nudge away from things already dismissed in Discover. */
  if (item.seen) score -= 10;

  /* Series need a bigger commitment than a film. */
  if (item.type === 'tv') score -= 3;

  /* Missing artwork looks bad as a hero. Prefer something we can present. */
  if (!item.poster) score -= 5;

  /* Small stable shuffle so the top of the list isn't frozen forever, but
     doesn't change while you're looking at it. */
  score += jitter(item.uid + ctx.seed) * 6;

  return { score, why: why.slice(0, 2) };
}

/**
 * Rank unwatched items. `seed` defaults to today, so the pick is stable
 * across renders and refreshes but rotates daily.
 */
export function rank(
  items,
  {
    seed = dayStamp(),
    hour = new Date().getHours(),
    limit = 40,
    ownedOnly = false,
    allowRewatch = true,
    maxRuntime = null,
    /* { genres, franchises, never } — see store.tastePrefs(). Passed in rather
       than read from the store so this module has no dependency on it and its
       tests run without a browser. */
    muted = null,
    /* Set<uid> the current viewer has watched. See scoreItem. */
    viewerSeen = null,
    /* Taste is a property of the whole library, not of whatever subset is being
       ranked. A caller that has already narrowed the list — the session picker
       filters by genre and decade before it gets here — must pass the profile
       built from everything, or "90s horror" computes your taste from 90s
       horror alone and, below three watched titles in that slice, ignores taste
       entirely. */
    profile = null,
  } = {}
) {
  const taste = profile || tasteProfile(items);
  const ctx = {
    seed,
    hour,
    ownedOnly,
    allowRewatch,
    muted,
    viewerSeen,
    /* 19:00–22:00 — the window where a 4K feature on the big screen makes
       most sense. Outside it, quality matters less than length. */
    primeTime: hour >= 19 && hour < 22,
  };

  if (maxRuntime) {
    items = items.filter((i) => !i.runtime || i.runtime <= maxRuntime);
  }

  return items
    .map((item) => {
      const s = scoreItem(item, taste, ctx);
      return s ? { item, ...s } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** The single hero pick, plus a few alternates for the "something else" shuffle. */
export function tonightPick(items, { offset = 0, ...opts } = {}) {
  const ranked = rank(items, { ...opts, limit: 24 });
  if (!ranked.length) return null;
  return ranked[offset % ranked.length];
}

/**
 * "Something else" alternates, excluding whatever is currently shown.
 * Falls back to relaxing the owned filter rather than returning nothing —
 * an empty shelf is a worse answer than a slightly weaker suggestion.
 */
export function alternates(items, { exclude = [], limit = 12, ...opts } = {}) {
  const skip = new Set(exclude);
  let ranked = rank(items, { ...opts, limit: limit + skip.size }).filter((r) => !skip.has(r.item.uid));
  if (!ranked.length && opts.ownedOnly) {
    ranked = rank(items, { ...opts, ownedOnly: false, limit: limit + skip.size }).filter(
      (r) => !skip.has(r.item.uid)
    );
  }
  return ranked.slice(0, limit);
}

/**
 * Similar titles — shares a genre, close in era, not the same film.
 * Used on the detail screen.
 *
 * A shared genre is required, not merely rewarded. It reads as though scoring
 * alone would sort it out, and it does not: same type (+3), same era (+4) and
 * unwatched (+2) clear the threshold of 4 on their own, so every film from the
 * same year qualified as "more like this" regardless of what it was. The
 * function has always said "shares a genre"; now it means it.
 *
 * Any overlap counts, not just the single display genre — a film tagged
 * Horror/Thriller is a fair suggestion for a Thriller.
 */
export function similarTo(item, items, limit = 12) {
  const wanted = new Set([item.genre, ...(item.genres || [])].filter(Boolean));
  return items
    .filter((o) => o.uid !== item.uid)
    .filter((o) => [o.genre, ...(o.genres || [])].some((g) => g && wanted.has(g)))
    .map((o) => {
      let s = 0;
      if (o.genre && o.genre === item.genre) s += 10;
      if (o.type === item.type) s += 3;
      if (o.year && item.year) {
        const d = Math.abs(o.year - item.year);
        if (d <= 3) s += 4;
        else if (d <= 10) s += 2;
      }
      if (o.rating) s += (o.rating - 6) * 0.8;
      if (o.owned) s += 2;
      if (!o.watched) s += 2;
      if (!o.poster) s -= 2;
      return { item: o, score: s };
    })
    .filter((r) => r.score > 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}
