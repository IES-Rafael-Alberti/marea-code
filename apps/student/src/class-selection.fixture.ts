import {
  ClassSelectRequestSchema,
  RevisionIdSchema,
  type ClassBootstrapOutcome,
  type ClassBootstrapRequest,
  type ClassBootstrapResponse,
  type ClassSelectRequest,
  type SessionToken,
} from "@marea/protocol";

import type { AuthenticationResult, SelectableClass } from "./contracts.js";
import { FixtureServer } from "./student.fixture.js";

/** A teacher server whose student session names no class until one of these is chosen. */
export class SelectingServer extends FixtureServer {
  selected: string | null = null;
  rejectSelection = false;
  readonly selections: ClassSelectRequest[] = [];

  constructor(readonly selectable: readonly SelectableClass[]) {
    super();
  }

  override async selectClass(
    token: SessionToken,
    request: ClassSelectRequest,
  ): Promise<AuthenticationResult<ClassBootstrapResponse>> {
    ClassSelectRequestSchema.parse(request);
    this.selections.push(request);
    if (this.rejectSelection) {
      this.rejectSelection = false;
      return { authenticated: false };
    }
    this.selected = request.classId;
    const result = await this.bootstrap(token, {
      kind: "class-bootstrap",
      protocolVersion: request.protocolVersion,
      requestId: request.requestId,
    });
    if (!result.authenticated || result.value.kind !== "class-bootstrapped")
      throw new Error("The fixture selection did not bind a class.");
    return { authenticated: true, value: result.value };
  }

  override async bootstrap(
    token: SessionToken,
    request: ClassBootstrapRequest,
  ): Promise<AuthenticationResult<ClassBootstrapOutcome>> {
    const result = await super.bootstrap(token, request);
    if (!result.authenticated) return result;
    const chosen = this.selectable.find((entry) => entry.classId === this.selected);
    if (chosen !== undefined && result.value.kind === "class-bootstrapped")
      return {
        authenticated: true,
        value: { ...result.value, classroom: { displayName: chosen.displayName } },
      };
    return {
      authenticated: true,
      value: {
        kind: "class-selection-required",
        protocolVersion: "0.1",
        requestId: request.requestId,
        principal: { role: "student", displayName: "Student One" },
        classes: this.selectable.map((entry) => ({
          classId: RevisionIdSchema.parse(entry.classId),
          displayName: entry.displayName,
        })),
      },
    };
  }
}
