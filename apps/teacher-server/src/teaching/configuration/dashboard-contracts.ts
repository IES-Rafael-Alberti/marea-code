import type {
  SaveTeachingConfigurationRequest,
  SaveTeachingConfigurationResponse,
  TeachingCatalogQuery,
  TeachingCatalogResponse,
  TeachingClassesQuery,
  TeachingClassesResponse,
  TeachingConfigurationQuery,
  TeachingConfigurationResponse,
  TeacherToolPolicySchema,
} from "@marea/protocol";
import type * as z from "zod";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import type { RouteBudgetSchema } from "../../model-gateway/route-policy.js";
import type { ConfiguredTeachingRouteSchema } from "./configuration-service.js";

/** One captured operator-owned value per save; never constructed from browser input. */
export interface TeachingOperatorPolicy {
  readonly route: z.infer<typeof ConfiguredTeachingRouteSchema> & {
    readonly providerRoute: { readonly budget: z.infer<typeof RouteBudgetSchema> };
  };
  readonly teacherToolPolicy: z.infer<typeof TeacherToolPolicySchema>;
}

/** Null means prerequisites are absent. No inferred budget or permission defaults. */
export interface TeachingOperatorConfiguration {
  forClass(classId: string): TeachingOperatorPolicy | null;
}

export interface ProductTeachingConfigurationService {
  classes(
    identity: AuthenticatedIdentity,
    query: TeachingClassesQuery,
  ): Promise<TeachingClassesResponse>;
  read(
    identity: AuthenticatedIdentity,
    query: TeachingConfigurationQuery,
  ): Promise<TeachingConfigurationResponse>;
  catalog(
    identity: AuthenticatedIdentity,
    query: TeachingCatalogQuery,
  ): Promise<TeachingCatalogResponse>;
  save(
    identity: AuthenticatedIdentity,
    request: SaveTeachingConfigurationRequest,
  ): Promise<SaveTeachingConfigurationResponse>;
}
