import {
  CURRENT_PROTOCOL_VERSION,
  type CloseRunResponse,
  type RequestId,
  type RunId,
} from "@marea/protocol";

/** What leaving a run the server no longer accepts amounts to: it is already closed. */
export function alreadyClosedResponse(requestId: RequestId, runId: RunId): CloseRunResponse {
  return {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    requestId,
    runId,
    state: "closed",
    alreadyClosed: true,
  };
}
