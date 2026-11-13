import Fuse from 'fuse.js';

export function normalize(value) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function createSearch(candidates) {
  // Keep Fuse's default matching and ranking; normalize only the searchable text.
  const fuse = new Fuse(candidates.map((candidate) => ({
    candidate,
    name: normalize(candidate.name),
    aliases: candidate.aliases.map(normalize),
  })), { keys: ['name', 'aliases'] });
  return (query) => {
    const normalized = normalize(query);
    return normalized ? fuse.search(normalized, { limit: 10 }).map(({ item }) => item.candidate) : [];
  };
}
