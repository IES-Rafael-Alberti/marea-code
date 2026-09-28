import { randomUUID } from "node:crypto";

import {
  ClientSessionIdSchema,
  EventIdSchema,
  IdempotencyKeySchema,
  RequestIdSchema,
  type ApprovalId,
} from "@marea/protocol";

import type { Clock, IdSource } from "./contracts.js";

function identifier(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

export function createSystemClock(): Clock {
  return Object.freeze({ now: () => new Date().toISOString() });
}

export function createSystemIdSource(): IdSource {
  return Object.freeze({
    approvalEffect: (approvalId: ApprovalId) => `workspace:${approvalId}`,
    attempt: () => identifier("attempt"),
    clientSession: () => ClientSessionIdSchema.parse(identifier("client")),
    event: () => EventIdSchema.parse(identifier("event")),
    idempotency: () => IdempotencyKeySchema.parse(identifier("open")),
    request: () => RequestIdSchema.parse(identifier("request")),
  });
}
