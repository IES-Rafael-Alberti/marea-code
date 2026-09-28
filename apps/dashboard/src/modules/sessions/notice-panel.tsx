import type { NoticeController } from "./notice-controller.js";
import type { SessionsMessages } from "./sessions-messages.js";
export function NoticePanel({
  controller,
  messages: m,
}: {
  readonly controller: NoticeController;
  readonly messages: SessionsMessages;
}) {
  const state = controller.state;
  return (
    <section className="notice-composer" aria-label={m.message} aria-busy={state.busy}>
      {state.publication === null ? (
        <>
          <label>
            {m.message}
            <textarea
              maxLength={16384}
              value={state.draft}
              disabled={state.busy || state.uncertain}
              onChange={(event) => {
                controller.edit(event.currentTarget.value);
              }}
            />
          </label>
          <button
            disabled={state.busy}
            onClick={() => {
              void controller.send();
            }}
          >
            {state.uncertain ? m.retry : m.send}
          </button>
        </>
      ) : (
        <>
          <p className="message-text">{state.publication.notice.text}</p>
          <p role="status">
            {state.publication.acknowledgedAt === null ? m.published : m.received}
          </p>
          <button
            disabled={state.busy}
            onClick={() => {
              controller.newMessage();
            }}
          >
            {m.newMessage}
          </button>
        </>
      )}
      {state.uncertain && (
        <>
          <p role="alert">{m.uncertain}</p>
          <button
            disabled={state.busy}
            onClick={() => {
              void controller.refresh();
            }}
          >
            {m.reconcile}
          </button>
        </>
      )}
      {state.error && <p role="alert">{m.error}</p>}
    </section>
  );
}
