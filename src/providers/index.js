/*
 * Provider registry.
 *
 * The matcher is source-agnostic, so adding a source is a matter of writing a
 * module that exposes { id, label, search, details, byImdbId } returning the
 * neutral Record shape from shared.js, and listing it here.
 */

import omdb from './omdb.js';
import tmdb from './tmdb.js';

export const PROVIDERS = { [omdb.id]: omdb, [tmdb.id]: tmdb };

export const DEFAULT_PROVIDER = tmdb.id;

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

export function listProviders() {
  return Object.values(PROVIDERS);
}

export { omdb, tmdb };
