import { traceable } from "langsmith/traceable";

export function createMetrics() {
  const counters = {
    calls: 0,
    failures: 0,
    retries: 0,
    tokens: 0,
    estimatedCostUsd: 0,
    latencyMs: 0,
  };

  function recordCall({
    operation,
    durationMs = 0,
    tokens = 0,
    estimatedCostUsd = 0,
    ok = true,
    code,
  } = {}) {
    counters.calls += 1;
    counters.latencyMs += Math.max(0, Math.round(durationMs));
    counters.tokens += Math.max(0, Math.round(tokens));
    counters.estimatedCostUsd += Math.max(0, estimatedCostUsd);
    if (!ok) counters.failures += 1;
    return {
      operation,
      durationMs: Math.max(0, Math.round(durationMs)),
      tokens: Math.max(0, Math.round(tokens)),
      estimatedCostUsd: Math.max(0, estimatedCostUsd),
      ok,
      ...(code ? { code } : {}),
    };
  }

  function recordRetry() {
    counters.retries += 1;
  }

  function snapshot() {
    return {
      ...counters,
      averageLatencyMs:
        counters.calls === 0
          ? 0
          : Math.round(counters.latencyMs / counters.calls),
    };
  }

  return { recordCall, recordRetry, snapshot };
}

export function createTracer({ config } = {}) {
  const enabled = config?.enabled === true;
  return {
    enabled,
    wrap(name, operation) {
      if (!enabled) return operation;
      return traceable(operation, {
        name,
        project_name: config.project,
        ...(config.endpoint ? { api_url: config.endpoint } : {}),
      });
    },
  };
}

function delay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Retry delay was aborted."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function withRetry(
  operation,
  {
    retries = 2,
    baseDelayMs = 250,
    signal,
    shouldRetry = () => true,
    onRetry,
  } = {},
) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= retries ||
        signal?.aborted ||
        shouldRetry(error) === false
      ) {
        throw error;
      }
      attempt += 1;
      onRetry?.({ attempt, error });
      await delay(baseDelayMs * 2 ** (attempt - 1), signal);
    }
  }
}
