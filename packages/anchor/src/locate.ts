// Unified locate ladder (C-008). ONE matcher shared by the FE markdown path and the in-iframe
// sandbox bridge, so a given (snippet, offset, block-text) resolves IDENTICALLY whether the doc is
// HTML or markdown. The iframe is no longer the weaker matcher (it gained whitespace-normalize +
// fuzzy; closes GAP-005).
//
// LADDER (in order; first hit wins):
//   1. exact at the recorded offset;
//   2. nearest-occurrence — every raw indexOf hit, pick the one whose start is nearest `offset`
//      (the offset disambiguates a repeated short snippet instead of orphaning it);
//   3. whitespace-normalized — the recorded snippet may carry literal whitespace the rendered text
//      collapses (newlines, source indentation); collapse both sides, match, translate the hit back
//      to original offsets via the index map (Plannotator normalizeWithMap, Apache-2.0);
//   4. fuzzy (Levenshtein) — slide a window the snippet's length, accept the best window scoring
//      >= threshold (a small wording edit still places); below threshold → not-found, NEVER a
//      forced bogus match.
//   5. zero → null (couldn't place, GAP-005).

const FUZZY_THRESHOLD = 0.7;

/**
 * Locate the [start,end) char range of `snippet` within `blockText`, in the C-008 ladder. Returns
 * char offsets into the concatenated text of the block, or null when no tier matches (couldn't
 * place). Pure string math — no DOM — so it is identical for every caller.
 */
export function locateRange(
  blockText: string,
  snippet: string,
  offset: number,
): { start: number; end: number } | null {
  if (snippet.length === 0) return null;

  // 1. exact at the recorded offset.
  if (offset >= 0 && blockText.substr(offset, snippet.length) === snippet) {
    return { start: offset, end: offset + snippet.length };
  }

  // 2. nearest-occurrence — every raw hit, nearest to the recorded offset.
  const raw = nearestOccurrence(blockText, snippet, offset);
  if (raw) return raw;

  // 3. whitespace-normalized — match in normalized space, translate the hit back via the map.
  const haystack = normalizeWithMap(blockText);
  const needle = normalizeWithMap(snippet).text;
  if (needle.length > 0) {
    const normIdx = haystack.text.indexOf(needle);
    if (normIdx !== -1) {
      const originalStart = haystack.map[normIdx]!;
      const originalEnd = haystack.map[normIdx + needle.length - 1]! + 1;
      return { start: originalStart, end: originalEnd };
    }
  }

  // 4. fuzzy (Levenshtein) — best window scoring >= threshold.
  const fuzzy = fuzzyLocate(blockText, snippet, FUZZY_THRESHOLD);
  if (fuzzy) return fuzzy;

  return null; // 5. zero matches → couldn't place.
}

/** All start indices of `snippet` in `text`; pick the one whose start is nearest `offset`. */
export function nearestOccurrence(
  text: string,
  snippet: string,
  offset: number,
): { start: number; end: number } | null {
  let from = 0;
  let best = -1;
  let bestDist = Infinity;
  for (;;) {
    const at = text.indexOf(snippet, from);
    if (at === -1) break;
    const dist = Math.abs(at - offset);
    if (dist < bestDist) {
      bestDist = dist;
      best = at;
    }
    from = at + 1;
  }
  if (best === -1) return null;
  return { start: best, end: best + snippet.length };
}

/**
 * Whitespace-normalize a string: collapse every run of whitespace to a single space and trim the
 * ends. Returns the normalized text plus a `map[]` from each normalized-char index → its original
 * index, so a hit in normalized space can be translated back to original (node-walkable) offsets.
 * Adopted from Plannotator's `normalizeWithMap` (Apache-2.0).
 */
export function normalizeWithMap(text: string): { text: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        normalized += " ";
        map.push(i);
        inWhitespace = true;
      }
    } else {
      normalized += ch;
      map.push(i);
      inWhitespace = false;
    }
  }
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === " ") start++;
  while (end > start && normalized[end - 1] === " ") end--;
  return { text: normalized.slice(start, end), map: map.slice(start, end) };
}

/**
 * Best-effort fuzzy locate: slide a window the length of the snippet across the block text, scoring
 * each by normalized Levenshtein similarity, accept the best window scoring >= `threshold`. Cheap
 * O(n*m) but blocks are short. Returns null (couldn't place) when nothing clears the bar — it NEVER
 * forces a bogus match onto unrelated text (AS-016).
 */
export function fuzzyLocate(
  text: string,
  snippet: string,
  threshold = FUZZY_THRESHOLD,
): { start: number; end: number } | null {
  const len = snippet.length;
  if (len === 0 || text.length === 0) return null;
  let best = -1;
  let bestScore = 0;
  const last = Math.max(0, text.length - len);
  for (let i = 0; i <= last; i++) {
    const window = text.slice(i, i + len);
    const score = similarity(window, snippet);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 || bestScore < threshold) return null;
  return { start: best, end: best + len };
}

/** Normalized Levenshtein similarity in [0,1] (1 = identical). */
export function similarity(a: string, b: string): number {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
