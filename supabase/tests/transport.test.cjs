"use strict";

// Run with: node --test supabase/tests/transport.test.cjs
// No network, account, browser storage or third-party packages are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.resolve(__dirname, "../../shared/requests-cloud.js"), "utf8");
const origin = "https://abcdefghijklmnopqrst.supabase.co";
const publicKey = "sb_publishable_test_public_key_without_private_permissions";
const ownerToken = "test-owner-access-token-for-memory-only-session";
const requestId = "8e335e9f-27d7-4389-a949-56388994aeec";
const payload = {
  request_id: requestId,
  customer: { full_name: "Persona de Prueba", cuil: "20123456788", address_street: "Calle de prueba", address_number: "123", locality: "Localidad de prueba", client_whatsapp: "5491100000000" },
  quote: { policy_version: "nicolas-total-v1", principal_cents: 20000000, term_months: 2, first_due_date: "2030-02-28", due_anchor_day: 31 },
  contact_consent: true,
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function token() {
  return json({ access_token: ownerToken, expires_in: 3600, token_type: "bearer", refresh_token: "must-not-be-persisted", user: { id: "test-owner" } });
}
function legacyKey(role) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ role, iss: "supabase", ref: "test-project" }) + ".test_signature_not_a_real_credential";
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function harness(config = { enabled: true, supabase_url: origin, publishable_key: publicKey }, handler) {
  const hub = new EventTarget();
  const calls = [];
  const clock = { now: Date.UTC(2026, 0, 1, 12) };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = {
    NicolasCloudConfig: config,
    URL, Headers, Request, Response, Event, EventTarget, AbortController, TextEncoder, TextDecoder, atob, btoa,
    crypto: webcrypto, Date: ClockDate, console, setTimeout, clearTimeout,
    addEventListener: hub.addEventListener.bind(hub),
    removeEventListener: hub.removeEventListener.bind(hub),
    dispatchEvent: hub.dispatchEvent.bind(hub),
    fetch: async (input, init = {}) => {
      const call = {
        url: String(input), method: (init.method || "GET").toUpperCase(),
        headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      if (handler) return handler(call, calls.length);
      const pathname = new URL(call.url).pathname;
      if (pathname === "/auth/v1/token") return token();
      if (pathname.endsWith("/nicolas_list_requests")) return json([]);
      if (pathname.endsWith("/nicolas_submit_request")) return json({ request_id: requestId, status: "pending" });
      if (pathname.endsWith("/nicolas_approve_request")) return json({ request_id: requestId, approved_at: "2026-01-01T12:00:00Z", issued_date: "2026-01-01", customer: payload.customer, quote: payload.quote });
      if (pathname.endsWith("/nicolas_reject_request")) return json({ id: requestId, status: "rejected" });
      throw new Error("Unexpected mock endpoint: " + pathname);
    },
  };
  for (const name of ["localStorage", "sessionStorage", "indexedDB"]) {
    Object.defineProperty(context, name, { get() { throw new Error("Transport must not access " + name); } });
  }
  context.window = context;
  vm.runInNewContext(source, context, { filename: "requests-cloud.js" });
  return { api: context.NicolasCloud, calls, clock, window: context };
}
function rpcCalls(calls, name) { return calls.filter(call => new URL(call.url).pathname === "/rest/v1/rpc/" + name); }
async function rejectsSafe(promise, forbidden = []) {
  await assert.rejects(promise, error => {
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0 && error.message.length < 500);
    for (const value of forbidden) assert.ok(!error.message.includes(value), "Error must not expose " + value);
    return true;
  });
}

test("exports the complete public transport and leaves disabled configuration offline", async () => {
  const h = harness({ enabled: false, supabase_url: "", publishable_key: "" });
  assert.equal(h.api.configured, false);
  for (const name of ["submit", "signIn", "signOut", "listRequests", "approveRequest", "rejectRequest"]) assert.equal(typeof h.api[name], "function");
  await rejectsSafe(h.api.submit(payload));
  await rejectsSafe(h.api.signIn("owner@example.test", "test-password"));
  await rejectsSafe(h.api.listRequests());
  await rejectsSafe(h.api.approveRequest(requestId));
  await rejectsSafe(h.api.rejectRequest(requestId));
  await h.api.signOut();
  assert.equal(h.calls.length, 0);
});

test("invalid endpoints and a secret key cannot enable the browser transport", async () => {
  for (const bad of [
    { supabase_url: "http://abcdefghijklmnopqrst.supabase.co", publishable_key: publicKey },
    { supabase_url: "https://owner:password@abcdefghijklmnopqrst.supabase.co", publishable_key: publicKey },
    { supabase_url: origin + "/rest/v1", publishable_key: publicKey },
    { supabase_url: origin, publishable_key: "sb_secret_not-a-public-browser-key" },
    { supabase_url: origin, publishable_key: legacyKey("service_role") },
  ]) {
    const h = harness({ enabled: true, ...bad });
    assert.equal(h.api.configured, false);
    await rejectsSafe(h.api.submit(payload));
    assert.equal(h.calls.length, 0);
  }
});

test("a legacy anon JWT is accepted only as a public key and sent as its bearer", async () => {
  const key = legacyKey("anon");
  const h = harness({ enabled: true, supabase_url: origin, publishable_key: key });
  assert.equal(h.api.configured, true);
  await h.api.submit(payload);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers.get("apikey"), key);
  assert.equal(h.calls[0].headers.get("authorization"), "Bearer " + key);
});

test("anonymous submission uses the public key and the exact submission RPC contract", async () => {
  const h = harness();
  assert.equal(h.api.configured, true);
  const result = await h.api.submit(payload);
  assert.equal(result.request_id, requestId);
  assert.equal(result.status, "pending");
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.url, origin + "/rest/v1/rpc/nicolas_submit_request");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.get("apikey"), publicKey);
  assert.equal(call.headers.get("authorization"), null, "Modern publishable keys are not JWTs");
  assert.equal(call.headers.get("content-type").split(";")[0], "application/json");
  assert.deepEqual(call.body, { p_payload: payload });
  assert.equal(new URL(call.url).search, "");
});

test("owner login checks the inbox before permitting authenticated operations", async () => {
  const h = harness();
  await h.api.signIn("owner@example.test", "test-owner-password");
  const auth = h.calls.find(call => new URL(call.url).pathname === "/auth/v1/token");
  assert.ok(auth);
  assert.equal(auth.method, "POST");
  assert.equal(new URL(auth.url).searchParams.get("grant_type"), "password");
  assert.deepEqual(auth.body, { email: "owner@example.test", password: "test-owner-password" });
  assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 1, "Sign in must verify the owner allowlist through the server");
  await h.api.listRequests();
  await h.api.approveRequest(requestId);
  await h.api.rejectRequest(requestId);
  for (const call of h.calls.filter(call => new URL(call.url).pathname.startsWith("/rest/v1/rpc/"))) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers.get("apikey"), publicKey);
    assert.equal(call.headers.get("authorization"), "Bearer " + ownerToken);
  }
  assert.deepEqual(rpcCalls(h.calls, "nicolas_approve_request")[0].body, { p_request_id: requestId });
  assert.deepEqual(rpcCalls(h.calls, "nicolas_reject_request")[0].body, { p_request_id: requestId });
  assert.ok(!JSON.stringify(h.api.config).includes(ownerToken));
  assert.ok(!JSON.stringify(h.api).includes(ownerToken));
});

test("a valid Auth password without owner access never creates an owner session", async () => {
  const h = harness(undefined, call => {
    if (new URL(call.url).pathname === "/auth/v1/token") return token();
    return json({ message: "owner access denied", code: "42501" }, 403);
  });
  await rejectsSafe(h.api.signIn("not-owner@example.test", "test-password"));
  const before = h.calls.length;
  await rejectsSafe(h.api.listRequests());
  await rejectsSafe(h.api.approveRequest(requestId));
  assert.equal(h.calls.length, before, "Rejected owner login must clear the token before subsequent operations");
});

test("backend errors cannot expose database messages, details or PII", async () => {
  const h = harness(undefined, () => json({
    code: "XX000", message: "private_database_failure PersonaSecreta", details: "database_password=NeverPrintThis", hint: "SELECT cuil FROM private_requests",
  }, 500));
  await rejectsSafe(h.api.submit(payload), ["PersonaSecreta", "NeverPrintThis", "SELECT", "private_database_failure", "database_password"]);
});

test("network failures do not expose request data or internal connection details", async () => {
  const h = harness(undefined, () => { throw new Error("private-network-error PersonaSecreta NeverPrintThis"); });
  await rejectsSafe(h.api.submit(payload), ["PersonaSecreta", "NeverPrintThis", "private-network-error"]);
});

test("an unauthorized private response clears the session before the next operation", async () => {
  let inboxReads = 0;
  const h = harness(undefined, call => {
    if (new URL(call.url).pathname === "/auth/v1/token") return token();
    return ++inboxReads === 1 ? json([]) : json({ message: "Expired session" }, 401);
  });
  await h.api.signIn("owner@example.test", "test-password");
  await rejectsSafe(h.api.listRequests());
  const before = h.calls.length;
  await rejectsSafe(h.api.listRequests());
  await rejectsSafe(h.api.approveRequest(requestId));
  assert.equal(h.calls.length, before);
});

test("locking the vault drops the owner token while public submission still works", async () => {
  const h = harness();
  await h.api.signIn("owner@example.test", "test-password");
  h.window.dispatchEvent(new Event("nicolas:locked"));
  const before = h.calls.length;
  await rejectsSafe(h.api.listRequests());
  await rejectsSafe(h.api.approveRequest(requestId));
  assert.equal(h.calls.length, before);
  await h.api.submit(payload);
  assert.equal(h.calls.at(-1).headers.get("authorization"), null);
});

test("sign out clears the token immediately and needs no remote request", async () => {
  const h = harness();
  await h.api.signIn("owner@example.test", "test-password");
  const before = h.calls.length;
  const signingOut = h.api.signOut();
  await rejectsSafe(h.api.listRequests());
  await signingOut;
  assert.equal(h.calls.length, before);
});

test("expired owner sessions stop before making an authenticated request", async () => {
  const h = harness();
  await h.api.signIn("owner@example.test", "test-password");
  h.clock.now += 3601 * 1000;
  const before = h.calls.length;
  await rejectsSafe(h.api.listRequests());
  assert.equal(h.calls.length, before);
});

test("a lock during password authentication cannot resurrect a session", async () => {
  const waiting = deferred();
  const h = harness(undefined, call => new URL(call.url).pathname === "/auth/v1/token" ? waiting.promise : json([]));
  const signingIn = h.api.signIn("owner@example.test", "test-password");
  assert.equal(h.calls.length, 1);
  h.window.dispatchEvent(new Event("nicolas:locked"));
  waiting.resolve(token());
  await rejectsSafe(signingIn);
  const before = h.calls.length;
  await rejectsSafe(h.api.listRequests());
  assert.equal(h.calls.length, before);
});

test("a private response arriving after logout is not returned to the UI", async () => {
  const waiting = deferred();
  let inboxReads = 0;
  const h = harness(undefined, call => {
    if (new URL(call.url).pathname === "/auth/v1/token") return token();
    if (++inboxReads === 1) return json([]);
    return waiting.promise;
  });
  await h.api.signIn("owner@example.test", "test-password");
  const reading = h.api.listRequests();
  await h.api.signOut();
  waiting.resolve(json([{ id: requestId, customer: payload.customer }]));
  await rejectsSafe(reading);
});
