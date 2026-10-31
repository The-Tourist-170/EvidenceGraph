export class IntegrationError extends Error {
  constructor(code, message, { cause, retryable = false, details } = {}) {
    super(message, { cause });
    this.name = "IntegrationError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

const retryableCodes = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_REQUEST_FAILED",
]);

export function isRetryableIntegrationError(error) {
  return error instanceof IntegrationError && error.retryable;
}

export function classifyProviderError(error, { operation = "Provider" } = {}) {
  if (error instanceof IntegrationError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new IntegrationError(
      "PROVIDER_TIMEOUT",
      `${operation} request timed out.`,
      { cause: error, retryable: true },
    );
  }
  const status = error?.status ?? error?.response?.status;
  if (status === 401 || status === 403) {
    return new IntegrationError(
      "PROVIDER_AUTHORIZATION_FAILED",
      `${operation} rejected the configured credentials.`,
      { cause: error, retryable: false },
    );
  }
  if (status === 429) {
    return new IntegrationError(
      "PROVIDER_RATE_LIMITED",
      `${operation} rate limit was reached.`,
      { cause: error, retryable: true },
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new IntegrationError(
      "PROVIDER_UNAVAILABLE",
      `${operation} is temporarily unavailable.`,
      { cause: error, retryable: true },
    );
  }
  return new IntegrationError(
    "PROVIDER_REQUEST_FAILED",
    `${operation} request failed.`,
    { cause: error, retryable: true },
  );
}

export { retryableCodes };
