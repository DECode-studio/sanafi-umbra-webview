export const BRIDGE_CHANNEL = 'sanafi-umbra-bridge' as const;
export const BRIDGE_VERSION = '1.0.0' as const;

export type BridgeType = 'REQUEST' | 'RESPONSE' | 'EVENT';

export type BridgeError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
};

export type BridgeEnvelope<T = unknown> = {
  id: string;
  channel: typeof BRIDGE_CHANNEL;
  type: BridgeType;
  method: string;
  version: typeof BRIDGE_VERSION;
  timestamp: number;
  payload: T;
  error: BridgeError | null;
};

export type BridgeRequestHandler = (payload: unknown, envelope: BridgeEnvelope) => unknown | Promise<unknown>;

export function isBridgeEnvelope(value: unknown): value is BridgeEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;

  return (
    candidate.channel === BRIDGE_CHANNEL &&
    typeof candidate.id === 'string' &&
    typeof candidate.method === 'string' &&
    typeof candidate.timestamp === 'number' &&
    (candidate.type === 'REQUEST' || candidate.type === 'RESPONSE' || candidate.type === 'EVENT')
  );
}

export function makeBridgeEnvelope<T>(params: {
  id: string;
  type: BridgeType;
  method: string;
  payload: T;
  error?: BridgeError | null;
}): BridgeEnvelope<T> {
  return {
    id: params.id,
    channel: BRIDGE_CHANNEL,
    type: params.type,
    method: params.method,
    version: BRIDGE_VERSION,
    timestamp: Date.now(),
    payload: params.payload,
    error: params.error ?? null,
  };
}

