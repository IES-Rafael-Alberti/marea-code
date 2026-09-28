import {
  SaveTeachingConfigurationRequestSchema,
  SaveTeachingConfigurationResponseSchema,
  TeachingCatalogResponseSchema,
  TeachingClassesResponseSchema,
  TeachingConfigurationResponseSchema,
  TeacherToolPolicySchema,
  TEACHING_CATALOG_PAGE_SIZE,
  type TeachingSettings,
} from "@marea/protocol";
import * as z from "zod";

import type { AuthenticatedIdentity, Clock, IdGenerator } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { RouteBudgetSchema } from "../../model-gateway/route-policy.js";
import {
  ConfiguredTeachingRouteSchema,
  TeachingConfigurationService,
} from "./configuration-service.js";
import type {
  ProductTeachingConfigurationService,
  TeachingOperatorConfiguration,
} from "./dashboard-contracts.js";
import { TeachingConfigurationError } from "./dashboard-errors.js";
import type { TeachingConfigurationRepository } from "./contracts.js";
import type { SkillId, SkillSource } from "../skills/index.js";
import { SkillSnapshotError } from "../skills/index.js";

function requireTeacher(identity: AuthenticatedIdentity): void {
  if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
}

export interface TeachingClassPageRequest {
  readonly afterClassId: string | null;
  readonly limit: number;
  readonly teacherId: string;
}

/** Lists the teacher's currently assigned classes in binary ascending order. */
export interface TeachingClassDirectory {
  listClasses(request: TeachingClassPageRequest): Promise<readonly TeachingClassRow[]>;
}

export interface TeachingClassRow {
  readonly classId: string;
  readonly displayName: string;
}

export interface TeachingSkillDirectory {
  forTeacherClass(teacherId: string, classId: string): SkillSource;
}

export interface TeachingConfigurationModuleOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly directory: TeachingClassDirectory;
  readonly operator: TeachingOperatorConfiguration;
  readonly repository: TeachingConfigurationRepository;
  readonly skills: TeachingSkillDirectory;
}

class TeachingConfigurationModuleService implements ProductTeachingConfigurationService {
  readonly #options: TeachingConfigurationModuleOptions;

  constructor(options: TeachingConfigurationModuleOptions) {
    this.#options = options;
  }

  async classes(
    identity: AuthenticatedIdentity,
    query: Parameters<ProductTeachingConfigurationService["classes"]>[1],
  ): ReturnType<ProductTeachingConfigurationService["classes"]> {
    requireTeacher(identity);
    const rows = await this.#options.directory.listClasses({
      afterClassId: query.afterClassId,
      limit: TEACHING_CATALOG_PAGE_SIZE,
      teacherId: identity.userId,
    });
    const page = rows.slice(0, TEACHING_CATALOG_PAGE_SIZE);
    return TeachingClassesResponseSchema.parse({
      classes: page.map((row) => ({ classId: row.classId, displayName: row.displayName })),
      kind: "teaching-classes-response",
      nextAfterClassId: continuation(page, rows.length, (row) => row.classId),
      protocolVersion: query.protocolVersion,
      requestId: query.requestId,
    });
  }

  async read(
    identity: AuthenticatedIdentity,
    query: Parameters<ProductTeachingConfigurationService["read"]>[1],
  ): ReturnType<ProductTeachingConfigurationService["read"]> {
    requireTeacher(identity);
    const stored = await Promise.resolve(
      this.#options.repository.loadForTeacher(identity.userId, query.classId),
    );
    return TeachingConfigurationResponseSchema.parse({
      classId: query.classId,
      configuration:
        stored === null
          ? null
          : {
              settings: settingsFrom(stored),
              version: stored.content.configurationVersion,
            },
      kind: "teaching-configuration-response",
      operatorReady: validOperatorPolicy(this.#options.operator, query.classId) !== null,
      protocolVersion: query.protocolVersion,
      requestId: query.requestId,
    });
  }

  async catalog(
    identity: AuthenticatedIdentity,
    query: Parameters<ProductTeachingConfigurationService["catalog"]>[1],
  ): ReturnType<ProductTeachingConfigurationService["catalog"]> {
    requireTeacher(identity);
    this.#options.repository.requireTeacherClass(identity.userId, query.classId);
    const source = this.#options.skills.forTeacherClass(identity.userId, query.classId);
    const [didactic, evaluation] = await Promise.all([
      source.list("didactic"),
      source.list("evaluation"),
    ]);
    // Membership may change while the asynchronous catalog reads settle.
    this.#options.repository.requireTeacherClass(identity.userId, query.classId);
    const entries = [...didactic, ...evaluation]
      .map((summary) => ({
        compatibility: summary.compatibility,
        description: summary.description,
        digest: summary.digest,
        id: summary.id,
        kind: summary.kind,
        name: summary.name,
        source: summary.source,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    const requestedCursor = query.afterSkillId;
    const filtered =
      requestedCursor === null ? entries : entries.filter((entry) => entry.id > requestedCursor);
    const page = filtered.slice(0, TEACHING_CATALOG_PAGE_SIZE);
    return TeachingCatalogResponseSchema.parse({
      classId: query.classId,
      kind: "teaching-catalog-response",
      nextAfterSkillId: continuation(page, filtered.length, (row) => row.id),
      protocolVersion: query.protocolVersion,
      requestId: query.requestId,
      skills: page,
    });
  }

  async save(
    identity: AuthenticatedIdentity,
    request: Parameters<ProductTeachingConfigurationService["save"]>[1],
  ): ReturnType<ProductTeachingConfigurationService["save"]> {
    requireTeacher(identity);
    // Parse the shared request before any operator or source lookup.
    const parsedResult = SaveTeachingConfigurationRequestSchema.safeParse(request);
    if (!parsedResult.success) throw new TeachingConfigurationError("invalid-request");
    const parsed = parsedResult.data;
    this.#options.repository.requireTeacherClass(identity.userId, parsed.classId);
    const operator = validOperatorPolicy(this.#options.operator, parsed.classId);
    if (operator === null) throw new TeachingConfigurationError("operator-unconfigured");
    const source = this.#options.skills.forTeacherClass(identity.userId, parsed.classId);
    await verifySelections(source, parsed.settings.selection.didactic, "didactic");
    await verifySelections(source, parsed.settings.selection.evaluation, "evaluation");
    const service = new TeachingConfigurationService({
      clock: this.#options.clock,
      ids: this.#options.ids,
      repository: this.#options.repository,
      routes: { forClass: () => operator.route },
      skills: { forTeacherClass: () => source },
    });
    try {
      const stored = await service.save(identity, {
        agentMode: parsed.settings.agentMode,
        automaticEvaluation: parsed.settings.automaticEvaluation,
        classId: parsed.classId,
        classInstructions: parsed.settings.classInstructions,
        expectedVersion: parsed.expectedVersion,
        selection: parsed.settings.selection,
        teacherToolPolicy: operator.teacherToolPolicy,
      });
      return SaveTeachingConfigurationResponseSchema.parse({
        classId: parsed.classId,
        configuration: {
          settings: settingsFrom(stored),
          version: stored.content.configurationVersion,
        },
        kind: "teaching-configuration-saved",
        protocolVersion: parsed.protocolVersion,
        requestId: parsed.requestId,
      });
    } catch (error) {
      if (error instanceof SkillSnapshotError) {
        throw new TeachingConfigurationError("skill-unavailable");
      }
      // Wire-valid selections can still exceed the frozen prompt/context budget.
      if (error instanceof z.ZodError) {
        throw new TeachingConfigurationError("invalid-request");
      }
      throw error;
    }
  }
}

function settingsFrom(stored: {
  classInstructions: TeachingSettings["classInstructions"];
  content: { automaticEvaluation: boolean };
  publicTemplate: { agentMode: TeachingSettings["agentMode"] };
  selection: TeachingSettings["selection"];
}): TeachingSettings {
  return {
    agentMode: stored.publicTemplate.agentMode,
    automaticEvaluation: stored.content.automaticEvaluation,
    classInstructions: stored.classInstructions,
    selection: stored.selection,
  };
}

/** One extra directory row determines the nullable binary keyset continuation. */
function continuation<T>(
  page: readonly T[],
  total: number,
  cursor: (row: T) => string,
): string | null {
  if (total <= TEACHING_CATALOG_PAGE_SIZE) return null;
  // A continued page is always full, so the final entry exists.
  return cursor(page[TEACHING_CATALOG_PAGE_SIZE - 1] as T);
}

interface CapturedOperatorPolicy {
  readonly route: z.infer<typeof ConfiguredTeachingRouteSchema> & {
    readonly providerRoute: { readonly budget: z.infer<typeof RouteBudgetSchema> };
  };
  readonly teacherToolPolicy: z.infer<typeof TeacherToolPolicySchema>;
}

function validOperatorPolicy(
  operator: TeachingOperatorConfiguration,
  classId: string,
): CapturedOperatorPolicy | null {
  const declared = operator.forClass(classId);
  if (declared === null) return null;
  // Copy before any await so caller edits cannot alter the captured operator value.
  const route = ConfiguredTeachingRouteSchema.safeParse(structuredClone(declared.route));
  if (!route.success) return null;
  const toolPolicy = TeacherToolPolicySchema.safeParse(structuredClone(declared.teacherToolPolicy));
  if (!toolPolicy.success) return null;
  const budget = route.data.providerRoute.budget;
  const budgetResult = RouteBudgetSchema.safeParse(budget);
  if (!budgetResult.success) return null;
  return {
    route: {
      ...route.data,
      providerRoute: { ...route.data.providerRoute, budget: budgetResult.data },
    },
    teacherToolPolicy: toolPolicy.data,
  };
}

async function verifySelections(
  source: SkillSource,
  revisions: readonly { digest: string; id: SkillId }[],
  kind: "didactic" | "evaluation",
): Promise<void> {
  const summaries = await source.list(kind);
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  for (const revision of revisions) {
    const summary = byId.get(revision.id);
    if (summary?.digest !== revision.digest) {
      throw new TeachingConfigurationError("skill-unavailable");
    }
  }
}

/** Composes the server-side teaching configuration service from injected host ports. */
export function createTeachingConfigurationModule(options: TeachingConfigurationModuleOptions): {
  service: ProductTeachingConfigurationService;
} {
  return Object.freeze({ service: new TeachingConfigurationModuleService(options) });
}
