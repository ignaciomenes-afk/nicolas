"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { environmentConfiguration, verifyBackend } = require("../scripts/requests-preflight.cjs");
const { configureRequests } = require("../scripts/configure-requests.cjs");
const environment = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_public_key_for_tests" };
const ready = { status: 400, body: { code: "PT400", message: "Invalid request fields." } };
const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nicolas-activation-")), filename = path.join(directory, "config.json");
  const previous = '{"enabled":false,"supabase_url":"","publishable_key":""}\n';
  fs.writeFileSync(filename, previous);
  return { directory, filename, previous, clean: () => fs.rmSync(directory, { recursive: true, force: true }) };
};

test("reports both invalid environment fields without printing their values", () => {
  const bad = { SUPABASE_URL: "invalid-private-url-value", SUPABASE_PUBLISHABLE_KEY: "invalid-private-key-value" };
  assert.throws(() => environmentConfiguration(bad), error => {
    assert.match(error.message, /SUPABASE_URL/); assert.match(error.message, /SUPABASE_PUBLISHABLE_KEY/);
    assert.ok(!error.message.includes(bad.SUPABASE_URL)); assert.ok(!error.message.includes(bad.SUPABASE_PUBLISHABLE_KEY)); return true;
  });
});
test("a private or service_role key is rejected before any network or file write", async () => {
  const f = fixture(); let called = false;
  try {
    await assert.rejects(configureRequests({ filename: f.filename, environment: { ...environment, SUPABASE_PUBLISHABLE_KEY: "sb_secret_synthetic_private_test_value" }, verify: async () => { called = true; } }));
    assert.equal(called, false); assert.equal(fs.readFileSync(f.filename, "utf8"), f.previous);
  } finally { f.clean(); }
});
test("recognizes only our expected empty-input error as a live submission RPC", async () => {
  const config = environmentConfiguration(environment);
  const result = await verifyBackend(config, async received => { assert.deepEqual(received, config); return ready; });
  assert.deepEqual(result, { reachable: true, submission_rpc: true, owner_verified: false });
  for (const response of [{ status: 200, body: { status: "pending" } }, { status: 400, body: { code: "PT400", message: "Other app" } }, { status: 500, body: { message: "PrivateDatabaseDetails" } }]) {
    await assert.rejects(verifyBackend(config, async () => response), error => !error.message.includes("PrivateDatabaseDetails"));
  }
});
test("the actual HTTPS probe sends only an empty payload through curl stdin", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nicolas-curl-double-"));
  const previousPath = process.env.PATH;
  try {
    const script = `#!${process.execPath}
const assert = require('node:assert/strict');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => input += value);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  assert.ok(args.includes('--config') && args.includes('-'));
  assert.ok(args.includes('--proto') && args.includes('=https'));
  assert.ok(!args.includes('--insecure') && !args.includes('--location'));
  assert.ok(!args.some(arg => arg.includes('sb_publishable_')));
  const fields = Object.fromEntries(input.trim().split('\\n').filter(line => !line.startsWith('header =')).map(line => {
    const i = line.indexOf(' = '); return [line.slice(0, i), JSON.parse(line.slice(i + 3))];
  }));
  assert.equal(new URL(fields.url).pathname, '/rest/v1/rpc/nicolas_submit_request');
  assert.deepEqual(JSON.parse(fields.data), {p_payload:{}});
  assert.ok(input.includes('apikey: sb_publishable_'));
  assert.ok(!input.includes('Authorization:'));
  process.stdout.write(JSON.stringify({code:'PT400',message:'Invalid request fields.'}) + '\\n400');
});
`;
    fs.writeFileSync(path.join(directory, "curl"), script, { mode: 0o700 });
    process.env.PATH = directory + path.delimiter + previousPath;
    const result = await verifyBackend(environmentConfiguration(environment));
    assert.equal(result.submission_rpc, true); assert.equal(result.owner_verified, false);
  } finally { process.env.PATH = previousPath; fs.rmSync(directory, { recursive: true, force: true }); }
});
test("failed backend checks keep an existing connection byte-identical", async () => {
  const f = fixture();
  try {
    for (const response of [{ status: 401 }, { status: 403 }, { status: 404, body: { code: "PGRST202" } }]) {
      await assert.rejects(configureRequests({ filename: f.filename, environment, verify: c => verifyBackend(c, async () => response) }));
      assert.equal(fs.readFileSync(f.filename, "utf8"), f.previous);
    }
    assert.deepEqual(fs.readdirSync(f.directory), ["config.json"]);
  } finally { f.clean(); }
});
test("--check confirms the backend without enabling configuration or claiming owner access", async () => {
  const f = fixture();
  try {
    const result = await configureRequests({ filename: f.filename, environment, checkOnly: true, verify: c => verifyBackend(c, async () => ready) });
    assert.equal(result.changed, false); assert.equal(result.owner_verified, false);
    assert.equal(fs.readFileSync(f.filename, "utf8"), f.previous);
  } finally { f.clean(); }
});
test("activation writes only validated public config after the backend is confirmed", async () => {
  const f = fixture(); let observedPrevious = false;
  try {
    const result = await configureRequests({ filename: f.filename, environment, verify: async c => {
      observedPrevious = fs.readFileSync(f.filename, "utf8") === f.previous;
      return verifyBackend(c, async () => ready);
    } });
    assert.equal(observedPrevious, true); assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, "utf8")), environmentConfiguration(environment));
    assert.deepEqual(fs.readdirSync(f.directory), ["config.json"]);
  } finally { f.clean(); }
});
test("disabling remains available offline with no credentials or network", async () => {
  const f = fixture();
  try {
    const result = await configureRequests({ filename: f.filename, disable: true, environment: {}, verify: () => { throw new Error("must not connect"); } });
    assert.equal(result.disabled, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, "utf8")), { enabled: false, supabase_url: "", publishable_key: "" });
  } finally { f.clean(); }
});
