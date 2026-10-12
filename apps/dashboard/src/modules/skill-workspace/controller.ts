import type { DashboardFetch } from "../active-runs/active-runs-client.boundary.js";
import { createTeachingClient } from "../teaching/teaching-client.boundary.js";
import { createSkillAuthoringClient } from "../skill-authoring/skill-authoring-client.boundary.js";
import { createSkillWorkspaceClient } from "./client.boundary.js";
import { loadSkillWorkspace } from "./load-workspace.js";
import { SkillWorkspaceState } from "./state.js";
import type { DashboardLocale } from "../../messages.js";
import type {
  SkillAuthoringReadResponse,
  SkillWorkspaceUsage,
  TeachingSettings,
} from "@marea/protocol";

type Bundle = NonNullable<SkillAuthoringReadResponse["skill"]>;
type Selection = TeachingSettings["selection"]["didactic"];
/** One controller per class, retained by the authenticated workspace while switching tabs/classes. */
export class SkillWorkspaceController extends SkillWorkspaceState {
  private readonly abort = new AbortController();
  private readonly teaching;
  private readonly authoring;
  private readonly request;
  constructor(
    readonly classId: string,
    fetch: DashboardFetch,
    changed: () => void,
    readonly teachingChanged: () => Promise<void>,
  ) {
    super(changed);
    this.teaching = createTeachingClient(fetch);
    this.authoring = createSkillAuthoringClient(fetch);
    this.request = createSkillWorkspaceClient(fetch);
  }
  private disposed() {
    return this.abort.signal.aborted;
  }
  dispose() {
    this.abort.abort();
  }

  async perform(work: () => Promise<void>) {
    if (this.busy || this.abort.signal.aborted) return;
    this.busy = true;
    this.problem = null;
    this.notice = null;
    this.changed();
    try {
      await work();
    } catch (error) {
      if (!this.disposed())
        this.problem = this.editor?.applyPending
          ? "apply"
          : error instanceof Error
            ? "code" in error && typeof error.code === "string"
              ? error.code
              : error.message
            : "unavailable";
    } finally {
      this.busy = false;
      if (!this.disposed()) this.changed();
    }
  }

  load() {
    return this.perform(() => this.refresh());
  }
  private async refresh() {
    const configuration = await this.teaching.read(this.classId, this.abort.signal);
    const { catalog, students } = await loadSkillWorkspace(
      this.request,
      this.classId,
      this.abort.signal,
    );
    this.configuration = configuration.configuration;
    this.catalog = catalog;
    this.students = students;
    this.loaded = true;
  }

  open(id: string) {
    return this.perform(async () => {
      const detail = await this.authoring.readCatalog(this.classId, id, this.abort.signal);
      if (detail.skill === null) throw new Error("unavailable");
      const usage = await this.request(
        this.classId,
        { kind: "usage", skillId: detail.skill.id },
        this.abort.signal,
      );

      this.detail = detail;
      this.deleting = false;
      this.usage = usage;
    });
  }

  generate(instructions: string, locale: DashboardLocale) {
    return this.perform(async () => {
      const editor = this.editor;
      if (!editor || editor.applyPending) return;
      const result = await this.request(
        this.classId,
        {
          kind: "generate",
          instructions,
          locale,
          slug: editor.draft.slug,
          skillKind: editor.draft.kind,
        },
        this.abort.signal,
      );
      if (this.editor === editor && !this.disposed()) this.applyGenerated(result.content);
    });
  }
  reviewDeletion() {
    return this.perform(async () => {
      const detail = this.detail;
      if (!detail?.editable || !detail.skill) return;
      this.usage = await this.request(
        this.classId,
        { kind: "usage", skillId: detail.skill.id },
        this.abort.signal,
      );
      this.deleting = true;
    });
  }
  deleteSkill() {
    return this.perform(async () => {
      const detail = this.detail;
      if (!this.deleting || !detail?.editable || !detail.skill || !this.usage) return;
      await this.request(
        this.classId,
        {
          kind: "delete",
          skillId: detail.skill.id,
          digest: detail.skill.digest,
          expectedUsage: this.usage.version,
        },
        this.abort.signal,
      );
      this.drafts.delete(detail.skill.id);
      this.closeDetail();
      await this.refresh();
      await this.teachingChanged();
      this.notice = "deleted";
    });
  }

  save() {
    return this.perform(async () => {
      const editor = this.editor;
      if (!editor) return;
      const saved = await this.authoring.save(
        this.classId,
        editor.draft,
        editor.expectedDigest,
        this.abort.signal,
      );
      this.editor = {
        ...editor,
        skillId: saved.skill.id,
        expectedDigest: saved.skill.digest,
        applyPending: true,
      };
      this.drafts.set(editor.key, this.editor);
      const usage =
        editor.usage ??
        (await this.request(
          this.classId,
          { kind: "usage", skillId: saved.skill.id },
          this.abort.signal,
        ));

      this.editor = {
        ...editor,
        skillId: saved.skill.id,
        expectedDigest: saved.skill.digest,
        applyPending: true,
        usage,
      };
      this.drafts.set(editor.key, this.editor);
      await this.applySaved(saved.skill, usage, editor.key);
    });
  }
  reviewApplication() {
    return this.perform(async () => {
      if (!this.editor?.skillId) return;
      const usage = await this.request(
        this.classId,
        { kind: "usage", skillId: this.editor.skillId as Bundle["id"] },
        this.abort.signal,
      );

      this.editor = { ...this.editor, usage };
      this.drafts.set(this.editor.key, this.editor);
    });
  }
  apply() {
    return this.perform(async () => {
      const editor = this.editor;
      if (!editor?.skillId || !editor.usage) return;
      const read = await this.authoring.readCatalog(
        this.classId,
        editor.skillId,
        this.abort.signal,
      );
      // Stryker disable next-line OptionalChaining: A missing bundle and a digest mismatch both enter the same pending-application error path without writing.
      if (read.skill?.digest !== editor.expectedDigest) throw new Error();
      await this.applySaved(read.skill, editor.usage, editor.key);
    });
  }
  private async applySaved(bundle: Bundle, usage: SkillWorkspaceUsage, key: string) {
    await this.request(
      this.classId,
      { kind: "apply", skillId: bundle.id, digest: bundle.digest, expectedUsage: usage.version },
      this.abort.signal,
    );
    this.drafts.delete(key);
    this.editor = null;
    this.beforeGeneration = null;
    this.detail = null;
    await this.refresh();
    await this.teachingChanged();
    this.notice = "saved";
  }

  assignClass(selection: Selection, kind: "didactic" | "evaluation" = "didactic") {
    return this.perform(async () => {
      const c = this.configuration;
      if (!c) throw new Error("unavailable");
      await this.teaching.save(
        this.classId,
        c.version,
        {
          ...c.settings,
          selection: { ...c.settings.selection, [kind]: selection },
          automaticEvaluation:
            kind === "evaluation" && selection.length === 0
              ? false
              : c.settings.automaticEvaluation,
        },
        this.abort.signal,
      );
      await this.refresh();
      await this.teachingChanged();
      this.notice = "assigned";
    });
  }
  assignStudents(ids: readonly string[], selection: Selection | null) {
    return this.perform(async () => {
      if (!this.configuration) throw new Error("unavailable");
      await this.request(
        this.classId,
        {
          kind: "assign",
          expectedClassVersion: this.configuration.version,
          students: ids.map((studentId) => {
            const student = this.students.find((item) => item.studentId === studentId);
            if (!student) throw new Error("unavailable");
            return { studentId, expectedVersion: student.version };
          }),
          selection,
        },
        this.abort.signal,
      );
      await this.refresh();
      this.notice = "assigned";
    });
  }
}
