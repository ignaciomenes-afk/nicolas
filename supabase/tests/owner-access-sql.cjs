"use strict";
// First-owner activation boundaries in disposable PostgreSQL; no external network or project.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const IMAGE = "postgres:17-alpine";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const UNCONFIRMED = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let container = "", checks = 0;

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 20000,
    maxBuffer: 4 * 1024 * 1024, ...options,
  }).trim();
}
function psqlArgs() {
  return ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq"];
}
function sql(statement, role = "postgres", uid = "") {
  const prefix = role === "postgres" ? "" : `set role ${role};set request.jwt.claim.sub=${quote(uid)};`;
  return docker(psqlArgs(), { input: "\\set VERBOSITY verbose\n" + prefix + statement });
}
function rejectSql(statement, code, role = "postgres", uid = "") {
  assert.throws(() => sql(statement, role, uid), error => {
    assert.match(String(error.stderr), new RegExp(`\\b${code}\\b`));
    return true;
  });
}
function claim(uid) {
  return `select nicolas_private.claim_first_owner(${uid === null ? "null" : quote(uid)}::uuid);`;
}
function ownerRows() {
  return sql("select coalesce(json_agg(user_id order by user_id),'[]'::json) from nicolas_private.owner_users;");
}
function asyncSql(statement, keepOpen = false) {
  const child = spawn("docker", psqlArgs(), { stdio: ["pipe", "pipe", "pipe"] });
  const result = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => { result.stdout += data; });
  child.stderr.on("data", data => { result.stderr += data; });
  result.done = new Promise(resolve => {
    child.on("error", error => { result.stderr += error.message; resolve({ ...result, code: -1 }); });
    child.on("close", code => resolve({ stdout: result.stdout.trim(), stderr: result.stderr, code }));
  });
  child.stdin.on("error", () => {}); // Container cleanup may close a failed race's input.
  const input = "\\set VERBOSITY verbose\n" + statement;
  if (keepOpen) child.stdin.write(input + "\n"); else child.stdin.end(input + "\n");
  return result;
}
async function until(predicate, label) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await pause(40);
  }
}
async function race(firstUid, secondUid) {
  sql("truncate nicolas_private.owner_users;");
  const tag = randomUUID();
  const blocker = asyncSql("begin;lock table nicolas_private.owner_users in access exclusive mode;select 'barrier-ready';", true);
  await until(() => blocker.stdout.includes("barrier-ready"), "owner claim barrier");
  const names = [`first-owner-a-${tag}`, `first-owner-b-${tag}`];
  const contenders = [firstUid, secondUid].map((uid, index) =>
    asyncSql(`set application_name=${quote(names[index])};${claim(uid)}`));
  // Both separate sessions must reach the table lock before either can create an owner.
  await until(() => sql(`select count(*) from pg_stat_activity where application_name in (${names.map(quote).join(",")}) and state='active' and wait_event_type='Lock';`) === "2", "both owner claim sessions blocked");
  blocker.child.stdin.end("commit;\n");
  const released = await blocker.done;
  assert.equal(released.code, 0, released.stderr);
  return Promise.all(contenders.map(contender => contender.done));
}
async function check(label, action) {
  await action(); checks++;
  console.log(`✓ ${label}`);
}
async function run() {
  try {
    docker(["version", "--format", "{{.Server.Version}}"]);
    // Never let a test fetch an image, even if a local Docker daemon is available.
    docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"]);
  } catch (_) {
    throw new Error(`Docker local o la imagen ${IMAGE} no están disponibles; prueba no ejecutada. No se solicitó acceso adicional ni se descargaron imágenes.`);
  }
  container = docker(["run", "--rm", "--pull=never", "-d", "--network", "none", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE]);
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      assert.match(docker(["logs", container]), /PostgreSQL init process complete/);
      docker(["exec", container, "pg_isready", "-U", "postgres"]);
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await pause(150);
    }
  }
  sql(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    insert into auth.users values (${quote(FIRST)},clock_timestamp()),(${quote(SECOND)},clock_timestamp()),(${quote(UNCONFIRMED)},null);`);
  sql(fs.readFileSync(path.resolve(__dirname, "../migrations/202610230001_private_requests.sql"), "utf8"));

  await check("NULL, missing and unconfirmed users cannot claim the first owner", () => {
    for (const uid of [null, MISSING, UNCONFIRMED]) rejectSql(claim(uid), "PT403");
    assert.equal(ownerRows(), "[]");
  });
  await check("Anonymous, authenticated and service-role API callers have no execution permission", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(sql(`select has_function_privilege(${quote(role)},'nicolas_private.claim_first_owner(uuid)','execute');`), "f", role);
      rejectSql(claim(FIRST), "42501", role, FIRST);
      // Check the function ACL even when an installation separately grants schema usage.
      rejectSql(`begin;grant usage on schema nicolas_private to ${role};set local role ${role};${claim(FIRST)}`, "42501");
    }
    assert.equal(ownerRows(), "[]");
  });
  await check("The invoker guard still rejects API roles if execution is accidentally granted", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      rejectSql(`begin;grant usage on schema nicolas_private to ${role};grant execute on function nicolas_private.claim_first_owner(uuid) to ${role};set local role ${role};${claim(FIRST)}`, "PT403");
      assert.equal(sql(`select has_function_privilege(${quote(role)},'nicolas_private.claim_first_owner(uuid)','execute');`), "f");
    }
    assert.equal(ownerRows(), "[]");
  });
  await check("Postgres claims a confirmed first account and repeated claims return the same UUID", () => {
    assert.equal(sql(claim(FIRST)), FIRST);
    assert.equal(sql(claim(FIRST)), FIRST);
    assert.deepEqual(JSON.parse(ownerRows()), [FIRST]);
  });
  await check("A second confirmed account conflicts without changing the existing owner", () => {
    rejectSql(claim(SECOND), "PT409");
    assert.deepEqual(JSON.parse(ownerRows()), [FIRST]);
  });
  await check("Concurrent different accounts yield exactly one owner and one conflict", async () => {
    const results = await race(FIRST, SECOND);
    const winners = results.filter(result => result.code === 0), conflicts = results.filter(result => result.code !== 0);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(conflicts.length, 1, JSON.stringify(results));
    assert.match(conflicts[0].stderr, /\bPT409\b/);
    assert.ok([FIRST, SECOND].includes(winners[0].stdout));
    assert.deepEqual(JSON.parse(ownerRows()), [winners[0].stdout]);
  });
  await check("Concurrent claims for the same account both return that UUID and create one row", async () => {
    const results = await race(FIRST, FIRST);
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, FIRST);
    }
    assert.deepEqual(JSON.parse(ownerRows()), [FIRST]);
  });
  await check("A pre-existing allowlisted account prevents another account from taking ownership", () => {
    sql(`truncate nicolas_private.owner_users;insert into nicolas_private.owner_users(user_id) values(${quote(SECOND)});`);
    rejectSql(claim(FIRST), "PT409");
    assert.deepEqual(JSON.parse(ownerRows()), [SECOND]);
    assert.equal(sql(claim(SECOND)), SECOND);
  });
  console.log(`${checks} first-owner SQL checks passed (local PostgreSQL 17, network disabled).`);
}
run().catch(error => {
  console.error(error.stderr || error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  if (container) { try { docker(["rm", "-f", container]); } catch (_) {} }
});
