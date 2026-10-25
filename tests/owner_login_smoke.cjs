/* Owner onboarding through the real standalone UI and real browser transport.
 * node tests/owner_login_smoke.cjs
 * All Auth/Edge responses are in-memory doubles. No email, PAT, SQL or network
 * operation reaches a real provider; all browser profiles and builds are temporary.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, ".."), origin = "https://syntheticownerref.supabase.co";
const key = "sb_publishable_synthetic_owner_browser_public_key";
const approvedPrivate = "https://ignaciomenes-afk.github.io/nicolas/privado/";
const email = "owner-onboarding@example.invalid", code = "12345678";
const pat = "sbp_synthetic_owner_activation_pat_not_a_real_token";
const wrongPat = "sbp_synthetic_wrong_or_conflicting_pat";
const token = "synthetic-auth-access-token-kept-only-in-browser-memory";
const vaultPassword = "Clave privada sintetica solo pruebas 2026!";
const errors = [], consoleMessages = [], network = [];
let browser, context, page, directory, standaloneHtml, checks = 0;

async function check(label, action) {
  await action(); assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log(`✓ ${label}`); checks++;
}
async function state(values) { await page.evaluate(values => Object.assign(window.__ownerMock, values), values); }
async function calls(pathname) { return page.evaluate(pathname => window.__ownerCalls.filter(call => new URL(call.url).pathname === pathname), pathname); }
async function unlocked(create = false) {
  await page.locator("#privacy-gate").waitFor({ state: "visible" });
  await page.locator("#privacy-password").fill(vaultPassword);
  if (create) await page.locator("#privacy-password-repeat").fill(vaultPassword);
  await page.locator("#privacy-access-form").evaluate(form => form.requestSubmit());
  await page.locator("#privacy-gate").waitFor({ state: "hidden" });
  if (await page.locator("#nav-toggle").isVisible()) await page.locator("#nav-toggle").click();
  await page.locator('.main-nav [data-view="requests"]').click();
  await page.locator("#view-requests").waitFor({ state: "visible" });
}
async function lock() {
  await page.locator('[data-private-action="lock"]').click();
  await page.locator("#privacy-gate").waitFor({ state: "visible" });
}
async function sendCode() {
  await page.locator("#requests-code-email").fill(email);
  await page.locator("#requests-send-code").click();
  await page.locator("#requests-email-code").waitFor({ state: "visible" });
}
async function verifyCode() {
  await page.locator("#requests-email-code").fill(code);
  await page.locator("#requests-verify-code").click();
}
async function needsActivation() {
  await sendCode(); await verifyCode();
  await page.locator("#requests-activation-form").waitFor({ state: "visible" });
}
async function activation(value = pat) {
  await page.locator("#requests-access-token").fill(value);
  await page.locator("#requests-activate-owner").click();
}
async function noConnected() { assert.equal(await page.locator("#requests-connected").isVisible(), false); }
async function waitHold() { await page.waitForFunction(() => typeof window.__releaseOwnerMock === "function"); }
async function release() { await page.evaluate(() => { const resolve = window.__releaseOwnerMock; delete window.__releaseOwnerMock; window.__ownerMock.hold = ""; resolve(); }); }
async function waitIdle() {
  await page.waitForFunction(() => !document.getElementById("requests-send-code").disabled);
}
async function prepare() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nicolas-owner-login-"));
  const project = path.join(directory, "project"); await fs.mkdir(project);
  for (const name of ["scripts", "static", "shared", "integration"]) await fs.cp(path.join(root, name), path.join(project, name), { recursive: true });
  await fs.writeFile(path.join(project, "integration/requests-config.json"), JSON.stringify({ enabled: true, supabase_url: origin, publishable_key: key }));
  execFileSync(process.execPath, [path.join(project, "scripts/build-standalone.cjs")], { stdio: "pipe" });
  standaloneHtml = await fs.readFile(path.join(project, "entrega/ABRIR-NICOLAS.html"), "utf8");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/tmp/nicolas-google-chrome/opt/google/chrome/chrome",
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route(/^https?:/, route => route.abort("internetdisconnected"));
  context.on("request", request => {
    const target = new URL(request.url());
    const servedCallbackDocument = request.isNavigationRequest() && request.resourceType() === "document"
      && target.origin + target.pathname === approvedPrivate;
    if (!servedCallbackDocument && !/^(file:|blob:|data:|about:)/.test(request.url())) network.push(request.url());
  });
  await context.addInitScript(({ token, pat }) => {
    window.__ownerMock = { ownerAllowed: false, activationStatus: 200, badCode: false, activationGrantsAccess: true, hold: "" };
    window.__ownerCalls = [];
    window.fetch = async (url, options = {}) => {
      const pathname = new URL(String(url)).pathname;
      const call = { url: String(url), method: options.method || "GET", headers: Object.fromEntries(new Headers(options.headers)),
        body: options.body ? JSON.parse(options.body) : null, credentials: options.credentials, redirect: options.redirect };
      window.__ownerCalls.push(call);
      if (window.__ownerMock.hold === pathname) await new Promise(resolve => { window.__releaseOwnerMock = resolve; });
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (pathname === "/auth/v1/otp") return response({});
      if (pathname === "/auth/v1/user") return response({ id: "11111111-1111-4111-8111-111111111111", email: "owner-onboarding@example.invalid",
        email_confirmed_at: "2026-10-25T12:00:00Z" });
      if (pathname === "/auth/v1/verify") {
        if (window.__ownerMock.badCode) return response({ message: "Synthetic invalid code", code: "otp_expired" }, 400);
        return response({ access_token: token, token_type: "bearer", expires_in: 3600,
          refresh_token: "synthetic-refresh-token-must-not-be-stored", user: { id: "11111111-1111-4111-8111-111111111111", email_confirmed_at: "2026-10-25T12:00:00Z" } });
      }
      if (pathname === "/rest/v1/rpc/nicolas_list_requests") return window.__ownerMock.ownerAllowed
        ? response([]) : response({ code: "42501", message: "Synthetic owner allowlist denied" }, 403);
      if (pathname === "/functions/v1/nicolas-owner-access") {
        const status = window.__ownerMock.activationStatus;
        if (status !== 200 || call.body.access_token !== pat) return response({ error: "Synthetic provider secret must not render" }, status === 200 ? 403 : status);
        if (window.__ownerMock.activationGrantsAccess) window.__ownerMock.ownerAllowed = true;
        return response({ activated: true });
      }
      throw new Error("Unexpected synthetic endpoint " + pathname);
    };
  }, { token, pat });
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.stack || String(error)));
  page.on("console", message => consoleMessages.push(message.text()));
  await page.clock.setFixedTime(new Date("2026-10-25T15:00:00.000Z"));
  await page.goto(pathToFileURL(path.join(project, "entrega/ABRIR-NICOLAS.html")).href);
  await unlocked(true);
}
async function main() {
  await prepare();
  await check("Código por correo se solicita solo al tocar enviar, con clave pública y sin red real", async () => {
    assert.equal((await calls("/auth/v1/otp")).length, 0);
    assert.equal(await page.locator("#requests-code-form").isVisible(), true);
    assert.equal(await page.locator("#requests-login-form").isVisible(), false);
    await page.locator("#requests-code-email").fill(email);
    assert.equal((await calls("/auth/v1/otp")).length, 0);
    await page.locator("#requests-send-code").click();
    await page.locator("#requests-email-code").waitFor({ state: "visible" });
    const sent = await calls("/auth/v1/otp"); assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { email, create_user: true });
    assert.equal(sent[0].headers.apikey, key); assert.equal(sent[0].headers.authorization, undefined);
    assert.equal(new URL(sent[0].url).searchParams.get("redirect_to"), approvedPrivate);
    assert.ok(!sent[0].url.includes(email));
    await noConnected();
  });
  await check("Verificar correo no concede acceso: la cuenta nueva exige autorización separada", async () => {
    await state({ badCode: true }); await verifyCode();
    await page.locator("#requests-code-error").waitFor({ state: "visible" }); await noConnected();
    await state({ badCode: false }); await verifyCode();
    await page.locator("#requests-activation-form").waitFor({ state: "visible" }); await noConnected();
    assert.equal(await page.locator("#requests-email-code").inputValue(), "");
    const verified = await calls("/auth/v1/verify");
    assert.deepEqual(verified.at(-1).body, { email, token: code, type: "email" });
    assert.equal((await calls("/functions/v1/nicolas-owner-access")).length, 0);
    const lists = await calls("/rest/v1/rpc/nicolas_list_requests");
    assert.equal(lists.at(-1).headers.authorization, "Bearer " + token);
  });
  await check("PAT incorrecto o propietario existente no simulan conexión ni exponen el secreto", async () => {
    for (const status of [403, 409]) {
      await state({ activationStatus: status }); await activation(wrongPat);
      await page.locator("#requests-activation-error").waitFor({ state: "visible" });
      await noConnected(); assert.equal(await page.locator("#requests-access-token").inputValue(), "");
      assert.ok(!(await page.locator("#requests-activation-error").textContent()).includes("Synthetic provider secret"));
    }
  });
  await check("Respuesta de activación positiva sin permiso en la base nunca conecta la bandeja", async () => {
    await state({ activationStatus: 200, activationGrantsAccess: false, ownerAllowed: false });
    const before = (await calls("/rest/v1/rpc/nicolas_list_requests")).length;
    await activation();
    await page.waitForFunction(before => window.__ownerCalls.filter(call => new URL(call.url).pathname === "/rest/v1/rpc/nicolas_list_requests").length > before, before);
    await page.waitForFunction(() => !document.getElementById("requests-activate-owner").disabled);
    await noConnected();
    await page.locator("#requests-activation-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#requests-access-token").inputValue(), "");
    await state({ activationGrantsAccess: true });
  });
  await check("Activación confirma el permiso leyendo la bandeja antes de mostrar conexión", async () => {
    await state({ activationStatus: 200 }); await activation();
    await page.locator("#requests-connected").waitFor({ state: "visible" });
    assert.equal(await page.locator("#requests-access-token").inputValue(), "");
    const activations = await calls("/functions/v1/nicolas-owner-access");
    const call = activations.at(-1); assert.deepEqual(call.body, { access_token: pat });
    assert.equal(call.headers.authorization, "Bearer " + token); assert.equal(call.headers.apikey, key);
    assert.equal(new URL(call.url).search, ""); assert.equal(call.redirect, "error");
    const timeline = await page.evaluate(() => window.__ownerCalls.map(call => new URL(call.url).pathname));
    const lastActivation = timeline.lastIndexOf("/functions/v1/nicolas-owner-access");
    assert.equal(timeline[lastActivation + 1], "/rest/v1/rpc/nicolas_list_requests");
  });
  await check("Propietario ya autorizado entra por código sin volver a pedir PAT", async () => {
    const before = (await calls("/functions/v1/nicolas-owner-access")).length;
    await lock(); await unlocked(); await sendCode(); await verifyCode();
    await page.locator("#requests-connected").waitFor({ state: "visible" });
    assert.equal((await calls("/functions/v1/nicolas-owner-access")).length, before);
    assert.equal(await page.locator("#requests-activation-form").isVisible(), false);
  });
  await check("Enlace de acceso pegado acepta solo Auth del mismo proyecto y nunca navega al enlace", async () => {
    await lock(); await unlocked(); await sendCode();
    const before = (await calls("/auth/v1/verify")).length;
    const currentURL = page.url();
    for (const wrong of ["https://evil.example.invalid/auth/v1/verify?token_hash=synthetic&type=magiclink",
      origin + "/functions/v1/nicolas-owner-access?token_hash=synthetic&type=magiclink"]) {
      const totalBefore = await page.evaluate(() => window.__ownerCalls.length);
      await page.locator("#requests-email-code").fill(wrong); await page.locator("#requests-verify-code").click();
      await page.locator("#requests-code-error").waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.getElementById("requests-verify-code").disabled);
      assert.equal((await calls("/auth/v1/verify")).length, before);
      assert.equal(await page.evaluate(() => window.__ownerCalls.length), totalBefore, "Untrusted links must not cause any fetch");
      assert.equal(page.url(), currentURL); await noConnected();
    }
    await page.locator("#requests-email-code").fill(origin + "/auth/v1/verify?token_hash=synthetic_pasted_magic_link_hash&type=magiclink");
    await page.locator("#requests-verify-code").click(); await page.locator("#requests-connected").waitFor({ state: "visible" });
    const verified = (await calls("/auth/v1/verify")).at(-1);
    assert.deepEqual(verified.body, { token_hash: "synthetic_pasted_magic_link_hash", type: "email" });
    assert.equal(page.url(), currentURL);
  });
  await check("Bloquear durante OTP invalida respuestas tardías y deja el formulario reutilizable", async () => {
    await lock(); await unlocked(); await state({ ownerAllowed: false, hold: "/auth/v1/verify" });
    await sendCode(); await verifyCode(); await waitHold();
    await lock(); await unlocked(); await release(); await waitIdle();
    await noConnected(); assert.equal(await page.locator("#requests-activation-form").isVisible(), false);
    assert.equal(await page.locator("#requests-code-email").inputValue(), "");
    assert.equal(await page.locator("#requests-email-code").inputValue(), "");
    await needsActivation();
  });
  await check("Bloquear durante activación no revive la sesión aunque el proveedor responda después", async () => {
    await state({ hold: "/functions/v1/nicolas-owner-access", activationStatus: 200 });
    await activation(); await waitHold(); await lock(); await unlocked(); await release(); await waitIdle();
    await noConnected(); assert.equal(await page.locator("#requests-access-token").inputValue(), "");
    assert.equal(await page.locator("#requests-code-email").inputValue(), "");
    assert.equal(await page.locator("#requests-activation-form").isVisible(), false);
    const outcome = await page.evaluate(async () => { try { await NicolasCloud.listRequests(); return false; } catch (_) { return true; } });
    assert.equal(outcome, true);
  });
  await check("Correo, códigos y tokens no quedan en URL, almacenamiento, respaldo ni consola; móvil usable", async () => {
    const stored = await page.evaluate(async () => {
      const records = [];
      for (const metadata of await indexedDB.databases()) {
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open(metadata.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        for (const store of db.objectStoreNames) records.push(await new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }));
        db.close();
      }
      return JSON.stringify({ records, local: { ...localStorage }, session: { ...sessionStorage }, backup: await NicolasStore.exportBackup() });
    });
    const links = await page.locator("a[href]").evaluateAll(links => links.map(link => link.href));
    const urls = JSON.stringify([page.url(), ...links]);
    for (const secret of [email, code, pat, wrongPat, token, "synthetic-refresh-token-must-not-be-stored"]) {
      assert.ok(!stored.includes(secret), "Storage must not contain login secrets");
      assert.ok(!urls.includes(secret), "URLs must not contain login secrets");
      assert.ok(!consoleMessages.some(message => message.includes(secret)), "Console must not contain login secrets");
    }
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const size = await page.evaluate(() => ({ width: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(size.doc <= size.width && size.body <= size.width, JSON.stringify(size));
    }
    assert.deepEqual(network, []);
  });
  await check("Callback limpia tokens antes del desbloqueo y solo verifica la cuenta después de abrir la bóveda", async () => {
    // Serve the built document from its approved HTTPS callback address without
    // any network. The hash remains visible to the real startup code only.
    await context.route(target => target.origin + target.pathname === approvedPrivate,
      route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: standaloneHtml }));
    await page.close(); page = await context.newPage();
    page.on("pageerror", error => errors.push(error.stack || String(error)));
    page.on("console", message => consoleMessages.push(message.text()));
    await page.clock.setFixedTime(new Date("2026-10-25T15:00:00.000Z"));
    const callback = approvedPrivate + "#access_token=" + encodeURIComponent(token) + "&expires_in=3600&token_type=bearer&type=magiclink";
    await page.goto(callback); await page.locator("#privacy-gate").waitFor({ state: "visible" });
    assert.ok(["", "#requests"].includes(new URL(page.url()).hash));
    assert.ok(!page.url().includes("access_token"));
    assert.equal((await calls("/auth/v1/user")).length, 0);
    assert.equal((await calls("/rest/v1/rpc/nicolas_list_requests")).length, 0);
    await unlocked(true); await page.locator("#requests-activation-form").waitFor({ state: "visible" });
    assert.equal((await calls("/auth/v1/user")).length, 1); await noConnected();
    const user = (await calls("/auth/v1/user"))[0];
    assert.equal(user.method, "GET"); assert.equal(user.headers.authorization, "Bearer " + token);
    await lock(); await page.close(); page = await context.newPage();
    page.on("pageerror", error => errors.push(error.stack || String(error)));
    page.on("console", message => consoleMessages.push(message.text()));
    await page.clock.setFixedTime(new Date("2026-10-25T15:00:00.000Z"));
    await page.goto(callback); await page.locator("#privacy-gate").waitFor({ state: "visible" });
    assert.ok(["", "#requests"].includes(new URL(page.url()).hash));
    assert.ok(!page.url().includes("access_token"));
    await page.evaluate(() => NicolasStore.lock()); await unlocked();
    assert.equal((await calls("/auth/v1/user")).length, 0, "Explicit lock must discard the pending callback token");
    await noConnected(); assert.equal(await page.locator("#requests-activation-form").isVisible(), false);
    assert.deepEqual(network, []);
  });
  console.log(`\n${checks} comprobaciones de acceso por código y activación correctas; todo simulado.`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); if (directory) await fs.rm(directory, { recursive: true, force: true });
});
