"use strict";
// Real PostgreSQL, isolated container without host ports. No cloud account or PII.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const core = require("../client-request/loan-core.js");
const owner = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let container, checks = 0;
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const docker = args => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
function sql(text, role = "postgres", user = "") {
  const prefix = role === "postgres" ? "" : `set role ${role}; set request.jwt.claim.sub = ${literal(user)};`;
  return execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"], {
    input: prefix + text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function expectFailure(text, role, user, codeText) {
  assert.throws(() => sql(text, role, user), error => {
    assert.ok(String(error.stderr).includes(codeText), String(error.stderr)); return true;
  });
}
function submit(payload, role = "anon") {
  return JSON.parse(sql(`select public.nicolas_submit_request(${literal(JSON.stringify(payload))}::jsonb);`, role));
}
function payload(months = 6) {
  return { request_id: randomUUID(), contact_consent: true,
    customer: { full_name: "Persona Sintética de Prueba", cuil: "20123456786", address_street: "Calle Sintética", address_number: "123", locality: "Ciudad de Prueba", client_whatsapp: "5491100000000" },
    quote: { policy_version: "nicolas-total-v1", principal_cents: 100000000, term_months: months, first_due_date: "2035-11-30", due_anchor_day: 31 } };
}
async function check(label, action) { await action(); checks++; console.log(`✓ ${label}`); }
async function run() {
  container = docker(["run", "--rm", "-d", "--network", "none", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"]);
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      if (!docker(["logs", container]).includes("PostgreSQL init process complete; ready for start up.")) throw new Error("Database initialization is still running.");
      docker(["exec", container, "pg_isready", "-U", "postgres"]); break;
    }
    catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  sql(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    insert into auth.users values (${literal(owner)}),(${literal(stranger)});`);
  const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/202610230001_private_requests.sql"), "utf8");
  await check("La migración PostgreSQL es ejecutable y repetible", () => { sql(migration); sql(migration); sql(`insert into nicolas_private.owner_users values (${literal(owner)});`); });
  await check("Anon no puede leer PII ni ejecutar decisiones; cuenta ajena tampoco", () => {
    expectFailure("select * from nicolas_private.requests;", "anon", "", "permission denied");
    expectFailure("select public.nicolas_list_requests();", "anon", "", "permission denied");
    expectFailure(`select public.nicolas_approve_request('${randomUUID()}');`, "anon", "", "permission denied");
    expectFailure("select public.nicolas_list_requests();", "authenticated", stranger, "Owner authorization required");
    expectFailure("select * from nicolas_private.owner_users;", "authenticated", stranger, "permission denied");
    assert.deepEqual(JSON.parse(sql("select public.nicolas_list_requests();", "authenticated", owner)), []);
  });
  await check("PostgreSQL coincide con la simulación para 240 cronogramas y fin de mes", () => {
    const inputs = [];
    for (let months = 1; months <= 24; months++) for (const principal of [1, 2, 10, 101, 20000000, 50000000, 100000000, 100000001, 99999999999, 100000000000]) {
      inputs.push({ policy_version: "nicolas-total-v1", principal_cents: principal, term_months: months, first_due_date: "2036-02-29", due_anchor_day: 31 });
    }
    const results = sql(`select nicolas_private.quote_snapshot(value) from jsonb_array_elements(${literal(JSON.stringify(inputs))}::jsonb);`).split("\n").map(JSON.parse);
    results.forEach((actual, index) => {
      const expected = core.calculate(inputs[index]);
      for (const key of ["interest_percent", "interest_cents", "base_total_cents", "rounding_adjustment_cents", "total_cents", "installments"]) assert.deepEqual(actual[key], expected[key], `${index}/${key}`);
    });
  });
  const first = payload();
  first.customer.address_number = "1".repeat(40);
  first.customer.locality = "L".repeat(120);
  await check("Submit es escritura anónima idempotente y no revela datos ni decisión", () => {
    const receipt = { request_id: first.request_id, status: "pending" };
    assert.deepEqual(submit(first), receipt); assert.deepEqual(submit(first), receipt);
    assert.equal(sql("select count(*) from nicolas_private.requests;"), "1");
    const altered = structuredClone(first); altered.quote.principal_cents++;
    expectFailure(`select public.nicolas_submit_request(${literal(JSON.stringify(altered))}::jsonb);`, "anon", "", "Identifier already used");
  });
  await check("Datos inválidos, consentimiento ausente y totales inventados se rechazan", () => {
    for (const mutate of [p => p.customer.cuil = "20123456788", p => p.contact_consent = false,
      p => p.quote.total_cents = 1, p => p.quote.term_months = 0, p => p.quote.principal_cents = 1.5,
      p => p.quote.first_due_date = "2036-02-30", p => p.customer.full_name = "X", p => p.extra = true]) {
      const value = payload(); mutate(value);
      assert.throws(() => submit(value));
    }
    assert.equal(sql("select count(*) from nicolas_private.requests;"), "1");
  });
  let approved;
  await check("Aprobación durable conserva presupuesto y resuelve dos clics concurrentes", async () => {
    const statement = `set timezone='America/Argentina/Buenos_Aires'; set role authenticated; set request.jwt.claim.sub=${literal(owner)}; select public.nicolas_approve_request('${first.request_id}');`;
    const exec = promisify(execFile);
    const responses = await Promise.all([1, 2].map(() => exec("docker", ["exec", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement], { encoding: "utf8" })));
    approved = JSON.parse(responses[0].stdout.trim()); assert.deepEqual(JSON.parse(responses[1].stdout.trim()), approved);
    assert.match(approved.approved_at, /Z$/, "La aprobación se serializa en UTC incluso desde una sesión Argentina.");
    assert.equal(approved.request_id, first.request_id); assert.equal(approved.quote.total_cents, 140400000);
    assert.equal(approved.quote.installments.length, 6); assert.equal(approved.quote.installments[0].amount_cents, 23400000);
    assert.deepEqual(submit(first), { request_id: first.request_id, status: "pending" });
    expectFailure(`select public.nicolas_reject_request('${first.request_id}');`, "authenticated", owner, "Approved requests cannot");
    const rows = JSON.parse(sql("select public.nicolas_list_requests();", "authenticated", owner));
    assert.deepEqual(rows[0].approved_payload, approved); assert.equal(rows[0].status, "approved");
  });
  await check("Rechazar no crea préstamo y no permite aprobar después", () => {
    const next = payload(2); submit(next);
    const result = JSON.parse(sql(`select public.nicolas_reject_request('${next.request_id}');`, "authenticated", owner));
    assert.equal(result.status, "rejected");
    assert.deepEqual(JSON.parse(sql(`select public.nicolas_reject_request('${next.request_id}');`, "authenticated", owner)), result);
    expectFailure(`select public.nicolas_approve_request('${next.request_id}');`, "authenticated", owner, "Only pending");
    assert.equal(sql(`select approved_payload is null from nicolas_private.requests where id='${next.request_id}';`), "t");
  });
  await check("Límite por CUIL y fechas vencidas protegen la bandeja", () => {
    const third = payload(); submit(third);
    expectFailure(`select public.nicolas_submit_request(${literal(JSON.stringify(payload()))}::jsonb);`, "anon", "", "rate limit");
    sql(`update nicolas_private.requests set quote=jsonb_set(quote,'{first_due_date}','"2000-01-01"') where id='${third.request_id}';`);
    expectFailure(`select public.nicolas_approve_request('${third.request_id}');`, "authenticated", owner, "First payment must be after");
    assert.equal(sql(`select status from nicolas_private.requests where id='${third.request_id}';`), "pending");
  });
  console.log(`${checks} comprobaciones SQL correctas; PostgreSQL real sin exposición de puertos.`);
}
run().catch(error => { console.error(error.stderr || error.stack || error); process.exitCode = 1; }).finally(() => {
  if (container) { try { docker(["rm", "-f", container]); } catch (_) {} }
});
