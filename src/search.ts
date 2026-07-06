import type { Project } from "./project";

/** Thai has no spaces, so a query can span token boundaries ("วันนี้เรา" = 2
 * tokens). We search the concatenated effective text and map character
 * offsets back to token indices. */

export interface SearchIndex {
  /** All effective token texts joined with no separator. */
  text: string;
  /** tokenStartOffsets[i] = offset of token i's first char in `text`. */
  tokenStartOffsets: number[];
}

export interface SearchMatch {
  startToken: number;
  endToken: number; // inclusive
}

export function buildSearchIndex(project: Project): SearchIndex {
  let text = "";
  const tokenStartOffsets: number[] = [];
  for (let i = 0; i < project.transcription.tokens.length; i++) {
    tokenStartOffsets.push(text.length);
    text += project.effectiveText(i);
  }
  return { text, tokenStartOffsets };
}

/** Last token whose start offset is <= offset (binary search). */
export function tokenAtOffset(index: SearchIndex, offset: number): number {
  const starts = index.tokenStartOffsets;
  let lo = 0;
  let hi = starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function findMatches(index: SearchIndex, query: string): SearchMatch[] {
  const q = query.trim();
  if (!q || index.text.length === 0) return [];
  const matches: SearchMatch[] = [];
  let pos = index.text.indexOf(q);
  while (pos !== -1) {
    matches.push({
      startToken: tokenAtOffset(index, pos),
      endToken: tokenAtOffset(index, pos + q.length - 1),
    });
    pos = index.text.indexOf(q, pos + 1);
  }
  return matches;
}
