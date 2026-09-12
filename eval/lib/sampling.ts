/**
 * Shared reproducible-sampling helpers for sample-edges.ts and sample-unresolved.ts, which
 * had identical copies of both functions before this -- extracted here rather than left
 * duplicated, since a fix to one (e.g. a shuffle-bias bug) silently wouldn't have reached
 * the other.
 */

/** Deterministic PRNG from a fixed seed -- same seed always produces the same sequence. */
export function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle using the given RNG; does not mutate the input array. */
export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
