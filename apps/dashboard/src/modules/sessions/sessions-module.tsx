import { conversationToolGroups } from "./conversation-tool-groups.js";
import { conversationHistory } from "./conversation-history.js";
import { TurnSummary } from "./turn-summary.js";
import { useEffect, useRef, useState } from "react";
import type { TeachingClassSummary } from "@marea/protocol";
import type { DashboardLocale } from "../../messages.js";
import { EvaluationReview } from "../evaluation/evaluation-module.js";
import type { SessionsController } from "./sessions-controller.js";
import { sessionsMessages } from "./sessions-messages.js";
import { ConversationEvent } from "./conversation-events.js";
import { NoticePanel } from "./notice-panel.js";
export interface SessionsModuleProperties {
  readonly locale: DashboardLocale;
  readonly classSelection?: boolean;
  readonly controller: SessionsController;
  readonly classes: readonly TeachingClassSummary[];
}
export function SessionsModule({
  locale,
  controller,
  classes,
  classSelection = true,
}: SessionsModuleProperties) {
  const m = sessionsMessages(locale);
  const state = controller.state;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("conversation");
  const [unread, setUnread] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    follow.current = true;
    setUnread(false);
    setTab("conversation");
  }, [state.runId]);
  useEffect(() => {
    const element = scroll.current;
    if (element === null) return;
    if (follow.current) element.scrollTop = element.scrollHeight;
    else setUnread(true);
  }, [state.events.length]);
  const runs = state.runs.filter(
    (run) =>
      (filter === "all" || run.state === filter) &&
      `${run.studentDisplayName} ${run.projectDisplayName}`
        .toLocaleLowerCase(locale)
        .includes(search.toLocaleLowerCase(locale)),
  );
  const context = state.events.find((event) => event.eventType === "project-context");
  const selected = state.selected;
  const review = controller.review;
  return (
    <section
      className={`session-workspace ${state.runId === null ? "show-list" : "show-detail"}`}
      aria-label={m.heading}
    >
      <aside className="session-list">
        <h2>{m.heading}</h2>
        {classSelection && (
          <label>
            {m.classLabel}
            <select
              value={state.classId ?? ""}
              onChange={(event) => {
                void controller.chooseClass(event.currentTarget.value || null);
              }}
            >
              <option value="">{m.all}</option>
              {classes.map((item) => (
                <option key={item.classId} value={item.classId}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        <input
          aria-label={m.search}
          placeholder={m.search}
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
          }}
        />
        <select
          aria-label={m.any}
          value={filter}
          onChange={(event) => {
            setFilter(event.currentTarget.value);
          }}
        >
          <option value="all">{m.any}</option>
          <option value="active">{m.active}</option>
          <option value="closed">{m.closed}</option>
        </select>
        {runs.length === 0 && <p>{m.empty}</p>}
        <ul>
          {runs.map((run) => (
            <li key={run.runId}>
              <button
                aria-current={run.runId === state.runId ? "true" : undefined}
                onClick={() => {
                  void controller.select(run.runId);
                }}
              >
                <strong>{run.studentDisplayName}</strong>
                <span>{run.projectDisplayName}</span>
                <small>
                  {run.classDisplayName} · {run.state === "active" ? m.active : m.closed}
                </small>
              </button>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button
            disabled={state.moreBusy}
            onClick={() => {
              void controller.newest();
            }}
          >
            {m.newest}
          </button>
          <button
            disabled={state.next === null || state.moreBusy}
            onClick={() => {
              void controller.more();
            }}
          >
            {m.more}
          </button>
        </div>
      </aside>
      <div className="session-detail">
        <header className="session-detail-header">
          <button
            className="session-back"
            onClick={() => {
              void controller.select(null);
            }}
          >
            {m.back}
          </button>
          <h2>{selected?.studentDisplayName ?? m.conversation}</h2>
          <p>{selected?.projectDisplayName}</p>
          {context?.eventType === "project-context" && (
            <p className="project-context">
              {[context.cwd, context.branch, context.repositoryUrl].filter(Boolean).join(" · ")}
            </p>
          )}
          <p role="status" className={`connection-${state.connection}`}>
            {m[state.connection]}
            {state.catchingUp ? ` · ${m.catchingUp}` : ""}
          </p>
          <p className="muted">{m.freshness}</p>
        </header>
        {state.runId === null ? (
          <p className="empty-state">{m.choose}</p>
        ) : (
          <>
            <nav className="detail-tabs" aria-label={m.conversation}>
              <button
                aria-pressed={tab === "conversation"}
                onClick={() => {
                  setTab("conversation");
                }}
              >
                {m.conversation}
              </button>
              <button
                aria-pressed={tab === "evaluation"}
                onClick={() => {
                  setTab("evaluation");
                  void controller.openEvaluation();
                }}
              >
                {m.evaluation}
              </button>
            </nav>
            <div hidden={tab !== "conversation"}>
              <div
                className="conversation-scroll"
                ref={scroll}
                tabIndex={0}
                aria-label={m.conversation}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  follow.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 48;
                  if (follow.current) setUnread(false);
                }}
              >
                {state.events.length === 0 && <p>{m.nothing}</p>}
                {conversationToolGroups(conversationHistory(state.events)).map(
                  ({ event, result }) => (
                    <div
                      key={event.eventId}
                      className={
                        event.eventType === "tool-started" ? "conversation-tool-group" : undefined
                      }
                    >
                      <ConversationEvent event={event} messages={m} />
                      {result !== undefined && <ConversationEvent event={result} messages={m} />}
                      {event.eventType === "turn-ended" && (
                        <TurnSummary
                          events={state.events}
                          messageId={event.messageId}
                          messages={m}
                        />
                      )}
                    </div>
                  ),
                )}
              </div>
              {unread && (
                <button
                  className="follow-latest"
                  onClick={() => {
                    follow.current = true;
                    setUnread(false);
                    if (scroll.current !== null)
                      scroll.current.scrollTop = scroll.current.scrollHeight;
                  }}
                >
                  {m.latest}
                </button>
              )}
              <details className="session-diagnostics">
                <summary>{m.diagnostics}</summary>
                <p>{m.diagnosticsHelp}</p>
                <pre>
                  {JSON.stringify(
                    {
                      runId: state.runId,
                      events: state.events.filter(
                        (event) =>
                          event.eventType !== "student-message" &&
                          event.eventType !== "assistant-message",
                      ),
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              {controller.notice !== undefined && (
                <NoticePanel controller={controller.notice} messages={m} />
              )}
            </div>
            <div hidden={tab !== "evaluation"}>
              {review !== undefined && (
                <EvaluationReview locale={locale} state={review.state} controller={review} />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
