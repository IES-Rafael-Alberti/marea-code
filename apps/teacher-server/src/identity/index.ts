export type {
  AuthenticatedIdentity,
  AuthenticatedSession,
  BootstrapAccount,
  BootstrapClass,
  BootstrapInvitation,
  Clock,
  IdGenerator,
  IdentityBootstrap,
  IdentityRepository,
  PasswordHasher,
  SecretDigest,
  SecretIssuer,
} from "./contracts.js";
export { TeacherDomainError, type TeacherDomainErrorCode } from "./errors.js";
export { IdentityService, type IdentityServiceDependencies } from "./identity-service.js";
export { bunArgon2idPasswordHasher } from "./password-hasher.boundary.js";
export {
  createHmacSecretDigest,
  cryptoIdGenerator,
  cryptoSecretIssuer,
  systemClock,
} from "./system-security.boundary.js";
