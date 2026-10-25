/* Production setup helper in real Chrome with a synthetic public configuration.
 * node tests/requests_setup_smoke.cjs
 * Builds only in /tmp. Supabase fetch and clipboard are doubles; SQL is never run.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, ".."), origin = "https://syntheticsetupref.supabase.co";
const publicKey = "sb_publishable_synthetic_setup_key_for_tests";
const email = "o'neil+setup@example.invalid";
const errors = [], network = [];
let directory, browser, context, page, migration, built, projectPath, checks = 0;
const selectors = { email: "#setup-owner-email", sql: "#setup-sql-output", copy: "#setup-copy-sql",
  check: "#setup-check", status: "#setup-probe-status" };
async function check(label, action) {
  await action(); assert.deepEqual(errors, [], "No uncaught errors in the setup helper");
  checks++; console.log(`✓ ${label}`);
}
async function noOverflow() {
  const size = await page.evaluate(() => ({ viewport: innerWidth,
    document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(size.document <= size.viewport && size.body <= size.viewport, JSON.stringify(size));
}
async function storageEmpty() {
  const result = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
    databases: (await indexedDB.databases()).map(value => value.name), search: location.search, hash: location.hash }));
  assert.deepEqual(result, { local: 0, session: 0, databases: [], search: "", hash: "" });
}
async function copyBlocked() {
  return !(await page.locator(selectors.copy).isVisible()) || await page.locator(selectors.copy).isDisabled();
}
async function setScenario(scenario) { await page.evaluate(scenario => { window.__scenario = scenario; }, scenario); }
async function probe(scenario) {
  await setScenario(scenario); const previous = await page.evaluate(() => window.__fetchCalls.length);
  await page.locator(selectors.check).click();
  await page.waitForFunction(previous => window.__fetchCalls.length > previous, previous);
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, selectors.check);
  return page.locator(selectors.status).textContent();
}
async function prepare() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nicolas-setup-smoke-"));
  const project = path.join(directory, "project"); await fs.mkdir(project);
  projectPath = project;
  for (const name of ["scripts", "integration", "shared", "supabase"]) await fs.cp(path.join(root, name), path.join(project, name), { recursive: true });
  await fs.writeFile(path.join(project, "integration/requests-config.json"), JSON.stringify({ enabled: false,
    supabase_url: origin, publishable_key: publicKey }));
  execFileSync(process.execPath, [path.join(project, "scripts/build-requests-setup.cjs")], { stdio: "pipe" });
  const target = path.join(project, "entrega/ACTIVAR-SOLICITUDES.html");
  built = await fs.readFile(target, "utf8"); migration = await fs.readFile(path.join(project, "supabase/migrations/202610230001_private_requests.sql"), "utf8");
  assert.equal(await fs.readFile(path.join(project, "docs/activar/index.html"), "utf8"), built);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/tmp/nicolas-google-chrome/opt/google/chrome/chrome",
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.on("request", request => { if (!/^(file:|data:|blob:|about:)/.test(request.url())) network.push(request.url()); });
  await context.route(/^https?:/, route => route.abort("internetdisconnected"));
  await context.addInitScript(() => {
    window.__fetchCalls = []; window.__scenario = "ready"; window.__copied = null;
    window.__denyClipboard = false; window.__xss = 0;
    window.fetch = async (url, options = {}) => {
      window.__fetchCalls.push({ url: String(url), options: { ...options, signal: undefined } });
      if (window.__scenario === "network") throw new TypeError("Synthetic network unavailable");
      const responses = {
        ready: [400, { code: "PT400", message: "Invalid request fields." }],
        missing: [404, { code: "PGRST202", message: "PrivateDatabaseDiagnosticMustNotRender" }],
        unauthorized: [401, { code: "PGRST301", message: "PrivateDatabaseDiagnosticMustNotRender" }],
        forbidden: [403, { message: "PrivateDatabaseDiagnosticMustNotRender" }],
        unexpectedSuccess: [200, { status: "pending" }],
        wrongError: [400, { code: "PT400", message: "Other application error" }],
        wrongCode: [400, { code: "OTHER", message: "Invalid request fields." }],
        wrongCapitalization: [400, { code: "PT400", message: "invalid request fields." }],
        missingPeriod: [400, { code: "PT400", message: "Invalid request fields" }],
        malformed: [400, "<img src=x onerror=window.__xss=1>"],
      };
      const [status, body] = responses[window.__scenario];
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status,
        headers: { "Content-Type": "application/json" } });
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => {
      if (window.__denyClipboard) throw new DOMException("Synthetic clipboard denied", "NotAllowedError");
      window.__copied = String(value);
    } } });
  });
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.stack || String(error)));
  await page.goto(pathToFileURL(target).href); await page.locator(selectors.email).waitFor();
}
async function main() {
  await prepare();
  await check("Asistente standalone idéntico a la copia publicable; sin recursos externos ni probes automáticos", async () => {
    assert.ok(!/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\brel=["']stylesheet["']/i.test(built));
    assert.equal(new URL(page.url()).protocol, "file:");
    assert.equal(await page.evaluate(() => window.__fetchCalls.length), 0);
    assert.equal(await page.locator(selectors.email).inputValue(), "");
    assert.equal(await copyBlocked(), true);
    await storageEmpty();
  });
  await check("Email inválido o con HTML no habilita SQL ni copiar; no ejecuta contenido", async () => {
    for (const value of ["sin-arroba", "persona@", '<img src=x onerror="window.__xss=1">@example.invalid']) {
      await page.locator(selectors.email).fill(value);
      assert.equal(await copyBlocked(), true);
      assert.equal(await page.locator(selectors.sql).inputValue(), "");
    }
    assert.equal(await page.evaluate(() => window.__xss), 0);
    assert.equal(await page.locator("img[src=x]").count(), 0);
    assert.equal(await page.evaluate(() => window.__fetchCalls.length), 0);
  });
  let generated;
  await check("Email válido genera migración completa y alta de owner con apóstrofe escapado en una transacción", async () => {
    await page.locator(selectors.email).fill(email);
    await page.locator("#setup-generate-sql").click();
    await page.waitForFunction(selector => !document.querySelector(selector).disabled, selectors.copy);
    generated = await page.locator(selectors.sql).inputValue();
    assert.ok(generated.includes(migration.replace(/\bcommit\s*;\s*$/i, "").trim()), "All migration statements must be preserved");
    assert.equal((generated.match(/^\s*begin\s*;/gim) || []).length, 1);
    assert.equal((generated.match(/^\s*commit\s*;/gim) || []).length, 1);
    assert.match(generated, /commit\s*;\s*$/i);
    assert.match(generated, /\bdo\s+\$/i); assert.match(generated, /auth\.users/i);
    assert.match(generated, /nicolas_private\.owner_users/i);
    assert.ok(generated.includes("'o''neil+setup@example.invalid'"), "Email apostrophe must be doubled inside the SQL literal");
    assert.match(generated, /raise\s+exception/i);
    assert.match(generated, /count\s*\(\s*\*\s*\)\s+into\s+v_matching_users/i);
    assert.match(generated, /if\s+v_matching_users\s*<>\s*1\s+then/i);
    assert.match(generated, /select\s+id\s+into\s+strict\s+v_owner_id/i);
    await page.locator(selectors.copy).click();
    assert.equal(await page.evaluate(() => window.__copied), generated);
    await storageEmpty();
  });
  await check("Clipboard bloqueado deja el SQL legible y seleccionable para copiar a mano", async () => {
    await page.evaluate(() => { window.__denyClipboard = true; window.__copied = null; });
    await page.locator(selectors.copy).click();
    assert.equal(await page.evaluate(() => window.__copied), null);
    assert.equal(await page.locator(selectors.sql).isVisible(), true);
    assert.equal(await page.locator(selectors.sql).inputValue(), generated);
    assert.match(await page.locator("#setup-copy-status").textContent(), /seleccion|Ctrl\+C|Cmd\+C/i);
    await page.locator(selectors.sql).evaluate(field => { field.focus(); field.select(); });
    const selection = await page.locator(selectors.sql).evaluate(field => field.value.slice(field.selectionStart, field.selectionEnd));
    assert.equal(selection, generated);
    await page.evaluate(() => { window.__denyClipboard = false; });
  });
  await check("Correo con delimitador SQL no puede cerrar el DO; una edición inválida borra el SQL preparado", async () => {
    const previousTag = [...generated.matchAll(/\bdo\s+(\$[a-z0-9_]*\$)/gi)].at(-1)[1];
    const unusual = previousTag + email;
    await page.locator(selectors.email).fill(unusual);
    assert.equal(await copyBlocked(), true);
    await page.locator("#setup-generate-sql").click();
    const safe = await page.locator(selectors.sql).inputValue();
    const chosenTag = [...safe.matchAll(/\bdo\s+(\$[a-z0-9_]*\$)/gi)].at(-1)[1];
    assert.notEqual(chosenTag, previousTag); assert.ok(!unusual.includes(chosenTag));
    assert.ok(safe.includes("'" + unusual.replace(/'/g, "''") + "'"));
    assert.equal(safe.split(chosenTag).length - 1, 2, "Exactly one opening and closing DO delimiter");
    await page.locator(selectors.email).fill("correo-inválido");
    assert.equal(await page.locator(selectors.sql).inputValue(), ""); assert.equal(await copyBlocked(), true);
    await page.locator(selectors.email).fill(email); await page.locator("#setup-generate-sql").click();
    assert.equal(await page.locator(selectors.sql).inputValue(), generated);
  });
  await check("Enlaces abren Auth/SQL del proyecto correcto sin correo, tokens ni datos en URL", async () => {
    const links = await page.locator('a[href^="https:"]').evaluateAll(links => links.map(link => ({ href: link.href, rel: link.rel, target: link.target })));
    assert.ok(links.some(link => /\/project\/syntheticsetupref\/auth\/users\/?$/.test(new URL(link.href).pathname)));
    assert.ok(links.some(link => /\/project\/syntheticsetupref\/sql(?:\/new)?\/?$/.test(new URL(link.href).pathname)));
    for (const link of links) {
      const target = new URL(link.href); assert.equal(target.origin, "https://supabase.com");
      assert.equal(target.search, ""); assert.equal(target.hash, "");
      assert.ok(!link.href.includes("example.invalid")); assert.ok(!link.href.includes(publicKey));
      assert.ok(link.rel.split(/\s+/).includes("noopener"));
    }
    await storageEmpty();
  });
  await check("Comprobación envía exclusivamente p_payload vacío y reconoce solo el error esperado", async () => {
    const message = await probe("ready");
    assert.equal(await page.locator(selectors.status).getAttribute("data-state"), "success");
    assert.match(message, /instalad|comprobad|responde|disponible/i);
    assert.doesNotMatch(message, /(?:bandeja|p[aá]gina)\s+(?:ya\s+)?activada|administrador\s+verificado|ya\s+recib[ií]s/i);
    const call = await page.evaluate(() => window.__fetchCalls.at(-1));
    assert.equal(call.url, origin + "/rest/v1/rpc/nicolas_submit_request");
    assert.equal(call.options.method, "POST"); assert.deepEqual(JSON.parse(call.options.body), { p_payload: {} });
    const headers = Object.fromEntries(Object.entries(call.options.headers).map(([name, value]) => [name.toLowerCase(), value]));
    assert.equal(headers.apikey, publicKey); assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.authorization, undefined);
    assert.equal(call.options.redirect, "error"); assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.referrerPolicy, "no-referrer");
    assert.ok(!JSON.stringify(call).includes(email));
  });
  await check("404, clave rechazada, red caída, JSON dañado o respuesta 200 nunca declaran instalación confirmada", async () => {
    for (const scenario of ["missing", "unauthorized", "forbidden", "network", "unexpectedSuccess", "wrongError", "wrongCode", "wrongCapitalization", "missingPeriod", "malformed"]) {
      const message = await probe(scenario);
      assert.equal(await page.locator(selectors.status).getAttribute("data-state"), "error", scenario);
      assert.doesNotMatch(message, /instalaci[oó]n\s+(?:ya\s+)?(?:confirmada|comprobada)|funci[oó]n\s+instalada|comprobaci[oó]n\s+correcta/i, scenario);
      assert.ok(!message.includes("PrivateDatabaseDiagnosticMustNotRender"), "Raw backend diagnostics must not enter the page");
      assert.equal(await page.evaluate(() => window.__xss), 0);
    }
  });
  await check("Vista usable a 320/390 píxeles; email vive solo en RAM y se borra al reabrir", async () => {
    for (const width of [320, 390]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(); }
    await storageEmpty();
    await page.reload(); await page.locator(selectors.email).waitFor();
    assert.equal(await page.locator(selectors.email).inputValue(), "");
    assert.equal(await page.locator(selectors.sql).inputValue(), "");
    assert.equal(await copyBlocked(), true);
    await storageEmpty(); assert.deepEqual(network, []);
  });
  await check("Clave anon pública anterior usa Bearer anon sin sesión ni datos personales", async () => {
    const token = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") + "."
      + Buffer.from(JSON.stringify({ role: "anon", ref: "syntheticsetupref" })).toString("base64url") + ".syntheticSignature";
    await fs.writeFile(path.join(projectPath, "integration/requests-config.json"), JSON.stringify({ enabled: false,
      supabase_url: origin, publishable_key: token }));
    execFileSync(process.execPath, [path.join(projectPath, "scripts/build-requests-setup.cjs")], { stdio: "pipe" });
    await page.reload(); await page.locator(selectors.check).waitFor();
    await probe("ready");
    assert.equal(await page.locator(selectors.status).getAttribute("data-state"), "success");
    const call = await page.evaluate(() => window.__fetchCalls.at(-1));
    const headers = Object.fromEntries(Object.entries(call.options.headers).map(([name, value]) => [name.toLowerCase(), value]));
    assert.equal(headers.apikey, token); assert.equal(headers.authorization, "Bearer " + token);
    assert.deepEqual(JSON.parse(call.options.body), { p_payload: {} });
    await storageEmpty(); assert.deepEqual(network, []);
  });
  console.log(`\n${checks} comprobaciones del asistente correctas. Sin SQL ejecutado ni conexiones reales.`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); if (directory) await fs.rm(directory, { recursive: true, force: true });
});
