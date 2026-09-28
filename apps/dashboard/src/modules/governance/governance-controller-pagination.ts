import { MAX_GOVERNANCE_PAGE_SIZE } from "@marea/protocol";

/**
 * Reads every page. Governance IDs are ASCII, so string order is the server's
 * binary SQLite order. Items must be strictly ascending after the request cursor,
 * and a continuation cursor must name the last item of its page, exactly as the
 * server pages are produced. A stale read resolves with an internal null
 * sentinel, but callers only receive an adoption opportunity when their current
 * predicate still holds, so the sentinel stays out of the consumer-facing type.
 */
export function readGovernancePages<T>(
  read: (
    afterId: string | null,
  ) => Promise<{ readonly items: readonly T[]; readonly nextAfterId: string | null }>,
  idOf: (item: T) => string,
  stillCurrent: () => boolean,
): Promise<readonly T[]>;
export async function readGovernancePages<T>(
  read: (
    afterId: string | null,
  ) => Promise<{ readonly items: readonly T[]; readonly nextAfterId: string | null }>,
  idOf: (item: T) => string,
  stillCurrent: () => boolean,
): Promise<readonly T[] | null> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    if (!stillCurrent()) return null;
    const page = await read(cursor);
    if (!stillCurrent()) return null;
    if (page.items.length > MAX_GOVERNANCE_PAGE_SIZE)
      throw new Error("Governance page exceeds its bound.");
    // IDs are non-empty, so the empty string precedes every first-page item.
    let lastId: string = cursor ?? "";
    for (const item of page.items) {
      const id = idOf(item);
      if (id <= lastId) throw new Error("Governance page items are not ascending.");
      items.push(item);
      lastId = id;
    }
    if (page.nextAfterId !== null && (page.items.length === 0 || page.nextAfterId !== lastId))
      throw new Error("Governance page cursor did not advance.");
    cursor = page.nextAfterId;
  } while (cursor !== null);
  return items;
}
