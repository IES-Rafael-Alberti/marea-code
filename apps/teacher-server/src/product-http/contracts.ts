import type { ServerSettingsEndpoint } from "../server-settings/contracts.js";
import type { EducationalInsightsService } from "../educational-insights/service.js";
import type { ReviewedEvidenceService } from "../reviewed-evidence/service.js";
import type { UsageHealthService } from "../usage-health/service.js";
import type { DashboardProfileEndpoint } from "../dashboard-profiles/contracts.js";
import type { InferenceProvider } from "@marea/plugin-api";
import type {
  ActiveRunDashboardQuery,
  ActiveRunDashboardResponse,
  AppendRunEventsRequest,
  AppendRunEventsResponse,
  ClassBootstrapRequest,
  ClassBootstrapResponse,
  CloseRunRequest,
  CloseRunResponse,
  CredentialLoginRequest,
  CredentialLoginResponse,
  CredentialLogoutResponse,
  EnrollStudentRequest,
  EnrollStudentResponse,
  OpenRunRequest,
  OpenRunResponse,
  RenewRunLeaseRequest,
  RenewRunLeaseResponse,
  RunSkillRequest,
  RunSkillResponse,
} from "@marea/protocol";

import type { DashboardQueryContext } from "../dashboard-api/contracts.js";
import type { ModelGatewayClock, ModelGatewayRetryScheduler } from "../model-gateway/contracts.js";
import type { AuthenticatedIdentity, AuthenticatedSession } from "../identity/contracts.js";
import type { AuthorizedRunLease } from "../sessions/contracts.js";
import type { HistoryService } from "../sessions/history-service.js";
import type { NoticeService } from "../sessions/notice-service.js";
import type { EvaluationService } from "../evaluation/evaluation-service.js";
import type { RunInferenceService } from "../model-gateway/run-inference-service.js";
import type { ProductTeachingConfigurationService } from "../teaching/configuration/dashboard-contracts.js";
import type { ProductSkillAuthoringService } from "../teaching/authoring/dashboard-contracts.js";
import type { Clock, SecretDigest } from "../identity/contracts.js";
import type { GovernanceService } from "../governance/contracts.js";
import type { GovernanceSessionResolver } from "../governance/authority.js";

export interface ProductIdentityService {
  authenticate(token: string): AuthenticatedSession;
  enroll(request: EnrollStudentRequest): Promise<EnrollStudentResponse>;
  login(request: CredentialLoginRequest): Promise<CredentialLoginResponse>;
  logout(token: string, requestId: string): CredentialLogoutResponse;
}

export interface ProductClassroomService {
  load(identity: AuthenticatedIdentity, request: ClassBootstrapRequest): ClassBootstrapResponse;
}

export interface ProductRunService {
  append(leaseToken: string, request: AppendRunEventsRequest): AppendRunEventsResponse;
  authorizeLease(leaseToken: string): AuthorizedRunLease;
  close(leaseToken: string, requestId: string, reason: CloseRunRequest["reason"]): CloseRunResponse;
  open(identity: AuthenticatedIdentity, request: OpenRunRequest): OpenRunResponse;
  renew(identity: AuthenticatedIdentity, request: RenewRunLeaseRequest): RenewRunLeaseResponse;
  closeAuthenticated(identity: AuthenticatedIdentity, request: CloseRunRequest): CloseRunResponse;
}

export interface ProductDashboardService {
  query(context: DashboardQueryContext, query: ActiveRunDashboardQuery): ActiveRunDashboardResponse;
}

export interface InferenceProviderResolver {
  resolve(providerId: string): InferenceProvider | undefined;
}

export interface TeacherProductServices {
  readonly usageHealth?: UsageHealthService;
  readonly serverSettings?: ServerSettingsEndpoint;
  readonly educationalInsights?: EducationalInsightsService;
  readonly reviewedEvidence?: ReviewedEvidenceService;
  readonly profiles?: DashboardProfileEndpoint;
  readonly teachingConfiguration: ProductTeachingConfigurationService;
  readonly skillAuthoring: ProductSkillAuthoringService;
  readonly evaluations: Pick<EvaluationService, "query" | "generate" | "approve">;
  readonly modelUsage: Pick<RunInferenceService, "providerFor">;
  readonly notices: Pick<NoticeService, "publish" | "pending" | "acknowledge" | "lookup">;
  readonly history: Pick<HistoryService, "readRun" | "listSessions" | "listClassSessions">;
  readonly skills: { read(leaseToken: string, request: RunSkillRequest): RunSkillResponse };
  readonly classroom: ProductClassroomService;
  readonly dashboard: ProductDashboardService;
  readonly identity: ProductIdentityService;
  readonly modelClock: ModelGatewayClock;
  readonly providers: InferenceProviderResolver;
  readonly retry: ModelGatewayRetryScheduler;
  readonly runs: ProductRunService;
}

export interface TeacherProductHttpOptions {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly dashboardCookieName?: string;
  readonly secureDashboardCookie?: boolean;
  readonly serverVersion: string;
  readonly services: TeacherProductServices;
  /** Administrator governance is composed only when the real SQL resolver is available. */
  readonly governance?: {
    readonly service: GovernanceService;
    readonly sessions: GovernanceSessionResolver;
    readonly digest: SecretDigest;
    readonly clock: Clock;
  };
}

export interface TeacherProductHttpApplication {
  fetch(request: Request): Response | Promise<Response>;
}
