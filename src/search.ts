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

/** Build the searchable text.
 *
 * `isSearchable` decides which tokens contribute characters. It exists because
 * "ซ่อนคำที่ไม่ใช้" hides cut and excluded words with CSS while the index kept
 * counting them — so the search was reading text the editor could not see.
 * Searching a phrase that looked contiguous on screen found nothing (a hidden
 * cut word sat between its halves), the counter reported matches with nothing
 * visible to show for them, and jumping to a match seeked to audio that had
 * already been cut out (reported 2026-08-24: "ตัวค้นหากับตัวอักษรไม่ตรงกัน").
 *
 * Skipped tokens still get an entry in `tokenStartOffsets`, so token indices
 * keep their meaning. A skipped token shares the offset of the next token
 * that does contribute, and tokenAtOffset resolves such a tie to the LAST
 * one — which is the visible token the character actually belongs to.
 */
export function buildSearchIndex(
  project: Project,
  isSearchable?: (index: number) => boolean,
): SearchIndex {
  let text = "";
  const tokenStartOffsets: number[] = [];
  for (let i = 0; i < project.transcription.tokens.length; i++) {
    tokenStartOffsets.push(text.length);
    if (!isSearchable || isSearchable(i)) {
      text += project.effectiveText(i);
    }
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
