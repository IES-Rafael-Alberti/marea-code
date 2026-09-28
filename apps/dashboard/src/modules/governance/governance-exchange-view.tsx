import type { ReactElement } from "react";

import { formText, type GovernanceViewProperties } from "./governance-view-parts.js";

export function GovernanceExchangeView({
  m,
  state,
  controller,
}: GovernanceViewProperties): ReactElement | null {
  if (!state.classRevisionLoaded) return null;
  const preview = state.importPreview;
  const reviewed = preview !== null && state.importPreviewReviewedId === preview.previewId;
  return (
    <section className="governance-exchange" aria-label={m.exchange}>
      <h4>{m.exchange}</h4>
      {state.currentTeachingVersion === null ? (
        <p>{m.revisionMissing}</p>
      ) : (
        <button
          disabled={state.busy}
          onClick={() => {
            void controller.exportClass();
          }}
        >
          {m.export}
        </button>
      )}
      {state.exportedPackage !== null && (
        <label>
          {m.exported}
          <textarea readOnly rows={6} value={JSON.stringify(state.exportedPackage, null, 2)} />
        </label>
      )}
      <form
        onSubmit={(event) => {
          controller.stageImportText(formText(event, "importText"));
        }}
      >
        <label>
          {m.importText}
          <textarea name="importText" rows={6} maxLength={1_048_576} />
        </label>
        <button type="submit">{m.stage}</button>
      </form>
      {state.importPackage !== null && (
        <div className="governance-staged">
          <p>{state.importPackage.source.displayName}</p>
          <button
            disabled={state.busy}
            onClick={() => {
              void controller.previewClassImport();
            }}
          >
            {m.preview}
          </button>
          <button
            onClick={() => {
              controller.setImportPackage(null);
            }}
          >
            {m.clearPackage}
          </button>
        </div>
      )}
      {preview !== null && (
        <div className="governance-preview" role="region" aria-label={m.previewHeading}>
          <h5>{m.previewHeading}</h5>
          <dl>
            <dt>{m.agentMode}</dt>
            <dd>{preview.settings.agentMode}</dd>
            <dt>{m.instructions}</dt>
            <dd>{preview.settings.classInstructions[preview.settings.agentMode]}</dd>
          </dl>
          <p>
            {m.selection(
              preview.settings.selection.didactic.length,
              preview.settings.selection.evaluation.length,
            )}
          </p>
          <p>{m.preservesPolicy}</p>
          <p>
            <time dateTime={preview.expiresAt}>{m.expiresAt(preview.expiresAt)}</time>
          </p>
          {state.importPreviewExpired && <p role="alert">{m.expired}</p>}
          {!reviewed && <p>{m.unreviewed}</p>}
          <button
            disabled={state.busy || state.importPreviewExpired || !reviewed}
            onClick={() => {
              void controller.confirmClassImport();
            }}
          >
            {m.confirm}
          </button>
          <button
            disabled={state.busy}
            onClick={() => {
              void controller.cancelClassImport();
            }}
          >
            {m.cancel}
          </button>
        </div>
      )}
    </section>
  );
}
