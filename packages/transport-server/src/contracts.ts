export const MAX_INPUT_CHARACTERS = 8_192;
export const MAX_REQUEST_BYTES = 16_384;
export const MAX_WEBSOCKET_BYTES = 16_384;

export interface AuthenticatedPrincipal {
  readonly id: string;
}

export type AuthenticationResult =
  | { readonly authenticated: false }
  | {
      readonly authenticated: true;
      readonly principal: AuthenticatedPrincipal;
    };

export interface AuthenticationPort {
  authenticate(credential: string, signal: AbortSignal): Promise<AuthenticationResult>;
}

export interface TransportContext {
  readonly principal: AuthenticatedPrincipal;
  readonly signal: AbortSignal;
}

export interface StreamRequest {
  readonly input: string;
  readonly streamId: string;
}

export type StreamEvent =
  { readonly data: string; readonly type: "data" } | { readonly type: "end" };

export interface StreamPort {
  stream(request: StreamRequest, context: TransportContext): AsyncIterable<StreamEvent>;
}

export interface ClientFrame {
  readonly input: string;
  readonly messageId: string;
  readonly type: "message";
}

export interface SessionPort {
  handle(frame: ClientFrame, context: TransportContext): Promise<void>;
}

export interface TransportPorts {
  readonly authentication: AuthenticationPort;
  readonly sessions: SessionPort;
  readonly streams: StreamPort;
}

export interface TransportPolicy {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
}

export interface TransportServerOptions {
  readonly mounts: {
    readonly session: string;
    readonly stream: string;
  };
  readonly policy: TransportPolicy;
  readonly ports: TransportPorts;
}
