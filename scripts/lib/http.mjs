const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 750;
const DEFAULT_MAX_DELAY_MS = 15_000;
const DEFAULT_JITTER_RATIO = 0.2;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpRequestError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "HttpRequestError";
    this.url = options.url ?? null;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export async function fetchWithRetry(input, init = {}, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    jitterRatio = DEFAULT_JITTER_RATIO,
    label = "HTTP request",
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  const requestUrl = describeInput(input);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

    try {
      const response = await fetchImpl(input, { ...init, signal });
      if (response.ok) {
        return response;
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const retryable = RETRYABLE_STATUS_CODES.has(response.status);
      const error = new HttpRequestError(
        `${label} failed with ${response.status} ${response.statusText || "HTTP error"}.`,
        {
          url: response.url || requestUrl,
          status: response.status,
          retryAfterMs,
          retryable,
        },
      );

      await cancelResponseBody(response);
      if (!retryable || attempt === retries) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (error instanceof HttpRequestError && !error.retryable) {
        throw error;
      }
      if (attempt === retries) {
        if (error instanceof HttpRequestError) {
          throw error;
        }
        throw new HttpRequestError(`${label} failed after ${attempt + 1} attempt(s): ${errorMessage(error)}`, {
          url: requestUrl,
          retryable: true,
          cause: error,
        });
      }
      lastError = error;
    }

    const retryAfterMs =
      lastError instanceof HttpRequestError && Number.isFinite(lastError.retryAfterMs)
        ? lastError.retryAfterMs
        : null;
    const delayMs =
      retryAfterMs !== null
        ? Math.min(maxDelayMs, Math.max(0, retryAfterMs))
        : exponentialDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio);
    console.warn(`[http] ${label} attempt ${attempt + 1} failed. Retrying in ${delayMs}ms.`);
    await sleepImpl(delayMs);
  }

  throw lastError ?? new HttpRequestError(`${label} exhausted retries.`, { url: requestUrl });
}

export async function readResponseBuffer(response, options = {}) {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const label = options.label ?? "response body";
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(`${label} is ${declaredLength} bytes, above the ${maxBytes}-byte safety limit.`);
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeded the ${maxBytes}-byte safety limit while downloading.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

export async function readJsonResponse(response, options = {}) {
  const buffer = await readResponseBuffer(response, options);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`${options.label ?? "JSON response"} was not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export async function readTextResponse(response, options = {}) {
  return (await readResponseBuffer(response, options)).toString(options.encoding ?? "utf8");
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) {
    return null;
  }
  return Math.max(0, dateMs - nowMs);
}

function exponentialDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio) {
  const uncapped = baseDelayMs * 2 ** attempt;
  const capped = Math.min(maxDelayMs, uncapped);
  const jitter = capped * Math.max(0, jitterRatio) * Math.random();
  return Math.min(maxDelayMs, Math.round(capped + jitter));
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only. The caller is already handling the request failure.
  }
}

function describeInput(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return typeof input?.url === "string" ? input.url : "unknown URL";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
