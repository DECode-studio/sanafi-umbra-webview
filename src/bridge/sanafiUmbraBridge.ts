import {
  BRIDGE_CHANNEL,
  type BridgeEnvelope,
  type BridgeError,
  type BridgeRequestHandler,
  isBridgeEnvelope,
  makeBridgeEnvelope,
} from './protocol';

const DEFAULT_TIMEOUT_MS = 60_000;

type RequestOptions = {
  timeoutMs?: number;
};

type Listener = (envelope: BridgeEnvelope) => void;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type BridgeInitConfig = {
  allowedOrigins?: string[];
};

export type SanafiUmbraBridgeApi = {
  request: <T = unknown>(method: string, payload?: unknown, options?: RequestOptions) => Promise<T>;
  on: (method: string, listener: Listener) => () => void;
  onRequest: (method: string, handler: BridgeRequestHandler) => () => void;
  emit: (method: string, payload?: unknown) => void;
  cancel: (requestId: string) => void;
  destroy: () => void;
};

declare global {
  interface Window {
    sanafiUmbraBridge?: SanafiUmbraBridgeApi;
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  return new Error('Unknown bridge error');
}

function parseAllowedOrigins(rawOrigins?: string[]): Set<string> {
  const result = new Set<string>();
  for (const origin of rawOrigins ?? []) {
    if (origin.trim()) result.add(origin.trim());
  }
  return result;
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
}

export function createSanafiUmbraBridge(config?: BridgeInitConfig): SanafiUmbraBridgeApi {
  const pending = new Map<string, PendingRequest>();
  const listeners = new Map<string, Set<Listener>>();
  const requestHandlers = new Map<string, BridgeRequestHandler>();
  const allowedOrigins = parseAllowedOrigins(config?.allowedOrigins);

  const dispatch = (method: string, envelope: BridgeEnvelope) => {
    const methodListeners = listeners.get(method);
    if (methodListeners) {
      for (const listener of methodListeners) listener(envelope);
    }
    const allListeners = listeners.get('*');
    if (allListeners) {
      for (const listener of allListeners) listener(envelope);
    }
  };

  const send = (envelope: BridgeEnvelope) => {
    const serialized = safeStringify(envelope);
    if (window.ReactNativeWebView?.postMessage) {
      window.ReactNativeWebView.postMessage(serialized);
      return;
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(serialized, '*');
      return;
    }
    dispatch(
      'FLOW_ERROR',
      makeBridgeEnvelope({
        id: randomId(),
        type: 'EVENT',
        method: 'FLOW_ERROR',
        payload: {
          code: 'BRIDGE_NO_HOST',
          message: 'No host bridge found (ReactNativeWebView/parent).',
        },
      }),
    );
  };

  const handleResponse = (envelope: BridgeEnvelope) => {
    const pendingRequest = pending.get(envelope.id);
    if (!pendingRequest) return;

    clearTimeout(pendingRequest.timeoutId);
    pending.delete(envelope.id);

    if (envelope.error) {
      pendingRequest.reject(new Error(`${envelope.error.code}: ${envelope.error.message}`));
      return;
    }

    pendingRequest.resolve(envelope.payload);
  };

  const handleRequest = async (envelope: BridgeEnvelope) => {
    const handler = requestHandlers.get(envelope.method);
    if (!handler) {
      const error: BridgeError = {
        code: 'BRIDGE_UNSUPPORTED_METHOD',
        message: `Unsupported host method: ${envelope.method}`,
      };

      send(
        makeBridgeEnvelope({
          id: envelope.id,
          type: 'RESPONSE',
          method: envelope.method,
          payload: null,
          error,
        }),
      );
      return;
    }

    try {
      const result = await handler(envelope.payload, envelope);
      send(
        makeBridgeEnvelope({
          id: envelope.id,
          type: 'RESPONSE',
          method: envelope.method,
          payload: result ?? null,
        }),
      );
    } catch (error) {
      const normalizedError = toError(error);
      send(
        makeBridgeEnvelope({
          id: envelope.id,
          type: 'RESPONSE',
          method: envelope.method,
          payload: null,
          error: {
            code: 'BRIDGE_REQUEST_HANDLER_FAILED',
            message: normalizedError.message,
          },
        }),
      );
    }
  };

  const handleIncoming = (rawData: unknown, origin?: string) => {
    let parsed: unknown = rawData;
    if (typeof rawData === 'string') {
      try {
        parsed = JSON.parse(rawData);
      } catch {
        return;
      }
    }

    if (!isBridgeEnvelope(parsed)) return;
    if (parsed.channel !== BRIDGE_CHANNEL) return;

    if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
      dispatch(
        'FLOW_ERROR',
        makeBridgeEnvelope({
          id: randomId(),
          type: 'EVENT',
          method: 'FLOW_ERROR',
          payload: {
            code: 'BRIDGE_SESSION_INVALID',
            message: `Message from disallowed origin: ${origin}`,
          },
        }),
      );
      return;
    }

    dispatch(parsed.method, parsed);

    if (parsed.type === 'RESPONSE') {
      handleResponse(parsed);
      return;
    }

    if (parsed.type === 'REQUEST') {
      void handleRequest(parsed);
    }
  };

  const onMessage = (event: MessageEvent) => {
    handleIncoming(event.data, event.origin);
  };

  window.addEventListener('message', onMessage);

  return {
    request: <T = unknown>(method: string, payload: unknown = {}, options: RequestOptions = {}) => {
      const id = randomId();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const envelope = makeBridgeEnvelope({
        id,
        type: 'REQUEST',
        method,
        payload,
      });

      const promise = new Promise<unknown>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`BRIDGE_REQUEST_TIMEOUT: ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pending.set(id, { method, resolve, reject, timeoutId });
        send(envelope);
      });
      return promise as Promise<T>;
    },

    on: (method, listener) => {
      const methodListeners = listeners.get(method) ?? new Set<Listener>();
      methodListeners.add(listener);
      listeners.set(method, methodListeners);

      return () => {
        const target = listeners.get(method);
        if (!target) return;
        target.delete(listener);
        if (target.size === 0) listeners.delete(method);
      };
    },

    onRequest: (method, handler) => {
      requestHandlers.set(method, handler);
      return () => {
        requestHandlers.delete(method);
      };
    },

    emit: (method, payload = {}) => {
      send(
        makeBridgeEnvelope({
          id: randomId(),
          type: 'EVENT',
          method,
          payload,
        }),
      );
    },

    cancel: (requestId) => {
      const target = pending.get(requestId);
      if (!target) return;
      clearTimeout(target.timeoutId);
      pending.delete(requestId);
      target.reject(new Error(`BRIDGE_REQUEST_CANCELLED: ${target.method}`));
    },

    destroy: () => {
      window.removeEventListener('message', onMessage);
      for (const [requestId, request] of pending.entries()) {
        clearTimeout(request.timeoutId);
        request.reject(new Error(`BRIDGE_DESTROYED: ${request.method}`));
        pending.delete(requestId);
      }
      listeners.clear();
      requestHandlers.clear();
    },
  };
}

export function bootstrapSanafiUmbraBridge() {
  if (window.sanafiUmbraBridge) return window.sanafiUmbraBridge;

  const allowedFromEnv =
    (import.meta.env.VITE_ALLOWED_PARENT_ORIGINS as string | undefined)
      ?.split(',')
      .map((it) => it.trim())
      .filter(Boolean) ?? [];

  const bridge = createSanafiUmbraBridge({
    allowedOrigins: allowedFromEnv,
  });

  window.sanafiUmbraBridge = bridge;
  bridge.emit('FLOW_PROGRESS', {
    step: 'INIT',
    status: 'SUCCESS',
    details: 'Bridge bootstrapped',
  });
  return bridge;
}
