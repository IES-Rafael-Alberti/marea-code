import { StudentSkills, LibrarySkills } from "./panes.js";
import { SkillDetail } from "./detail.js";
import { useEffect, useRef, useState } from "react";
import type { SkillWorkspaceStudent } from "@marea/protocol";
import type { DashboardLocale } from "../../messages.js";
import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { SkillWorkspaceController } from "./controller.js";
import { skillWorkspaceMessages, type SkillWorkspaceMessages } from "./messages.js";
import { SkillEditor } from "./editor.js";
import { SkillSelection, type Picker } from "./selection.js";
import "./workspace.css";

export function SkillsWorkspace({
  classId,
  fetchRequest,
  locale,
  teachingChanged,
}: {
  readonly classId: string | null;
  readonly fetchRequest: DashboardFetch;
  readonly locale: DashboardLocale;
  readonly teachingChanged: () => Promise<void>;
}) {
  const [, redraw] = useState(false);
  const controllers = useRef(new Map<string, SkillWorkspaceController>());
  const changed = useRef(teachingChanged);
  changed.current = teachingChanged;
  // Stryker disable next-line ConditionalExpression: No controller is ever stored under a null class; this guard narrows the map key type.
  let controller = classId === null ? undefined : controllers.current.get(classId);
  if (classId !== null && controller === undefined) {
    controller = new SkillWorkspaceController(
      classId,
      fetchRequest,
      () => {
        redraw((value) => !value);
      },
      () => changed.current(),
    );
    controllers.current.set(classId, controller);
  }
  useEffect(() => {
    if (controller && !controller.loaded) void controller.load();
  }, [controller]);
  useEffect(
    () => {
      const unload = (event: BeforeUnloadEvent) => {
        if ([...controllers.current.values()].some((item) => item.drafts.size > 0 || item.busy))
          event.preventDefault();
      };
      window.addEventListener("beforeunload", unload);
      return () => {
        window.removeEventListener("beforeunload", unload);
        for (const item of controllers.current.values()) item.dispose();
      };
    },
    // Stryker disable next-line ArrayDeclaration: A constant dependency has the same mount/unmount lifetime as an empty dependency list.
    [],
  );
  const m = skillWorkspaceMessages(locale);
  return controller ? (
    <SkillsClass key={classId} controller={controller} messages={m} />
  ) : (
    <p>{m.noClass}</p>
  );
}

export function SkillsClass({
  controller: c,
  messages: m,
}: {
  readonly controller: SkillWorkspaceController;
  readonly messages: SkillWorkspaceMessages;
}) {
  const [tab, chooseTab] = useState<"classroom" | "students" | "library">("classroom");
  const [kind, chooseKind] = useState<"didactic" | "evaluation">("didactic");
  const [query, search] = useState("");
  const [source, filterSource] = useState("all");
  const [selected, selectStudents] = useState<readonly string[]>([]);
  const [picker, pick] = useState<Picker | null>(null);
  const classSelection = c.configuration?.settings.selection ?? { didactic: [], evaluation: [] };
  const selection = classSelection[kind];
  const listProps = { c, m, query, search };
  const catalog = c.catalog.filter(
    (entry) =>
      entry.kind === kind &&
      (tab !== "classroom" || selection.some((item) => item.id === entry.id)) &&
      (source === "all" || entry.source === source) &&
      `${entry.title} ${entry.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const personalize = (students: readonly SkillWorkspaceStudent[]) => {
    const first = students[0];
    if (first === undefined) {
      selectStudents([]);
      return;
    }
    pick({
      students: students.map((item) => item.studentId),
      kind: "didactic",
      initial:
        students.length > 1
          ? classSelection.didactic
          : (first.selection ?? classSelection.didactic),
    });
  };
  return (
    <section className="skills-workspace" aria-busy={c.busy}>
      {c.problem && (
        <div className="skills-problem" role="alert">
          <p>{problemMessage(c.problem, m)}</p>
          <button
            disabled={c.busy}
            onClick={() => {
              void c.load();
            }}
          >
            {m.reload}
          </button>
        </div>
      )}
      {c.notice && (
        <p className="skills-notice" role="status">
          {m[c.notice]}
        </p>
      )}
      {c.editor ? (
        <SkillEditor
          key={c.editor.key}
          controller={c}
          messages={m}
          onReturn={() => {
            chooseTab("library");
            search("");
            filterSource("all");
          }}
        />
      ) : (
        <>
          <header className="skills-toolbar">
            <h2>Skills</h2>
            <button
              className="skills-primary"
              disabled={c.busy}
              onClick={() => {
                chooseTab("library");
                c.create(kind);
              }}
            >
              {m.newSkill}
            </button>
          </header>
          <nav className="skills-tabs" aria-label="Skills">
            {(["classroom", "students", "library"] as const).map((value) => (
              <button
                key={value}
                aria-current={tab === value ? "page" : undefined}
                onClick={() => {
                  chooseTab(value);
                  search("");
                  filterSource("all");
                }}
              >
                {m[value]}
              </button>
            ))}
          </nav>
          {!c.loaded ? (
            <p role="status">{m.loading}</p>
          ) : (
            <>
              {c.configuration === null && <p role="status">{m.noConfiguration}</p>}
              {c.configuration?.settings.agentMode === "free" && (
                <p className="skills-note">{m.free}</p>
              )}
              <div className={`skills-columns${c.detail ? " has-detail" : ""}`}>
                <div>
                  {tab === "students" ? (
                    <StudentSkills
                      {...listProps}
                      selected={selected}
                      selectStudents={selectStudents}
                      personalize={personalize}
                    />
                  ) : (
                    <LibrarySkills
                      {...listProps}
                      kind={kind}
                      chooseKind={chooseKind}
                      tab={tab}
                      pick={pick}
                      selection={selection}
                      source={source}
                      filterSource={filterSource}
                      catalog={catalog}
                    />
                  )}
                </div>
                {c.detail?.skill && (
                  <SkillDetail
                    controller={c}
                    messages={m}
                    assign={(entry) => {
                      const current = classSelection[entry.kind];
                      pick({
                        students: null,
                        kind: entry.kind,
                        initial:
                          entry.kind === "evaluation"
                            ? [{ id: entry.id, digest: entry.digest }]
                            : [
                                ...current.filter((item) => item.id !== entry.id),
                                { id: entry.id, digest: entry.digest },
                              ],
                      });
                    }}
                  />
                )}
              </div>
            </>
          )}
        </>
      )}
      {picker && (
        <SelectionDialog
          busy={c.busy}
          close={() => {
            pick(null);
          }}
        >
          <SkillSelection
            catalog={c.catalog}
            initial={picker.initial}
            kind={picker.kind}
            busy={c.busy}
            title={picker.students === null ? m.add : m.customizeMany}
            help={picker.students === null ? m.future : m.customHelp}
            messages={m}
            close={() => {
              pick(null);
            }}
            save={async (next) => {
              if (picker.students === null) await c.assignClass(next, picker.kind);
              else await c.assignStudents(picker.students, next);
              if (c.problem === null) pick(null);
            }}
          />
          <InheritSelection
            students={picker.students}
            controller={c}
            messages={m}
            close={() => {
              pick(null);
            }}
          />
          {c.problem && <p role="alert">{c.problem === "conflict" ? m.conflict : m.unavailable}</p>}
        </SelectionDialog>
      )}
    </section>
  );
}

function SelectionDialog({
  busy,
  close,
  children,
}: {
  readonly busy: boolean;
  readonly close: () => void;
  readonly children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(
    () => {
      const element = dialog.current;
      element?.showModal();
      return () => {
        element?.close();
      };
    },
    // Stryker disable next-line ArrayDeclaration: A constant dependency has the same mount/unmount lifetime as an empty dependency list.
    [],
  );
  return (
    <dialog
      ref={dialog}
      className="skills-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      {children}
    </dialog>
  );
}

function InheritSelection({
  students,
  controller: c,
  messages: m,
  close,
}: {
  readonly students: readonly string[] | null;
  readonly controller: SkillWorkspaceController;
  readonly messages: SkillWorkspaceMessages;
  readonly close: () => void;
}) {
  if (students === null) return null;
  return (
    <button
      disabled={c.busy}
      onClick={() => {
        void c.assignStudents(students, null).then(() => {
          if (c.problem === null) close();
        });
      }}
    >
      {m.inheritAction}
    </button>
  );
}

function problemMessage(problem: string, messages: SkillWorkspaceMessages) {
  return problem === "generationProblem"
    ? messages.generationProblem
    : problem === "apply"
      ? messages.applyProblem
      : problem === "conflict"
        ? messages.conflict
        : messages.unavailable;
}
