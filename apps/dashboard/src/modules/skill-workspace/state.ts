import type {
  SkillAuthoringDraft,
  SkillAuthoringReadResponse,
  SkillLibraryEntry,
  SkillWorkspaceStudent,
  SkillWorkspaceUsage,
  TeachingConfiguration,
} from "@marea/protocol";
import { copySkillDraft, newSkillDraft, editSkillMarkdown } from "./draft.boundary.js";

interface WorkspaceEditor {
  readonly key: string;
  readonly draft: SkillAuthoringDraft;
  readonly expectedDigest: string | null;
  readonly skillId: string | null;
  readonly usage: SkillWorkspaceUsage | null;
  readonly applyPending: boolean;
}

/** Local workspace state and recoverable drafts, independent of network operations. */
export class SkillWorkspaceState {
  busy = false;
  loaded = false;
  problem: string | null = null;
  notice: "saved" | "assigned" | "deleted" | null = null;
  generated: string | null = null;
  deleting = false;
  catalog: readonly SkillLibraryEntry[] = [];
  students: readonly SkillWorkspaceStudent[] = [];
  configuration: TeachingConfiguration | null = null;
  detail: SkillAuthoringReadResponse | null = null;
  usage: SkillWorkspaceUsage | null = null;
  editor: WorkspaceEditor | null = null;
  readonly drafts = new Map<string, WorkspaceEditor>();
  constructor(readonly changed: () => void) {}
  closeDetail() {
    this.deleting = false;
    this.detail = null;
    this.usage = null;
    this.changed();
  }
  create(kind: SkillAuthoringDraft["kind"]) {
    this.generated = null;
    this.editor = this.drafts.get(`new:${kind}`) ?? {
      key: `new:${kind}`,
      draft: newSkillDraft(kind),
      expectedDigest: null,
      skillId: null,
      usage: null,
      applyPending: false,
    };
    this.drafts.set(this.editor.key, this.editor);
    this.changed();
  }
  editDetail(copy = false) {
    this.generated = null;
    const detail = this.detail;
    if (detail === null) return;
    const bundle = detail.skill;
    if (bundle === null || (!copy && !detail.editable)) return;
    const draft = {
      slug: bundle.name,
      kind: bundle.kind,
      files: bundle.files.map(({ path, content }) => ({ path, content })),
    };
    const key = copy ? `copy:${bundle.id}` : bundle.id;
    this.editor = this.drafts.get(key) ?? {
      key,
      draft: copy ? copySkillDraft(draft) : draft,
      expectedDigest: copy ? null : bundle.digest,
      skillId: copy ? null : bundle.id,
      usage: copy ? null : this.usage,
      applyPending: false,
    };
    this.drafts.set(this.editor.key, this.editor);
    this.changed();
  }
  edit(draft: SkillAuthoringDraft) {
    if (!this.editor || this.busy || this.editor.applyPending) return;
    this.editor = { ...this.editor, draft };
    this.drafts.set(this.editor.key, this.editor);
    this.changed();
  }
  copyEditor() {
    if (!this.editor || this.busy) return;
    const draft = copySkillDraft(this.editor.draft);
    this.generated = null;
    this.editor = {
      key: `copy:${draft.slug}`,
      draft,
      expectedDigest: null,
      skillId: null,
      usage: null,
      applyPending: false,
    };
    this.drafts.set(this.editor.key, this.editor);
    this.problem = null;
    this.changed();
  }
  closeEditor() {
    this.generated = null;
    this.editor = null;
    this.changed();
  }
  discardEditor() {
    this.generated = null;
    if (this.editor) this.drafts.delete(this.editor.key);
    this.editor = null;
    this.changed();
  }
  acceptGenerated() {
    if (!this.editor || this.generated === null || this.busy || this.editor.applyPending) return;
    this.edit(editSkillMarkdown(this.editor.draft, this.generated, false));
    this.discardGenerated();
  }
  discardGenerated() {
    this.generated = null;
    this.changed();
  }
  cancelDeletion() {
    this.deleting = false;
    this.changed();
  }
}
