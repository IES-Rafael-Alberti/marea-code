import type { SubmitEvent } from "react";

import type { SkillAuthoringReadResponse } from "@marea/protocol";

import type {
  SkillAuthoringActions,
  SkillAuthoringNavigationTarget,
  SkillAuthoringState,
} from "./skill-authoring-contracts.js";
import {
  draftForBundle,
  SkillAuthoringEditor,
  SkillAuthoringLiveEditor,
} from "./skill-authoring-editor.js";
import type { SkillAuthoringFileExchange } from "./skill-authoring-files.js";
import type { SkillAuthoringMessages } from "./skill-authoring-messages.js";

type SkillBundle = NonNullable<SkillAuthoringReadResponse["skill"]>;

export interface SkillAuthoringViewProperties {
  readonly state: SkillAuthoringState;
  readonly controller: SkillAuthoringActions;
  readonly messages: SkillAuthoringMessages;
  readonly files: SkillAuthoringFileExchange;
  readonly liveFileOperations?: boolean;
}

function targetName(target: SkillAuthoringNavigationTarget): string {
  if (target.kind === "class") return target.classId;
  if (target.kind === "skill") return target.skillId;
  return target.slug;
}

function formText(event: SubmitEvent<HTMLFormElement>, name: string): string {
  const value = new FormData(event.currentTarget).get(name);
  return typeof value === "string" ? value : "";
}

export function skillAuthoringFileContextKey(
  state: SkillAuthoringState,
  bundle: SkillBundle | null,
): string {
  return [
    state.classId ?? "",
    state.selectedSkillId ?? "",
    state.personalSlug ?? "",
    bundle?.id ?? "",
    bundle?.digest ?? "",
    state.recovery?.skill?.id ?? "",
    state.recovery?.skill?.digest ?? "",
    state.problem ?? "",
  ].join("|");
}

export function resolveSkillAuthoringLiveFileOperations(value: boolean | undefined): boolean {
  return value ?? false;
}

export function resolveSkillAuthoringEditor(value: boolean | undefined) {
  return value === true ? SkillAuthoringLiveEditor : SkillAuthoringEditor;
}

function CatalogEntry({
  state,
  entry,
  controller,
  messages: m,
}: {
  readonly state: SkillAuthoringState;
  readonly entry: SkillAuthoringState["catalog"][number];
  readonly controller: SkillAuthoringActions;
  readonly messages: SkillAuthoringMessages;
}) {
  const selected = state.selectedSkillId === entry.id;
  const disabled = state.busy || state.pendingTarget !== null;
  return (
    <li
      className={`skill-authoring-catalog-entry${selected ? " skill-authoring-catalog-entry-selected" : ""}`}
    >
      <button
        disabled={disabled}
        aria-current={selected ? "true" : undefined}
        onClick={() => void controller.selectSkill(entry.id)}
      >
        {entry.name}
      </button>
      <dl>
        <dt>{m.source}</dt>
        <dd>{entry.source}</dd>
        <dt>{m.kind}</dt>
        <dd>{entry.kind === "didactic" ? m.didactic : m.evaluation}</dd>
        <dt>{m.digest}</dt>
        <dd>
          <code>{entry.digest}</code>
        </dd>
      </dl>
      <p>{entry.description}</p>
    </li>
  );
}

function ClassNavigation({
  state,
  controller,
  messages: m,
}: {
  readonly state: SkillAuthoringState;
  readonly controller: SkillAuthoringActions;
  readonly messages: SkillAuthoringMessages;
}) {
  const classOptions = state.classes.map(({ classId, displayName }) => (
    <option key={classId} value={classId}>
      {displayName}
    </option>
  ));
  const selectedClassId = state.classId;
  const submitPersonal = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const slug = formText(event, "personalSlug").trim();
    if (slug.length > 0) void controller.startPersonalDraft(slug);
  };
  const navigationDisabled = state.busy || state.pendingTarget !== null;
  return (
    <>
      <section
        className="skill-authoring-classes"
        aria-labelledby="skill-authoring-classes-heading"
      >
        <h3 id="skill-authoring-classes-heading">{m.classesHeading}</h3>
        {state.problem === "load" && <p role="alert">{m.errors.load}</p>}
        {!state.classesLoaded && <p role="status">{m.classesLoading}</p>}
        {state.classesLoaded && state.classes.length === 0 && <p role="status">{m.classesEmpty}</p>}
        <button disabled={state.busy} onClick={() => void controller.loadClasses()}>
          {m.reloadClasses}
        </button>
        {state.classes.length > 0 && (
          <label>
            {m.classSelector}
            <select
              disabled={navigationDisabled}
              value={state.classId ?? ""}
              onChange={(event) => void controller.selectClass(event.currentTarget.value)}
            >
              <option value="" disabled>
                {m.chooseClass}
              </option>
              {classOptions}
            </select>
          </label>
        )}
      </section>
      {selectedClassId !== null && (
        <section
          className="skill-authoring-catalog"
          aria-labelledby="skill-authoring-catalog-heading"
        >
          <h3 id="skill-authoring-catalog-heading">{m.catalogHeading}</h3>
          <button
            disabled={navigationDisabled}
            onClick={() => {
              void controller.loadCatalog(selectedClassId);
            }}
          >
            {m.reloadCatalog}
          </button>
          {!state.catalogLoaded && <p role="status">{m.catalogLoading}</p>}
          {state.catalogLoaded && state.catalog.length === 0 && (
            <p role="status">{m.catalogEmpty}</p>
          )}
          <ul className="skill-authoring-catalog-list">
            {state.catalog.map((entry) => (
              <CatalogEntry
                key={entry.id}
                controller={controller}
                entry={entry}
                messages={m}
                state={state}
              />
            ))}
          </ul>
          <form className="skill-authoring-personal-form" onSubmit={submitPersonal}>
            <h4>{m.personalHeading}</h4>
            <label htmlFor="skill-authoring-personal-slug">{m.personalSlug}</label>
            <input
              id="skill-authoring-personal-slug"
              maxLength={64}
              name="personalSlug"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              defaultValue={state.personalSlug ?? ""}
            />
            <button disabled={navigationDisabled} type="submit">
              {m.newPersonal}
            </button>
          </form>
        </section>
      )}
    </>
  );
}

function NavigationConfirmation({
  target,
  state,
  controller,
  messages: m,
}: {
  readonly target: SkillAuthoringNavigationTarget;
  readonly state: SkillAuthoringState;
  readonly controller: SkillAuthoringActions;
  readonly messages: SkillAuthoringMessages;
}) {
  return (
    <section
      className="skill-authoring-switch"
      role="alertdialog"
      aria-labelledby="skill-authoring-switch-heading"
    >
      <h3 id="skill-authoring-switch-heading">{m.pendingHeading}</h3>
      <p>{m.pendingPrompt(targetName(target))}</p>
      <button disabled={state.busy} onClick={() => void controller.confirmNavigation(true)}>
        {m.discardAndNavigate}
      </button>
      <button disabled={state.busy} onClick={() => void controller.confirmNavigation(false)}>
        {m.cancelNavigation}
      </button>
    </section>
  );
}

function RecoveryReadback({
  response,
  state,
  controller,
  messages: m,
}: {
  readonly response: NonNullable<SkillAuthoringState["recovery"]>;
  readonly state: SkillAuthoringState;
  readonly controller: SkillAuthoringActions;
  readonly messages: SkillAuthoringMessages;
}) {
  const bundle = response.skill;
  return (
    <section
      className="skill-authoring-recovery"
      aria-labelledby="skill-authoring-recovery-heading"
    >
      <h3 id="skill-authoring-recovery-heading">{m.recoveryHeading}</h3>
      <p>{m.recoveryNote}</p>
      {bundle === null ? (
        <p role="status">{m.noSkill}</p>
      ) : (
        <ReadOnlyFiles bundle={bundle} messages={m} />
      )}
      <button
        disabled={state.busy}
        onClick={() => {
          controller.acceptReadback();
        }}
      >
        {m.acceptReadback}
      </button>
    </section>
  );
}

function ReadOnlyFiles({
  bundle,
  messages: m,
}: {
  readonly bundle: SkillBundle;
  readonly messages: SkillAuthoringMessages;
}) {
  return (
    <div className="skill-authoring-readback-files">
      {bundle.files.map((file) => (
        <article key={file.path}>
          <h4>{file.path === "SKILL.md" ? m.mainFile : file.path}</h4>
          <pre>{file.content}</pre>
        </article>
      ))}
    </div>
  );
}

export function SkillAuthoringView({
  state,
  controller,
  messages: m,
  files,
  liveFileOperations,
}: SkillAuthoringViewProperties) {
  const usesLiveFileOperations = resolveSkillAuthoringLiveFileOperations(liveFileOperations);
  return (
    <>
      <ClassNavigation controller={controller} messages={m} state={state} />
      <SkillAuthoringStatus controller={controller} messages={m} state={state} />
      <SkillAuthoringDraftPanel
        controller={controller}
        files={files}
        liveFileOperations={usesLiveFileOperations}
        messages={m}
        state={state}
      />
    </>
  );
}

function SkillAuthoringStatus({
  state,
  controller,
  messages: m,
}: {
  readonly state: SkillAuthoringState;
  readonly controller: SkillAuthoringActions;
  readonly messages: SkillAuthoringMessages;
}) {
  return (
    <>
      {state.pendingTarget !== null && (
        <NavigationConfirmation
          controller={controller}
          messages={m}
          state={state}
          target={state.pendingTarget}
        />
      )}
      {state.problem !== null && state.problem !== "load" && (
        <p role="alert">{m.errors[state.problem]}</p>
      )}
      {state.classId === null && <p role="status">{m.chooseClass}</p>}
      {state.classId !== null &&
        (state.personalSlug !== null ||
          state.recovery !== null ||
          state.problem === "uncertain") && (
          <button disabled={state.busy} onClick={() => void controller.reload()}>
            {m.reload}
          </button>
        )}
      {state.classId !== null && state.draft === null && state.personalSlug === null && (
        <p role="status">{m.chooseSkill}</p>
      )}
      {state.classId !== null && state.draft === null && state.personalSlug !== null && (
        <p role="status">{m.noDraft}</p>
      )}
      {state.recovery !== null && (
        <RecoveryReadback
          controller={controller}
          messages={m}
          response={state.recovery}
          state={state}
        />
      )}
      {state.loadedBundle === null && state.personalSlug !== null && state.draft === null && (
        <p className="skill-authoring-note">{m.noSkill}</p>
      )}
    </>
  );
}

function SkillAuthoringDraftPanel({
  state,
  controller,
  messages: m,
  files,
  liveFileOperations,
}: SkillAuthoringViewProperties) {
  const bundle = state.loadedBundle;
  const draft = state.draft ?? (bundle === null ? null : draftForBundle(bundle));
  const blocked =
    state.problem === "conflict" || state.problem === "uncertain" || state.recovery !== null;
  const copySource =
    state.selectedSkillId !== null && bundle !== null
      ? { skillId: state.selectedSkillId, digest: bundle.digest }
      : null;
  const fileContext = skillAuthoringFileContextKey(state, bundle);
  const Editor = resolveSkillAuthoringEditor(liveFileOperations);
  return draft === null ? null : (
    <Editor
      blocked={blocked}
      busy={state.busy}
      copy={(sourceSkillId, sourceDigest, slug) => {
        return controller.copySkill(sourceSkillId, sourceDigest, slug);
      }}
      copySource={copySource}
      contextKey={fileContext}
      dirty={state.dirty}
      draft={draft}
      edit={(nextDraft) => {
        controller.editDraft(nextDraft);
      }}
      expectedDigest={bundle?.source === "teacher" ? bundle.digest : null}
      files={files}
      loadedBundle={bundle}
      messages={m}
      validate={() => controller.validateDraft()}
      validation={state.validation}
      save={(expectedDigest) => controller.saveDraft(expectedDigest)}
      editable={state.editable}
    />
  );
}
