"use strict";
// Synthetic credentials only. No network, project, or customer data is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { stripTypeScriptTypes } = require("node:module");
const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PAT = "sbp_unit_test_not_a_real_admin_credential";
const JWT = "header." + Buffer.from(JSON.stringify({ sub: OTHER })).toString("base64url") + ".signature";
const PUBLIC = "sb_publishable_unit_test_public_key";
const ENV = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_ANON_KEY: PUBLIC };
const ORIGIN = "https://ignaciomenes-afk.github.io";
const user = { id: UID, email: "synthetic@example.invalid", email_confirmed_at: "2025-01-01T00:00:00Z" };
let count = 0;
async function check(label, test) { await test(); count++; console.log("✓ " + label); }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function input(body = { access_token: PAT }, extra = {}) {
  return new Request("https://abcdefghijklmnopqrst.supabase.co/functions/v1/nicolas-owner-access", {
    method: "POST", headers: { Origin: ORIGIN, Authorization: "Bearer " + JWT, "Content-Type": "application/json", ...extra.headers },
    body: typeof body === "string" ? body : JSON.stringify(body), ...extra,
  });
}
async function run() {
  const ts = fs.readFileSync(path.resolve(__dirname, "../functions/nicolas-owner-access/index.ts"), "utf8");
  const js = stripTypeScriptTypes(ts);
  const { createHandler } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  function setup(replies = [json(user), json([{ user_id: UID }])], options = {}) {
    const calls = [], reads = [];
    const handler = createHandler({ env(name) { reads.push(name); return (options.environment || ENV)[name]; },
      async fetch(url, init) { calls.push({ url, init }); const reply = replies.shift(); if (reply instanceof Error) throw reply; if (typeof reply === "function") return reply(url, init); if (!reply) throw new Error("Unexpected upstream call"); return reply; }, ...options });
    return { handler, calls, reads };
  }
  await check("Confirmed Auth identity and database WRITE PAT are both required; UID is taken from Auth, not JWT claims", async () => {
    const { handler, calls } = setup(); const response = await handler(input()); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { activated: true, user_id: UID }); assert.equal(calls.length, 2);
    assert.equal(calls[0].url, ENV.SUPABASE_URL + "/auth/v1/user"); assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.headers.apikey, PUBLIC); assert.equal(calls[0].init.headers.Authorization, "Bearer " + JWT);
    assert.ok(!JSON.stringify(calls[0]).includes(PAT));
    assert.equal(calls[1].url, "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query");
    assert.equal(calls[1].init.headers.Authorization, "Bearer " + PAT);
    assert.deepEqual(JSON.parse(calls[1].init.body), { query: "select nicolas_private.claim_first_owner($1::uuid) as user_id", parameters: [UID], read_only: false });
    for (const call of calls) { assert.equal(call.init.redirect, "error"); assert.equal(call.init.credentials, "omit"); assert.equal(call.init.cache, "no-store"); assert.ok(call.init.signal instanceof AbortSignal); }
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN); assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
  await check("OPTIONS is credential-free, allowed Origins are exact, hostile Origins cause no upstream calls", async () => {
    const { handler, calls } = setup([]);
    for (const origin of [ORIGIN, "null"]) {
      const response = await handler(new Request("https://example.invalid", { method: "OPTIONS", headers: { Origin: origin } }));
      assert.equal(response.status, 204); assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin); assert.equal(response.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
    }
    for (const origin of ["https://evil.invalid", ORIGIN + ".evil.invalid", "https://ignaciomenes-afk.github.io.evil.invalid"]) {
      const response = await handler(new Request("https://example.invalid", { method: "OPTIONS", headers: { Origin: origin } })); assert.equal(response.status, 403); assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    }
    assert.equal(calls.length, 0);
  });
  await check("Local HTML and non-browser requests work with the same authentication, without wildcard CORS", async () => {
    for (const origin of ["null", undefined]) {
      const { handler } = setup(); const request = input(); if (origin === undefined) request.headers.delete("Origin"); else request.headers.set("Origin", origin);
      const response = await handler(request); assert.equal(response.status, 200); assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin || null);
    }
  });
  await check("GET, missing JWT, incorrect Content-Type, malformed JSON, extra UID and malformed PAT never reach Management", async () => {
    const examples = [
      [new Request("https://example.invalid", { headers: { Origin: ORIGIN } }), 405],
      [input({}, { headers: { Origin: ORIGIN, "Content-Type": "application/json" } }), 401],
      [input("{}", { headers: { Origin: ORIGIN, Authorization: "Bearer " + JWT, "Content-Type": "text/plain" } }), 415],
      [input("{"), 400], [input([]), 400], [input({ access_token: PAT, user_id: OTHER }), 400],
      [input({ access_token: "not_an_admin_token" }), 400], [input({ access_token: 123 }), 400],
    ];
    for (const [request, expected] of examples) { const { handler, calls } = setup([]); const response = await handler(request); assert.equal(response.status, expected); assert.equal(calls.length, 0); }
  });
  await check("Declared and streamed bodies larger than 8KiB are rejected without Auth or write calls", async () => {
    for (const request of [input({ access_token: PAT, padding: "x".repeat(9000) }), input({}, { headers: { Origin: ORIGIN, Authorization: "Bearer " + JWT, "Content-Type": "application/json", "Content-Length": "9000" } })]) {
      const { handler, calls } = setup([]); const response = await handler(request); assert.equal(response.status, 413); assert.equal(calls.length, 0);
    }
  });
  await check("Invalid, unconfirmed, phone-only or malformed Auth users never reach the ownership claim", async () => {
    for (const [reply, expected] of [[json({ message: "No" }, 401), 401], [json({ ...user, email_confirmed_at: null }), 403], [json({ ...user, email: null }), 403], [json({ ...user, id: "invalid" }), 403], [json({ ...user, email_confirmed_at: "invalid" }), 403]]) {
      const { handler, calls } = setup([reply]); const response = await handler(input()); assert.equal(response.status, expected); assert.equal(calls.length, 1);
    }
  });
  await check("Read-only/invalid PAT and another owner return safe errors with no tokens, email or other owner UID", async () => {
    for (const [reply, expected] of [[json({ message: PAT + " " + user.email }, 403), 403], [json({ message: "ERROR PT409: " + OTHER }, 500), 409], [json({ code: "42501", message: "permission denied " + PAT }, 500), 403], [json({ message: "unavailable " + PAT }, 500), 503]]) {
      const { handler } = setup([json(user), reply]); const response = await handler(input()); assert.equal(response.status, expected); const body = await response.text(); for (const forbidden of [PAT, JWT, user.email, OTHER]) assert.ok(!body.includes(forbidden));
    }
  });
  await check("A successful upstream response must acknowledge this exact verified UID", async () => {
    for (const result of [null, {}, [], [{ user_id: OTHER }], [{ user_id: UID }, { user_id: OTHER }]]) {
      const { handler } = setup([json(user), json(result)]); assert.equal((await handler(input())).status, 503);
    }
  });
  await check("SUPABASE_PUBLISHABLE_KEYS.default fallback is public-only; service-role and secret keys are never used", async () => {
    const environment = { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLIC }), SUPABASE_SERVICE_ROLE_KEY: "must_not_be_read", SUPABASE_SECRET_KEYS: "must_not_be_read" };
    const { handler, calls, reads } = setup(undefined, { environment }); assert.equal((await handler(input())).status, 200); assert.equal(calls[0].init.headers.apikey, PUBLIC); assert.ok(!reads.includes("SUPABASE_SERVICE_ROLE_KEY")); assert.ok(!reads.includes("SUPABASE_SECRET_KEYS"));
    for (const invalidKey of ["sb_secret_not_allowed", "header." + Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url") + ".signature"]) {
      const bad = setup([], { environment: { ...ENV, SUPABASE_ANON_KEY: invalidKey } }); assert.equal((await bad.handler(input())).status, 503); assert.equal(bad.calls.length, 0);
    }
    const anon = "header." + Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url") + ".signature";
    const valid = setup(undefined, { environment: { ...ENV, SUPABASE_ANON_KEY: anon } }); assert.equal((await valid.handler(input())).status, 200);
  });
  await check("Configured project hostname is fixed and invalid runtime endpoints cannot receive credentials", async () => {
    for (const value of ["http://abcdefghijklmnopqrst.supabase.co", "https://evil.invalid", "https://abcdefghijklmnopqrst.supabase.co/path", "https://user:pass@abcdefghijklmnopqrst.supabase.co", "https://abcdefghijklmnopqrst.supabase.co?x=1"]) {
      const { handler, calls } = setup([], { environment: { ...ENV, SUPABASE_URL: value } }); assert.equal((await handler(input())).status, 503); assert.equal(calls.length, 0);
    }
  });
  await check("The 20s budget is shared, fetch failures are sanitized, and timed-out Auth never grants access", async () => {
    const { handler, calls } = setup([(_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(PAT)), { once: true }))], { timeoutMs: 5 });
    const response = await handler(input()); assert.equal(response.status, 503); assert.equal(calls.length, 1); assert.ok(!(await response.text()).includes(PAT));
    const failed = setup([new Error(PAT + user.email)]); const safe = await failed.handler(input()); assert.equal(safe.status, 503); assert.ok(!(await safe.text()).includes(PAT));
  });
  await check("A slow request body also times out before any outbound request", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
    const request = new Request("https://example.invalid", { method: "POST", headers: { Origin: ORIGIN, Authorization: "Bearer " + JWT, "Content-Type": "application/json" }, body: stream, duplex: "half" });
    const { handler, calls } = setup([], { timeoutMs: 5 }); const response = await handler(request); assert.equal(response.status, 503); assert.equal(calls.length, 0); assert.ok(cancelled);
  });
  console.log(count + " owner-access handler checks passed.");
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
