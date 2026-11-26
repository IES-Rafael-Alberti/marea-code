import { MAX_SESSION_SEARCH_LENGTH } from "@marea/protocol";
import type { SessionFilters } from "./sessions-client.boundary.js";
import type { SessionsMessages } from "./sessions-messages.js";

/**
 * What the list shows, as one choice. Pending, approved and failed sessions are always closed,
 * so session state and review never need combining; each choice sets every listing filter.
 */
const SHOW = {
  all: {},
  open: { runState: "active" },
  closed: { runState: "closed" },
  pending: { evaluation: ["draft"], evidence: "with" },
  empty: { evaluation: ["draft"], evidence: "without" },
  approved: { evaluation: ["approved"] },
  failed: { evaluation: ["failed"] },
  running: { evaluation: ["queued", "running"] },
} as const satisfies Record<string, Omit<SessionFilters, "search">>;
type Show = keyof typeof SHOW;
const isShow = (value: string): value is Show => Object.hasOwn(SHOW, value);

/** The listing filters for a "show" choice, keeping the current search. */
export function showFilters(value: string, search: string | undefined): SessionFilters {
  return { search, ...(isShow(value) ? SHOW[value] : {}) };
}

export interface SessionFilterControlsProperties {
  readonly messages: SessionsMessages;
  readonly search: string;
  readonly show: string;
  readonly onSearch: (value: string) => void;
  readonly onShow: (value: string) => void;
}

/** The search and the single "show" choice of the session list, kept compact above it. */
export function SessionFilterControls({
  messages: m,
  search,
  show,
  onSearch,
  onShow,
}: SessionFilterControlsProperties) {
  return (
    <div className="session-filters">
      <input
        aria-label={m.search}
        placeholder={m.search}
        maxLength={MAX_SESSION_SEARCH_LENGTH}
        value={search}
        onChange={(event) => {
          onSearch(event.currentTarget.value);
        }}
      />
      <select
        aria-label={m.show}
        value={show}
        onChange={(event) => {
          onShow(event.currentTarget.value);
        }}
      >
        <option value="all">{m.showAll}</option>
        <option value="open">{m.showOpen}</option>
        <option value="closed">{m.showClosed}</option>
        <option value="pending">{m.showPending}</option>
        <option value="empty">{m.showEmpty}</option>
        <option value="approved">{m.showApproved}</option>
        <option value="failed">{m.showFailed}</option>
        <option value="running">{m.showRunning}</option>
      </select>
    </div>
  );
}
