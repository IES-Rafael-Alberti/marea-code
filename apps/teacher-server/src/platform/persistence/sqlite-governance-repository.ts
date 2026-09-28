import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type { GovernanceRepository } from "../../governance/contracts.js";
import type { Id } from "../../governance/authority.js";
import { GovernanceStore } from "./governance-store.js";
import type { IdentityCreationGuard } from "./identity-creation-guard.js";
import { GovernanceReads } from "./governance-reads.js";
import { GovernanceClassMutations } from "./governance-class-mutations.js";
import { GovernanceAccountMutations } from "./governance-account-mutations.js";
import { GovernanceMembershipMutations } from "./governance-membership-mutations.js";
import { GovernanceOperatorMutations } from "./governance-operator-mutations.js";
import { GovernanceAdoptionRepository } from "./governance-adoption-repository.js";
import { GovernanceExchangeRepository } from "./governance-exchange-repository.js";

/** Private prepared-input repository: applications validate and materialize first. */
export function createSqliteGovernanceRepository(
  database: SqliteApplicationDatabase,
  operatorReady: (classId: Id) => boolean,
  identities: IdentityCreationGuard,
): GovernanceRepository {
  const store = new GovernanceStore(database, operatorReady, identities);
  const reads = new GovernanceReads(store);
  const classes = new GovernanceClassMutations(store);
  const accounts = new GovernanceAccountMutations(store);
  const memberships = new GovernanceMembershipMutations(store);
  const operator = new GovernanceOperatorMutations(store);
  const adoption = new GovernanceAdoptionRepository(store);
  const exchange = new GovernanceExchangeRepository(store);
  return Object.freeze({
    requireSession: reads.requireSession.bind(reads),
    requireAdministrator: reads.requireAdministrator.bind(reads),
    requireAccess: reads.requireAccess.bind(reads),
    listCenters: reads.listCenters.bind(reads),
    listClasses: reads.listClasses.bind(reads),
    listAccounts: reads.listAccounts.bind(reads),
    listMemberships: reads.listMemberships.bind(reads),
    commitCreateClass: classes.commitCreateClass.bind(classes),
    commitRenameClass: classes.commitRenameClass.bind(classes),
    commitCreateAccount: accounts.commitCreateAccount.bind(accounts),
    commitRenameAccount: accounts.commitRenameAccount.bind(accounts),
    commitChangeAccountState: accounts.commitChangeAccountState.bind(accounts),
    commitRevokeSessions: accounts.commitRevokeSessions.bind(accounts),
    commitChangeMembership: memberships.commitChangeMembership.bind(memberships),
    commitCreateCenter: operator.commitCreateCenter.bind(operator),
    commitRenameCenter: operator.commitRenameCenter.bind(operator),
    commitAssociateAccount: operator.commitAssociateAccount.bind(operator),
    commitSetAdministrator: operator.commitSetAdministrator.bind(operator),
    commitProvisionCredential: operator.commitProvisionCredential.bind(operator),
    previewAdoption: adoption.previewAdoption.bind(adoption),
    commitAdoption: adoption.commitAdoption.bind(adoption),
    loadClassForExchange: exchange.loadClassForExchange.bind(exchange),
    loadPendingClassImport: exchange.loadPendingClassImport.bind(exchange),
    commitClassImportPreview: exchange.commitClassImportPreview.bind(exchange),
    commitClassImportConfirmation: exchange.commitClassImportConfirmation.bind(exchange),
    commitClassImportCancellation: exchange.commitClassImportCancellation.bind(exchange),
  });
}
