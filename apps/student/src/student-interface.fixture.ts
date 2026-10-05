/* eslint-disable @typescript-eslint/require-await */
import { IdentityProviderIdSchema, InvitationCodeSchema } from "@marea/protocol";

import type {
  ApprovalDecision,
  ApprovalPrompt,
  ApprovalReply,
  AuthenticationOptions,
  AuthenticationReason,
  SelectableClass,
  StudentInterface,
  StudentViewEvent,
} from "./contracts.js";

const INVITATION = InvitationCodeSchema.parse("invite-code-1234");

export class FixtureInterface implements StudentInterface {
  readonly authenticationReasons: AuthenticationReason[] = [];
  readonly events: StudentViewEvent[] = [];
  readonly prompts: {
    readonly approvalId: string;
    readonly attemptId: string;
    readonly messageId: string;
    readonly path: string;
    readonly summary: string;
  }[] = [];
  approvals = 0;
  authKind: "enroll" | "login" | "external" = "enroll";
  decision: ApprovalDecision = "approved";
  readonly authenticationOptions: AuthenticationOptions[] = [];
  readonly classChoices: (readonly SelectableClass[])[] = [];
  classChoice = "class:two";

  async chooseClass(classes: readonly SelectableClass[]): Promise<string> {
    this.classChoices.push(classes);
    return this.classChoice;
  }

  async authenticate(reason: AuthenticationReason, options: AuthenticationOptions) {
    this.authenticationReasons.push(reason);
    this.authenticationOptions.push(options);
    if (this.authKind === "external")
      return {
        kind: "external" as const,
        providerId: IdentityProviderIdSchema.parse("org.example.idp"),
      };
    return this.authKind === "enroll"
      ? {
          kind: "enroll" as const,
          invitationCode: INVITATION,
          displayName: "Student One",
          login: "student.one",
          password: "strong-password",
        }
      : {
          kind: "login" as const,
          login: "student.one",
          password: "strong-password",
        };
  }

  async confirmWrite(prompt: ApprovalPrompt): Promise<ApprovalReply> {
    this.approvals += 1;
    this.prompts.push(prompt);
    return this.decision;
  }

  present(event: StudentViewEvent): void {
    this.events.push(event);
  }
}
