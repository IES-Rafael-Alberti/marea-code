import { ServerSettingsService } from "../../server-settings/service.boundary.js";
import type { ServerSettingsStore } from "../../server-settings/contracts.js";
import type { InferenceProviderCatalogEntry } from "@marea/plugin-api";
import { EducationalInsightsService } from "../../educational-insights/service.js";
import type { EducationalConfiguration } from "../../educational-insights/configuration.js";
import { ReviewedEvidenceService } from "../../reviewed-evidence/service.js";
import { SqliteReviewedEvidenceRepository } from "../persistence/sqlite-reviewed-evidence-repository.js";
import { UsageHealthService } from "../../usage-health/service.js";
import { SqliteUsageHealthRepository } from "../persistence/sqlite-usage-health-repository.js";
import type { DashboardProfileEndpoint } from "../../dashboard-profiles/contracts.js";
import type { InferenceDiagnosticSink } from "../../model-gateway/inference-failure.boundary.js";
import { RevisionIdSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { ClassBootstrapService } from "../../classes/class-bootstrap-service.js";
import { ActiveRunsService } from "../../dashboard-api/active-runs-service.js";
import { createEvaluationModule } from "../../evaluation/evaluation-module.js";
import type { GovernanceIdGenerator } from "../../governance/authority.js";
import { createGovernanceService } from "../../governance/service.boundary.js";
import type {
  Clock,
  IdGenerator,
  PasswordHasher,
  SecretDigest,
  SecretIssuer,
} from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { IdentityService } from "../../identity/identity-service.js";
import type { ConfiguredIdentityProvider } from "../../external-identity/contracts.js";
import { ExternalAccessService } from "../../external-identity/access-service.js";
import { ExternalIdentityService } from "../../external-identity/service.js";
import { SqliteExternalIdentityRepository } from "../persistence/sqlite-external-identity-repository.js";
import type { ModelGatewayRetryScheduler } from "../../model-gateway/contracts.js";
import { RunInferenceService } from "../../model-gateway/run-inference-service.js";
import type {
  InferenceProviderResolver,
  TeacherProductHttpOptions,
  TeacherProductServices,
} from "../../product-http/contracts.js";
import { HistoryService } from "../../sessions/history-service.js";
import { NoticeService } from "../../sessions/notice-service.js";
import { RunSessionService } from "../../sessions/run-session-service.js";
import { createProductSkillAuthoringService } from "../../teaching/authoring-runtime/skill-authoring-service.js";
import { SkillAuthoringSource } from "../../teaching/authoring/skill-authoring-source.boundary.js";
import { SkillAuthoringStore } from "../../teaching/authoring/skill-authoring-store.boundary.js";
import { ConfigurationSnapshotSource } from "../../teaching/configuration/configuration-snapshot-source.js";
import type { TeachingOperatorConfiguration } from "../../teaching/configuration/dashboard-contracts.js";
import { createTeachingConfigurationModule } from "../../teaching/configuration/dashboard-module.js";
import { CompositeSkillSource } from "../../teaching/skills/composite-skill-source.js";
import { RunSkillService } from "../../teaching/skills/run-skill-service.js";
import type { SkillSource } from "../../teaching/skills/skill-source.js";
import type { IdentityCreationGuard } from "../persistence/identity-creation-guard.js";
import { GovernanceSourceCoordinator } from "../persistence/governance-source-coordinator.js";
import { SqliteClassroomRepository } from "../persistence/sqlite-classroom-repository.js";
import { SqliteDashboardRepository } from "../persistence/sqlite-dashboard-repository.js";
import { SqliteEvaluationRepository } from "../persistence/sqlite-evaluation-repository.js";
import { createSqliteGovernanceRepository } from "../persistence/sqlite-governance-repository.js";
import { SqliteGovernanceSessionResolver } from "../persistence/sqlite-governance-session-resolver.js";
import { SqliteHistoryRepository } from "../persistence/sqlite-history-repository.js";
import { SqliteIdentityRepository } from "../persistence/sqlite-identity-repository.js";
import { SqliteNoticeRepository } from "../persistence/sqlite-notice-repository.js";
import { SqliteRunSessionRepository } from "../persistence/sqlite-run-session-repository.js";
import { SqliteRunSkillRepository } from "../persistence/sqlite-run-skill-repository.js";
import { SqliteTeachingConfigurationRepository } from "../persistence/sqlite-teaching-configuration-repository.js";
import { SqliteTeachingDashboardRepository } from "../persistence/sqlite-teaching-dashboard-repository.js";
import { SqliteUsageLedger } from "../persistence/sqlite-usage-ledger.js";

/** Explicitly configured skill owners; nothing is scanned or defaulted. */
interface TeacherHostSkillOwners {
  readonly core: SkillSource;
  readonly centers: ReadonlyMap<string, string>;
  readonly teachers: ReadonlyMap<string, string>;
  readonly operatorPersonalOwnerForClass: ReadonlyMap<string, string>;
}

export interface TeacherHostServiceDependencies {
  readonly serverSettings?: {
    readonly store: ServerSettingsStore;
    readonly catalog: readonly InferenceProviderCatalogEntry[];
  };
  /** Activate after validating the matched production dashboard release. */
  readonly profiles?:
    ((database: SqliteApplicationDatabase) => DashboardProfileEndpoint) | undefined;
  readonly educationalInsights?: EducationalConfiguration | undefined;
  readonly database: SqliteApplicationDatabase;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly secrets: SecretIssuer;
  readonly digest: SecretDigest;
  readonly passwords: PasswordHasher;
  readonly dummyPasswordHash: string;
  readonly operator: TeachingOperatorConfiguration;
  readonly skills: TeacherHostSkillOwners;
  readonly providers: InferenceProviderResolver;
  readonly retry: ModelGatewayRetryScheduler;
  readonly identities: IdentityCreationGuard;
  /** Installed and configured identity provider plugins; none disables external sign-in. */
  readonly identityProviders?: readonly ConfiguredIdentityProvider[];
  readonly evaluationIntervalMs: number;
  readonly onInferenceDiagnostic?: InferenceDiagnosticSink | undefined;
  readonly onEvaluationError: () => void;
}

export interface TeacherHostServices {
  readonly services: TeacherProductServices;
  readonly governance: NonNullable<TeacherProductHttpOptions["governance"]>;
  /** Exclusive startup recovery, then background evaluation; stop before closing storage. */
  readonly evaluations: {
    recoverAfterExclusiveStartup(): void;
    start(): void;
    stop(): Promise<void>;
  };
}

interface OwnedSkills {
  readonly stores: ReadonlyMap<string, SkillAuthoringStore>;
  readonly readers: ReadonlyMap<string, SkillAuthoringSource>;
}

/** Writers and committed-state readers for every configured owner root, initialized once. */
async function ownedSkills(
  owners: ReadonlyMap<string, string>,
  source: "center" | "teacher",
): Promise<OwnedSkills> {
  const stores = new Map<string, SkillAuthoringStore>();
  const readers = new Map<string, SkillAuthoringSource>();
  for (const [id, root] of owners) {
    const store = new SkillAuthoringStore(root, { id, source });
    await store.initialize();
    const reader = new SkillAuthoringSource(root, { id, source });
    await reader.initialize();
    stores.set(id, store);
    readers.set(id, reader);
  }
  return { stores, readers };
}

/** Governance revisions and previews, namespaced over the host's random revision identifiers. */
export function governanceIdGenerator(ids: IdGenerator): GovernanceIdGenerator {
  return {
    createId: (kind) => RevisionIdSchema.parse(`${kind}:${ids.createId("revision")}`),
  };
}

/**
 * Composes every teacher product service over one owned application database. The caller owns
 * the database, performs exclusive startup recovery and serves requests only afterwards.
 */
export async function composeTeacherServices(
  dependencies: TeacherHostServiceDependencies,
): Promise<TeacherHostServices> {
  const { database, clock, ids, secrets, digest, skills } = dependencies;
  const centers = await ownedSkills(skills.centers, "center");
  const teachers = await ownedSkills(skills.teachers, "teacher");
  const configurations = new SqliteTeachingConfigurationRepository(database);
  // Both consumers authorize the teacher's class membership before resolving its sources.
  const sourceForTeacherClass = (teacherId: string, classId: string): SkillSource => {
    const governed = database.readOne(
      "SELECT center_id FROM marea_governance_classes WHERE class_id = ?1",
      [classId],
    );
    const owned = [
      governed === undefined ? undefined : centers.readers.get(String(governed.center_id)),
      teachers.readers.get(teacherId),
    ].flatMap((reader) => (reader === undefined ? [] : [reader]));
    return new CompositeSkillSource([skills.core, ...owned]);
  };
  const insights =
    database.readOne(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'marea_learning_settings'",
    ) === undefined
      ? undefined
      : new EducationalInsightsService(
          database,
          clock,
          dependencies.providers,
          dependencies.serverSettings?.store.read()?.education ??
            dependencies.educationalInsights ??
            {},
        );
  const runs = new RunSessionService({
    clock,
    digest,
    ids,
    repository: new SqliteRunSessionRepository(database),
    secrets,
    snapshots: new ConfigurationSnapshotSource(configurations, (capture, identity) => {
      const settings = dependencies.serverSettings?.store.read();
      const current =
        settings?.useCommonRoute && settings.route !== null
          ? { ...capture, providerRoute: settings.route }
          : capture;
      return insights === undefined ? current : insights.progress.capture(current, identity);
    }),
  });
  const ledger = new SqliteUsageLedger(database);
  const createReservationId = () => ids.createId("event");
  const evaluations = createEvaluationModule({
    repository: new SqliteEvaluationRepository(
      database,
      insights === undefined
        ? undefined
        : (input, draft, actor, now) => {
            insights.progress.apply(input, draft, actor, now);
          },
    ),
    ids,
    clock,
    ledger,
    createReservationId,
    providers: dependencies.providers,
    intervalMs: dependencies.evaluationIntervalMs,
    onError: dependencies.onEvaluationError,
  });
  const governanceRepository = createSqliteGovernanceRepository(
    database,
    (classId) => dependencies.operator.forClass(classId) !== null,
    dependencies.identities,
  );
  const governanceIds = governanceIdGenerator(ids);
  const serverSettings =
    dependencies.serverSettings === undefined
      ? undefined
      : new ServerSettingsService(
          dependencies.serverSettings.store,
          dependencies.serverSettings.catalog,
          // Saved educational routes apply to the running service without a restart.
          insights === undefined
            ? undefined
            : (settings) => {
                insights.configureRoutes(settings.education);
              },
        );
  const identity = new IdentityService({
    clock,
    digest,
    dummyPasswordHash: dependencies.dummyPasswordHash,
    ids,
    passwords: dependencies.passwords,
    repository: new SqliteIdentityRepository(database),
    secrets,
  });
  const identityProviders = dependencies.identityProviders ?? [];
  const externalRepository = new SqliteExternalIdentityRepository(
    database,
    dependencies.identities,
  );
  const services: TeacherProductServices = {
    ...(identityProviders.length === 0
      ? {}
      : {
          externalIdentity: {
            signIn: new ExternalIdentityService({
              providers: identityProviders,
              repository: externalRepository,
              sessions: identity,
              clock,
              ids,
              secrets,
            }),
            access: new ExternalAccessService({
              providers: identityProviders,
              repository: externalRepository,
              clock,
            }),
          },
        }),
    ...(serverSettings === undefined ? {} : { serverSettings }),
    ...(insights === undefined ? {} : { educationalInsights: insights }),
    usageHealth: new UsageHealthService(new SqliteUsageHealthRepository(database), clock),
    reviewedEvidence: new ReviewedEvidenceService(new SqliteReviewedEvidenceRepository(database)),
    ...(dependencies.profiles === undefined ? {} : { profiles: dependencies.profiles(database) }),
    teachingConfiguration: createTeachingConfigurationModule({
      clock,
      ids,
      directory: new SqliteTeachingDashboardRepository(database),
      operator: dependencies.operator,
      repository: configurations,
      skills: { forTeacherClass: sourceForTeacherClass },
    }).service,
    skillAuthoring: createProductSkillAuthoringService({
      membership: configurations,
      sourceForTeacherClass,
      writerForTeacher: (teacherId) => {
        const store = teachers.stores.get(teacherId);
        if (store === undefined) throw new TeacherDomainError("dashboard.forbidden");
        return store;
      },
    }),
    evaluations: evaluations.service,
    modelUsage: new RunInferenceService({
      ledger,
      clock,
      createReservationId,
      diagnostic: dependencies.onInferenceDiagnostic,
    }),
    notices: new NoticeService({
      repository: new SqliteNoticeRepository(database),
      clock,
      ids,
      digest,
    }),
    history: new HistoryService(new SqliteHistoryRepository(database)),
    skills: new RunSkillService(new SqliteRunSkillRepository(database), runs),
    classroom: new ClassBootstrapService(new SqliteClassroomRepository(database)),
    dashboard: new ActiveRunsService(new SqliteDashboardRepository(database), clock),
    identity,
    modelClock: clock,
    providers: dependencies.providers,
    retry: dependencies.retry,
    runs,
  };
  const governanceDependencies = {
    repository: governanceRepository,
    clock,
    ids: governanceIds,
    operator: dependencies.operator,
    passwords: dependencies.passwords,
    secrets,
    sources: new GovernanceSourceCoordinator({
      core: skills.core,
      centers: centers.stores,
      teachers: teachers.stores,
      operatorPersonalOwnerForClass: skills.operatorPersonalOwnerForClass,
      repository: governanceRepository,
      membership: configurations,
      clock,
    }),
  };
  return Object.freeze({
    services,
    governance: {
      service: createGovernanceService(governanceDependencies),
      sessions: new SqliteGovernanceSessionResolver(database, governanceRepository),
      digest,
      clock,
    },
    evaluations: {
      recoverAfterExclusiveStartup() {
        evaluations.recoverAfterExclusiveStartup();
        insights?.recover();
      },
      start() {
        evaluations.start();
        insights?.start();
      },
      async stop() {
        await insights?.stop();
        await evaluations.stop();
      },
    },
  });
}
