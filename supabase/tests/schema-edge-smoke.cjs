"use strict";
// Extra backend boundaries in a disposable, network-isolated PostgreSQL container.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const OWNER = "11111111-1111-4111-8111-111111111111";
const quote = text => "'" + String(text).replaceAll("'", "''") + "'";
let container, checks = 0;
function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024, ...options }).trim();
}
function sql(statement, role = "postgres", uid = "") {
  const prefix = role === "postgres" ? "" : `set role ${role}; set request.jwt.claim.sub=${quote(uid)};`;
  return docker(["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"], { input: "\\set VERBOSITY verbose\n" + prefix + statement });
}
function fails(statement, expected, role = "anon", uid = "") {
  assert.throws(() => sql(statement, role, uid), error => String(error.stderr).includes(expected));
}
function request() {
  return { request_id: randomUUID(), contact_consent: true,
    customer: { full_name: "Persona Sintética", cuil: "20123456786", address_street: "Prueba", address_number: "1", locality: "Prueba", client_whatsapp: "5491100000000" },
    quote: { policy_version: "nicolas-total-v1", principal_cents: 123456789, term_months: 24, first_due_date: "2036-02-29", due_anchor_day: 31 } };
}
const submitSQL = value => `select public.nicolas_submit_request(${quote(JSON.stringify(value))}::jsonb);`;
async function check(label, action) { await action(); checks++; console.log(`✓ ${label}`); }
async function run() {
  container = docker(["run", "--rm", "-d", "--network", "none", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const logs = docker(["logs", container]);
      assert.match(logs, /PostgreSQL init process complete/);
      docker(["exec", container, "pg_isready", "-U", "postgres"]); break;
    } catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  sql(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    insert into auth.users values (${quote(OWNER)});`);
  sql(fs.readFileSync(path.resolve(__dirname, "../migrations/202610230001_private_requests.sql"), "utf8"));
  sql(`insert into nicolas_private.owner_users values(${quote(OWNER)});`);
  await check("Non-object inputs and nested fields fail with safe request errors", () => {
    for (const value of [true, 42, "text", [], {}]) fails(submitSQL(value), "PT400");
    for (const key of ["customer", "quote"]) for (const value of [true, 42, "text", [], null]) {
      const payload = request(); payload[key] = value; fails(submitSQL(payload), "PT400");
    }
    const tooLarge = request(); tooLarge.customer.full_name = "X".repeat(17000); fails(submitSQL(tooLarge), "PT413");
    for (const value of [false, "true", 1, null]) {
      const payload = request(); payload.contact_consent = value; fails(submitSQL(payload), "PT400");
    }
  });
  const first = request();
  sql(submitSQL(first), "anon");
  await check("Approval timestamps remain UTC when the SQL session timezone changes", () => {
    const result = JSON.parse(sql(`set timezone='America/Argentina/Buenos_Aires';select public.nicolas_approve_request('${first.request_id}');`, "authenticated", OWNER));
    assert.match(result.approved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const parts = new Intl.DateTimeFormat("en", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(result.approved_at));
    const part = type => parts.find(value => value.type === type).value;
    assert.equal(result.issued_date, `${part("year")}-${part("month")}-${part("day")}`);
    assert.deepEqual(JSON.parse(sql(`set timezone='Pacific/Auckland';select public.nicolas_approve_request('${first.request_id}');`, "authenticated", OWNER)), result);
  });
  await check("Revoking the allowlist takes effect for an already authenticated UUID", () => {
    sql(`delete from nicolas_private.owner_users where user_id='${OWNER}';`);
    fails("select public.nicolas_list_requests();", "PT403", "authenticated", OWNER);
    sql(`insert into nicolas_private.owner_users values('${OWNER}');`);
  });
  await check("Global rate limits reject new writes without losing an existing receipt", () => {
    sql(`insert into nicolas_private.submission_limits values('global', date_trunc('hour',clock_timestamp()),120)
      on conflict(bucket_key,window_start) do update set submissions=120;`);
    fails(submitSQL(request()), "PT429");
    assert.deepEqual(JSON.parse(sql(submitSQL(first), "anon")), { request_id: first.request_id, status: "pending" });
    sql("delete from nicolas_private.submission_limits;");
  });
  await check("A full 1000-record worst-case inbox fits the transport and stops new requests", () => {
    const large = request();
    Object.assign(large.customer, { full_name: "😀".repeat(158) + " A", address_street: "😀".repeat(160), address_number: "😀".repeat(40), locality: "😀".repeat(120) });
    sql(submitSQL(large), "anon");
    sql(`select public.nicolas_approve_request('${large.request_id}');`, "authenticated", OWNER);
    sql(`insert into nicolas_private.requests(id,status,customer,quote,submitted_payload,approved_payload,decided_at,decided_by)
      select md5('synthetic-capacity-test-' || n::text)::uuid,'approved',r.customer,r.quote,r.submitted_payload,r.approved_payload,clock_timestamp(),'${OWNER}'
      from generate_series(1,998) n cross join nicolas_private.requests r where r.id='${large.request_id}';`);
    assert.equal(sql("select count(*) from nicolas_private.requests;"), "1000");
    const raw = sql("select public.nicolas_list_requests();", "authenticated", OWNER);
    assert.equal(JSON.parse(raw).length, 1000);
    assert.ok(Buffer.byteLength(raw) < 12 * 1024 * 1024, `UTF-8 response bytes: ${Buffer.byteLength(raw)}`);
    assert.ok(raw.length < 12 * 1024 * 1024, `Transport string characters: ${raw.length}`);
    fails(submitSQL(request()), "PT429");
    assert.equal(JSON.parse(sql(submitSQL(first), "anon")).request_id, first.request_id);
    console.log(`  Synthetic full response: ${Buffer.byteLength(raw)} UTF-8 bytes / ${raw.length} JS characters.`);
  });
  console.log(`${checks} backend boundary checks passed.`);
}
run().catch(error => { console.error(error.stderr || error.stack || error); process.exitCode = 1; }).finally(() => {
  if (container) { try { docker(["rm", "-f", container]); } catch (_) {} }
});
