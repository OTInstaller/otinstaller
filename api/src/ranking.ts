// Search ranking from the plan:
//   score = 1.0·bm25 + 0.35·log(1+installs30d) + 0.4·h + 0.2·v − 0.8·b − 0.15·m
// h = healthy, v = verified publisher, b = possibly broken, m = manifest held by the registry.
// Browse pages (no query) drop the bm25 term.

export const WEIGHTS = {
  bm25: 1.0,
  installs: 0.35,
  healthy: 0.4,
  verified: 0.2,
  broken: 0.8,
  manifestHeld: 0.15,
};

export interface RankInput {
  bm25?: number; // already flipped so higher is better
  installs30d: number;
  healthy: boolean;
  broken: boolean;
  verified: boolean;
  manifestHeld: boolean;
}

export function rank(r: RankInput): number {
  const w = WEIGHTS;
  return (
    (r.bm25 ?? 0) * w.bm25 +
    Math.log1p(r.installs30d) * w.installs +
    (r.healthy ? w.healthy : 0) +
    (r.verified ? w.verified : 0) -
    (r.broken ? w.broken : 0) -
    (r.manifestHeld ? w.manifestHeld : 0)
  );
}
