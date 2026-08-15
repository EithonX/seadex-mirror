import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetry, parseRetryAfter, readResponseBuffer } from "../scripts/lib/http.mjs";

test("fetchWithRetry retries transient responses and returns success", async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls += 1;
    return calls < 3
      ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
      : new Response("ok", { status: 200 });
  };

  const response = await fetchWithRetry("https://example.test", {}, {
    retries: 3,
    jitterRatio: 0,
    fetchImpl,
    sleepImpl: async (ms) => sleeps.push(ms),
  });
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [0, 0]);
});

test("fetchWithRetry does not retry non-transient HTTP failures", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithRetry("https://example.test/missing", {}, {
      retries: 4,
      fetchImpl: async () => {
        calls += 1;
        return new Response("missing", { status: 404 });
      },
      sleepImpl: async () => {},
    }),
    /404/u,
  );
  assert.equal(calls, 1);
});

test("readResponseBuffer enforces actual body size", async () => {
  await assert.rejects(
    readResponseBuffer(new Response("123456"), { maxBytes: 5, label: "fixture" }),
    /safety limit/u,
  );
});

test("parseRetryAfter handles seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", Date.UTC(2026, 0, 1)), 5000);
  assert.equal(parseRetryAfter("garbage"), null);
});

test("fetchWithRetry caps excessive Retry-After delays", async () => {
  let calls = 0;
  const sleeps = [];
  const response = await fetchWithRetry("https://example.test", {}, {
    retries: 1,
    maxDelayMs: 1_234,
    jitterRatio: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 503, headers: { "retry-after": "3600" } })
        : new Response("ok", { status: 200 });
    },
    sleepImpl: async (ms) => sleeps.push(ms),
  });

  assert.equal(await response.text(), "ok");
  assert.deepEqual(sleeps, [1_234]);
});
