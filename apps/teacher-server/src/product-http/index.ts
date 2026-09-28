export type {
  InferenceProviderResolver,
  ProductClassroomService,
  ProductDashboardService,
  ProductIdentityService,
  ProductRunService,
  TeacherProductHttpApplication,
  TeacherProductHttpOptions,
  TeacherProductServices,
} from "./contracts.js";
export { createTeacherProductHttp } from "./teacher-product-http.boundary.js";
export { registerGovernanceRoutes } from "./governance-http.boundary.js";
export type {
  ProductTeachingConfigurationService,
  TeachingOperatorConfiguration,
  TeachingOperatorPolicy,
} from "../teaching/configuration/dashboard-contracts.js";
export { createTeachingConfigurationModule } from "../teaching/configuration/dashboard-module.js";
export type {
  TeachingClassDirectory,
  TeachingClassPageRequest,
  TeachingClassRow,
  TeachingConfigurationModuleOptions,
  TeachingSkillDirectory,
} from "../teaching/configuration/dashboard-module.js";
export { TeachingConfigurationError } from "../teaching/configuration/dashboard-errors.js";
export { registerTeachingRoutes } from "./teaching-http.boundary.js";
export type { TeachingRouteDependencies } from "./teaching-http.boundary.js";
export {
  createProductSkillAuthoringService,
  createSkillAuthoringModule,
} from "../teaching/authoring-runtime/skill-authoring-service.js";
export type {
  ProductSkillAuthoringServiceOptions,
  ProductSkillAuthoringWriter,
} from "../teaching/authoring-runtime/skill-authoring-service.js";
