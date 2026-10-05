import type {
  AdmissionRule,
  IdentityProvider,
  IdentityProviderDescriptor,
} from "@marea/plugin-api";
import type { ExternalAccessRule } from "@marea/protocol";

import type { AuthenticatedIdentity } from "../identity/contracts.js";

/** An installed provider plugin together with its configured instance. */
export interface ConfiguredIdentityProvider {
  readonly id: string;
  readonly descriptor: IdentityProviderDescriptor;
  readonly provider: IdentityProvider;
}

export interface ClassAdmissionRules {
  readonly classId: string;
  readonly rules: readonly AdmissionRule[];
}

export interface ExternalProvisioning {
  readonly providerId: string;
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  /** Classes whose rules admit the person now; memberships the provider granted elsewhere end. */
  readonly admittedClassIds: readonly string[];
  /** Used only when this person signs in for the first time. */
  readonly newUserId: string;
  readonly newLogin: string;
  readonly version: string;
  readonly now: string;
}

export interface ExternalRuleChange {
  readonly teacherId: string;
  readonly classId: string;
  readonly providerId: string;
  readonly kind: string;
  readonly values: readonly string[];
  readonly operation: "add" | "remove";
  readonly now: string;
}

export interface ExternalIdentityRepository {
  /** Schema 12 stores external identities and admission rules. */
  available(): boolean;
  classRules(providerId: string): readonly ClassAdmissionRules[];
  /** The student account for this person, created on first admission; undefined when denied. */
  provision(input: ExternalProvisioning): AuthenticatedIdentity | undefined;
  /** Whether this teacher's class is adopted; it rejects anyone who does not teach it. */
  teacherClassAccess(teacherId: string, classId: string): boolean;
  classRulesFor(classId: string, providerIds: readonly string[]): readonly ExternalAccessRule[];
  changeRules(change: ExternalRuleChange): void;
}

/** Opens a session for an account the provider has just verified. */
export interface ExternalSessionIssuer {
  openExternalSession(identity: AuthenticatedIdentity): {
    readonly principal: { readonly role: "student" | "teacher"; readonly displayName: string };
    readonly session: {
      readonly token: string;
      readonly issuedAt: string;
      readonly expiresAt: string;
    };
  };
}
