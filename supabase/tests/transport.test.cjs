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
const ownerUserId = "00000000-0000-4000-8000-000000000001";
const privateReturnUrl = "https://ignaciomenes-afk.github.io/nicolas/privado/";
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
function harness(config = { enabled: true, supabase_url: origin, publishable_key: publicKey }, handler, initialUrl = privateReturnUrl) {
  const hub = new EventTarget();
  const calls = [], logs = [];
  const address = new URL(initialUrl), historyChanges = [];
  const clock = { now: Date.UTC(2026, 0, 1, 12) };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = {
    NicolasCloudConfig: config,
    location: address,
    history: { replaceState(_state, _title, target) { address.href = new URL(target, address).href; historyChanges.push(address.href); } },
    URL, Headers, Request, Response, Event, EventTarget, AbortController, TextEncoder, TextDecoder, atob, btoa,
    crypto: webcrypto, Date: ClockDate,
    console: Object.fromEntries(["log", "info", "warn", "error", "debug"].map(name => [name, (...args) => logs.push(args.map(String).join(" "))])),
    setTimeout, clearTimeout,
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
      if (pathname === "/auth/v1/token" || pathname === "/auth/v1/verify") return token();
      if (pathname === "/auth/v1/user") return json({ id: ownerUserId, email: verifiedEmail, email_confirmed_at: "2025-12-31T12:00:00Z" });
      if (pathname === "/auth/v1/otp") return json({});
      if (pathname === "/functions/v1/nicolas-owner-access") return json({ activated: true });
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
  return { api: context.NicolasCloud, calls, logs, clock, window: context, historyChanges };
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
  for (const name of ["submit", "signIn", "requestEmailCode", "signInWithCode", "resumeEmailSignIn", "activateOwner", "signOut", "listRequests", "approveRequest", "rejectRequest"]) assert.equal(typeof h.api[name], "function");
  await rejectsSafe(h.api.submit(payload));
  await rejectsSafe(h.api.signIn("owner@example.test", "test-password"));
  await rejectsSafe(h.api.requestEmailCode("owner@example.test"));
  await rejectsSafe(h.api.signInWithCode("owner@example.test", "123456"));
  await rejectsSafe(h.api.activateOwner("sbp_synthetic_never_real_personal_access_token"));
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

const verifiedEmail = "new-owner@example.invalid", otpCode = "12345678";
const personalToken = "sbp_synthetic_never_real_personal_access_token";
function pathname(call) { return new URL(call.url).pathname; }
function activationHarness(edgeResponse, afterClaimAllowed = true) {
  let claimed = false;
  return harness(undefined, call => {
    const endpoint = pathname(call);
    if (endpoint === "/auth/v1/verify") return token();
    if (endpoint.endsWith("/nicolas_list_requests")) return claimed && afterClaimAllowed ? json([]) : json({ code: "42501" }, 403);
    if (endpoint === "/functions/v1/nicolas-owner-access") {
      claimed = true;
      return edgeResponse ? edgeResponse(call) : json({ activated: true });
    }
    throw new Error("Unexpected request from restricted account");
  });
}

test("email codes require an explicit request and send only the exact Auth OTP payload", async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  await h.api.requestEmailCode("  " + verifiedEmail + "  ");
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  const target = new URL(call.url);
  assert.equal(target.origin + target.pathname, origin + "/auth/v1/otp");
  assert.equal(target.searchParams.get("redirect_to"), privateReturnUrl);
  assert.deepEqual([...target.searchParams.keys()], ["redirect_to"]);
  assert.equal(call.method, "POST"); assert.deepEqual(call.body, { email: verifiedEmail, create_user: true });
  assert.equal(call.headers.get("apikey"), publicKey);
  assert.equal(call.headers.get("authorization"), null, "Publishable key must not be used as an anonymous bearer");
  assert.deepEqual(h.logs, []);
});

test("an existing owner verifies an email code and the allowlist before entering the inbox", async () => {
  const h = harness();
  const result = await h.api.signInWithCode(verifiedEmail, otpCode);
  assert.equal(result.authenticated, true);
  assert.equal(h.calls[0].url, origin + "/auth/v1/verify");
  assert.deepEqual(h.calls[0].body, { email: verifiedEmail, token: otpCode, type: "email" });
  assert.equal(h.calls[0].headers.get("authorization"), null);
  assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 1);
  assert.equal(rpcCalls(h.calls, "nicolas_list_requests")[0].headers.get("authorization"), "Bearer " + ownerToken);
  await h.api.approveRequest(requestId);
  assert.equal(rpcCalls(h.calls, "nicolas_approve_request").length, 1);
  assert.equal(h.calls.filter(call => pathname(call).includes("nicolas-owner-access")).length, 0);
  assert.ok(h.calls.every(call => !call.url.includes(verifiedEmail) && !call.url.includes(otpCode)));
  assert.deepEqual(h.logs, []);
});

test("invalid email codes and missing ownership tokens stop before any network operation", async () => {
  const h = harness();
  for (const invalid of ["12345", "12345678901", "12x45678", "", true]) await rejectsSafe(h.api.signInWithCode(verifiedEmail, invalid));
  for (const email of ["", "no-email-address", true]) await rejectsSafe(h.api.requestEmailCode(email));
  await rejectsSafe(h.api.activateOwner(personalToken));
  assert.equal(h.calls.length, 0);
});

test("new verified accounts remain restricted until PAT activation and a fresh owner list check", async () => {
  const h = activationHarness(call => {
    assert.deepEqual(call.body, { access_token: personalToken });
    assert.equal(call.headers.get("authorization"), "Bearer " + ownerToken);
    assert.equal(call.headers.get("apikey"), publicKey);
    assert.equal(call.url, origin + "/functions/v1/nicolas-owner-access");
    return json({ activated: true });
  });
  const verified = await h.api.signInWithCode(verifiedEmail, otpCode);
  assert.equal(verified.authenticated, false); assert.equal(verified.requiresActivation, true);
  const before = h.calls.length;
  await rejectsSafe(h.api.listRequests()); await rejectsSafe(h.api.approveRequest(requestId)); await rejectsSafe(h.api.rejectRequest(requestId));
  assert.equal(h.calls.length, before, "Restricted verification must not authorize private operations");
  const result = await h.api.activateOwner(personalToken);
  assert.equal(result.authenticated, true);
  assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 2, "Edge activation must be followed by a server owner check");
  assert.equal(pathname(h.calls.at(-1)), "/rest/v1/rpc/nicolas_list_requests");
  assert.ok(!JSON.stringify(h.api.config).includes(personalToken));
  assert.ok(!JSON.stringify(h.api).includes(ownerToken));
  assert.ok(h.calls.every(call => !call.url.includes(verifiedEmail) && !call.url.includes(personalToken) && !call.url.includes(otpCode)));
  assert.deepEqual(h.logs, []);
});

test("wrong PAT and owner conflicts do not create an authorized session or expose provider diagnostics", async () => {
  for (const status of [403, 409]) {
    const h = activationHarness(() => json({ error: "SyntheticPATPrivateDiagnostic", details: personalToken }, status));
    const result = await h.api.signInWithCode(verifiedEmail, otpCode); assert.equal(result.requiresActivation, true);
    await rejectsSafe(h.api.activateOwner(personalToken), ["SyntheticPATPrivateDiagnostic", personalToken]);
    const before = h.calls.length;
    await rejectsSafe(h.api.approveRequest(requestId));
    assert.equal(h.calls.length, before);
    assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 1, "Failed activation must not be reported as a connected owner");
  }
});

test("a failed activation can be retried with the restricted verified account", async () => {
  let attempts = 0, claimed = false;
  const h = harness(undefined, call => {
    if (pathname(call) === "/auth/v1/verify") return token();
    if (pathname(call).endsWith("/nicolas_list_requests")) return claimed ? json([]) : json({}, 403);
    if (++attempts === 1) return json({ error: "Wrong personal token" }, 403);
    claimed = true; return json({ activated: true });
  });
  await h.api.signInWithCode(verifiedEmail, otpCode);
  await rejectsSafe(h.api.activateOwner("sbp_synthetic_wrong_personal_access_token"));
  const result = await h.api.activateOwner(personalToken);
  assert.equal(result.authenticated, true); assert.equal(attempts, 2);
});

test("an Edge success without subsequent owner access never reports a connected account", async () => {
  const h = activationHarness(undefined, false);
  await h.api.signInWithCode(verifiedEmail, otpCode);
  await rejectsSafe(h.api.activateOwner(personalToken));
  const before = h.calls.length; await rejectsSafe(h.api.approveRequest(requestId));
  assert.equal(h.calls.length, before);
  assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 2);
});

test("a 200 activation response with no exact activated receipt cannot authorize the account", async () => {
  for (const receipt of [{}, { activated: false }, { authenticated: true }]) {
    const h = activationHarness(() => json(receipt));
    await h.api.signInWithCode(verifiedEmail, otpCode);
    await rejectsSafe(h.api.activateOwner(personalToken));
    assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 1);
    const before = h.calls.length;
    await rejectsSafe(h.api.approveRequest(requestId)); assert.equal(h.calls.length, before);
  }
});

test("locking during OTP send or verification discards late results", async () => {
  for (const operation of ["requestEmailCode", "signInWithCode"]) {
    const waiting = deferred();
    const h = harness(undefined, () => waiting.promise);
    const pending = operation === "requestEmailCode" ? h.api.requestEmailCode(verifiedEmail) : h.api.signInWithCode(verifiedEmail, otpCode);
    assert.equal(h.calls.length, 1);
    h.window.dispatchEvent(new Event("nicolas:locked"));
    waiting.resolve(operation === "requestEmailCode" ? json({}) : token());
    await rejectsSafe(pending);
    const before = h.calls.length; await rejectsSafe(h.api.activateOwner(personalToken));
    assert.equal(h.calls.length, before);
  }
});

test("locking during first-owner activation drops both restricted JWT and late success", async () => {
  const waiting = deferred(), h = activationHarness(() => waiting.promise);
  await h.api.signInWithCode(verifiedEmail, otpCode);
  const pending = h.api.activateOwner(personalToken);
  h.window.dispatchEvent(new Event("nicolas:locked")); waiting.resolve(json({ activated: true }));
  await rejectsSafe(pending);
  const before = h.calls.length; await rejectsSafe(h.api.listRequests()); await rejectsSafe(h.api.activateOwner(personalToken));
  assert.equal(h.calls.length, before); assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 1);
});

test("a pasted email link exchanges only its hash at this project's verify endpoint", async () => {
  const linkHash = "a".repeat(64);
  for (const parameter of ["token_hash", "token"]) {
    const h = harness();
    const link = origin + "/auth/v1/verify?" + parameter + "=" + linkHash + "&type=magiclink&redirect_to=" + encodeURIComponent(privateReturnUrl);
    const result = await h.api.signInWithCode(verifiedEmail, link);
    assert.equal(result.authenticated, true);
    assert.equal(h.calls[0].url, origin + "/auth/v1/verify");
    assert.deepEqual(h.calls[0].body, { token_hash: linkHash, type: "email" });
    assert.ok(h.calls.every(call => !call.url.includes(linkHash) && !call.url.includes(verifiedEmail)));
    assert.equal(h.historyChanges.length, 0, "Pasted verification links must never navigate or enter browser history");
    assert.deepEqual(h.logs, []);
  }
});

test("email links for another host, protocol or path never become a network request", async () => {
  const hash = "a".repeat(64);
  for (const link of [
    "https://another-project.supabase.co/auth/v1/verify?token=" + hash,
    origin + "/auth/v1/token?token=" + hash,
    origin.replace("https:", "http:") + "/auth/v1/verify?token=" + hash,
    origin.replace("https://", "https://user:synthetic-password@") + "/auth/v1/verify?token=" + hash,
    "javascript:alert(1)",
  ]) {
    const h = harness();
    await rejectsSafe(h.api.signInWithCode(verifiedEmail, link));
    assert.equal(h.calls.length, 0); assert.equal(h.historyChanges.length, 0);
  }
});

function callbackUrl(accessToken = ownerToken) {
  return privateReturnUrl + "#access_token=" + encodeURIComponent(accessToken)
    + "&refresh_token=synthetic-refresh-token-must-be-discarded&expires_in=3600&token_type=bearer&type=magiclink";
}
test("email callbacks scrub raw tokens immediately and wait for explicit post-unlock resume", async () => {
  const h = harness(undefined, undefined, callbackUrl());
  assert.equal(h.window.location.hash, "#requests");
  assert.equal(h.calls.length, 0, "Loading an email callback must not fetch private data before vault unlock");
  assert.ok(h.historyChanges.length > 0);
  assert.ok(h.historyChanges.every(value => !value.includes(ownerToken) && !value.includes("refresh_token")));
  const result = await h.api.resumeEmailSignIn();
  assert.equal(result.authenticated, true);
  assert.equal(h.calls[0].url, origin + "/auth/v1/user"); assert.equal(h.calls[0].method, "GET");
  assert.equal(h.calls[0].headers.get("authorization"), "Bearer " + ownerToken);
  assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 1);
  assert.equal(await h.api.resumeEmailSignIn(), null, "The callback must be consumed only once");
  assert.deepEqual(h.logs, []);
});

test("callback identity without owner access remains restricted after server user verification", async () => {
  const h = harness(undefined, call => pathname(call) === "/auth/v1/user"
    ? json({ id: "00000000-0000-4000-8000-000000000002", email: verifiedEmail, email_confirmed_at: "2025-12-31T12:00:00Z" })
    : json({}, 403), callbackUrl());
  const result = await h.api.resumeEmailSignIn();
  assert.equal(result.authenticated, false); assert.equal(result.requiresActivation, true);
  const before = h.calls.length; await rejectsSafe(h.api.approveRequest(requestId));
  assert.equal(h.calls.length, before);
});

test("manual lock before callback resume discards the pending credential without a network request", async () => {
  const h = harness(undefined, undefined, callbackUrl());
  h.window.dispatchEvent(new Event("nicolas:locked"));
  assert.equal(await h.api.resumeEmailSignIn(), null);
  await rejectsSafe(h.api.listRequests()); assert.equal(h.calls.length, 0);
});

test("lock during callback identity verification prevents late owner session resurrection", async () => {
  const waiting = deferred();
  const h = harness(undefined, () => waiting.promise, callbackUrl());
  const pending = h.api.resumeEmailSignIn(); assert.equal(h.calls.length, 1);
  h.window.dispatchEvent(new Event("nicolas:locked"));
  waiting.resolve(json({ id: ownerUserId, email: verifiedEmail, email_confirmed_at: "2025-12-31T12:00:00Z" }));
  await rejectsSafe(pending); assert.equal(rpcCalls(h.calls, "nicolas_list_requests").length, 0);
  const before = h.calls.length; await rejectsSafe(h.api.listRequests()); assert.equal(h.calls.length, before);
});
