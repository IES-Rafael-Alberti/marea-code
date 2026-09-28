/**
 * Colours and geometry taken from the pinned Marejada reference.
 *
 * Values were measured from terminal captures. Textual resolves a "dim"
 * style by blending against the background the widget sits on, which is why the
 * same role has a different grey on the conversation and on a panel.
 */

export const PALETTE = Object.freeze({
  /** Wordmark front, user marker, focused composer border, command names. */
  accent: "#b0245e",
  /** Wordmark shadow, banner context lines, a finished tool. */
  depth: "#6e8c8a",
  /** Approval, question and error borders; a failed tool. */
  warning: "#c9a25e",
  warningDim: "#8a7144",
  depthDim: "#4e6261",
  accentDim: "#7a1e44",
  background: "#121212",
  surface: "#1e1e1e",
  panel: "#242f38",
  /** Body text on the conversation background. */
  text: "#e0e0e0",
  /** Body text on a panel. */
  textOnSurface: "#e1e1e1",
  /** Dimmed body text on the conversation background. */
  dim: "#999999",
  /** Dimmed body text on a panel. */
  dimOnSurface: "#9e9e9e",
  /** Muted text on a panel, as in a compact tool summary. */
  muted: "#a5a5a5",
  /** Muted text dimmed again, as in a command description. */
  mutedDim: "#777777",
  placeholder: "#787878",
  codeBackground: "#101010",
  code: "#ffc473",
  link: "#57a5e2",
  quote: "#999999",
  buttonApprove: "#4ebf71",
  buttonApproveFocused: "#55c076",
  buttonReject: "#b93c5b",
  buttonPrimary: "#0178d4",
  focusRing: "#0178d4",
  inputBackground: "#272727",
  inputPlaceholder: "#797979",
  inputDisabledBorder: "#1b1b1b",
  inputDisabledPlaceholder: "#595959",
  scrollThumb: "#003054",
  scrollTrack: "#000000",
  buttonApproveEdge: "#7ae998",
  buttonApproveText: "#0a180e",
  buttonApproveFocusedText: "#0b180f",
  buttonRejectEdge: "#e76580",
  buttonRejectText: "#f5e5e9",
  buttonPrimaryEdge: "#6db2ff",
  buttonPrimaryText: "#ddedf9",
  buttonDefaultEdge: "#2d2d2d",
  buttonDisabledEdge: "#252525",
  buttonDisabledText: "#6f6f6f",
  buttonRetryDisabled: "#171717",
} as const);

export const GEOMETRY = Object.freeze({
  /** Rows the composer occupies, before and after its text grows. */
  composerMinRows: 3,
  composerMaxRows: 12,
  /** Rows a tool output or an approval preview shows before it scrolls. */
  outputMaxRows: 18,
  /** Rows a compact tool summary shows before it scrolls. */
  summaryMaxRows: 7,
  /** Trailing lines of output a compact summary keeps. */
  compactOutputLines: 3,
  /** Characters of a tool argument summary before it is truncated. */
  toolSummaryLimit: 100,
  /** Milliseconds between assistant Markdown flushes. */
  streamFlushMs: 100,
} as const);
