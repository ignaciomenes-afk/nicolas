/* Browser UI integration with an in-memory cloud double and encrypted local vault.
 * node tests/requests_ui_smoke.cjs
 * Builds production standalone pages inside /tmp. Never contacts a real backend,
 * opens WhatsApp, sends a message, or touches a user's profile/customer data.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const core = require("../client-request/loan-core.js");

const root = path.resolve(__dirname, ".."), rows = new Map(), calls = [], errors = [], network = [];
const fixedTime = "2026-10-23T15:00:00.000Z", password = "Clave privada solo de pruebas 2026!";
const credentials = { email: "administrador@example.invalid", password: "Bandeja sintetica 2026!" };
const synthetic = { full_name: "Cliente Sintético de Prueba", cuil: "20-12345678-6",
  client_whatsapp: "+54 9 11 0000 0000", address_street: "Calle Sintética", address_number: "123",
  locality: "Localidad de Prueba", principal: "1000000", term_months: "6" };
let browser, context, directory, publicUrl, privateUrl, checks = 0, mode = "success", release, releaseLogin;
let holdLogin = false;
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function cloudError(status, message) { return Object.assign(new Error(message), { status }); }
async function check(label, action) {
  await action(); assert.deepEqual(errors, [], "No uncaught browser errors");
  checks++; console.log(`✓ ${label}`);
}
function quote(input) {
  const value = core.calculate(input), result = {};
  for (const key of ["principal_cents", "term_months", "first_due_date", "due_anchor_day",
    "interest_percent", "interest_cents", "base_total_cents", "rounding_adjustment_cents", "total_cents", "installments"]) result[key] = clone(value[key] ?? input[key]);
  return { policy_version: "nicolas-total-v1", ...result };
}
function save(payload) {
  if (!rows.has(payload.request_id)) rows.set(payload.request_id, { id: payload.request_id, status: "pending",
    created_at: "2026-10-23T14:00:00.000Z", customer: clone(payload.customer), quote: quote(payload.quote), approved_payload: null });
  return { request_id: payload.request_id, status: "pending" };
}
async function rpc(action, args, authenticated) {
  calls.push({ action, args: clone(args), authenticated });
  try {
    if (action === "signIn") {
      if (args.email !== credentials.email || args.password !== credentials.password) throw cloudError(403, "Cuenta de prueba sin acceso");
      if (holdLogin) await new Promise(resolve => { releaseLogin = resolve; });
      return { ok: true, value: { authenticated: true } };
    }
    if (action === "signOut") return { ok: true, value: { authenticated: false } };
    if (action === "submit") {
      const current = mode;
      if (current === "fail") { mode = "success"; throw cloudError(503, "Fallo sintético de conexión"); }
      if (current === "hold") await new Promise(resolve => { release = resolve; });
      const receipt = save(args.payload);
      return { ok: true, value: current === "wrong-receipt" ? { ...receipt, request_id: randomUUID() } : receipt };
    }
    if (!authenticated) throw cloudError(401, "La sesión de prueba no está abierta");
    if (action === "listRequests") return { ok: true, value: clone([...rows.values()]) };
    const row = rows.get(args.id);
    if (!row) throw cloudError(404, "Solicitud sintética ausente");
    if (action === "approveRequest") {
      if (row.status === "rejected") throw cloudError(409, "Solicitud ya rechazada");
      if (!row.approved_payload) row.approved_payload = { request_id: row.id,
        approved_at: "2026-10-23T14:45:00.000Z", issued_date: "2026-10-23",
        customer: clone(row.customer), quote: clone(row.quote) };
      row.status = "approved"; return { ok: true, value: clone(row.approved_payload) };
    }
    if (action === "rejectRequest") {
      if (row.status === "approved") throw cloudError(409, "Solicitud ya aprobada");
      row.status = "rejected"; return { ok: true, value: { id: row.id, status: row.status } };
    }
    throw new Error("Unknown synthetic RPC");
  } catch (error) { return { ok: false, status: error.status || 500, message: error.message }; }
}
async function installCloudDouble(target) {
  await target.exposeBinding("__testCloudRPC", (_source, action, args, authenticated) => rpc(action, args, authenticated));
  await target.addInitScript(() => {
    let authenticated = false, generation = 0;
    window.__uiEvents = []; window.__opened = []; window.__clipboard = null; window.__xss = 0;
    async function invoke(action, args = {}) {
      window.__uiEvents.push({ action: "cloud-start", method: action });
      const result = await window.__testCloudRPC(action, args, authenticated);
      if (!result.ok) throw Object.assign(new Error(result.message), { status: result.status });
      window.__uiEvents.push({ action: "cloud-complete", method: action });
      return result.value;
    }
    const fake = Object.freeze({ configured: true, config: Object.freeze({ enabled: true }),
      submit: payload => invoke("submit", { payload }),
      signIn: async (email, password) => {
        authenticated = false; const ticket = ++generation;
        const result = await invoke("signIn", { email, password });
        if (ticket !== generation) throw Object.assign(new Error("Sesión cerrada durante el acceso de prueba"), { status: 401 });
        authenticated = true; return result;
      },
      signOut: () => { generation++; authenticated = false; return invoke("signOut"); },
      listRequests: () => invoke("listRequests"), approveRequest: id => invoke("approveRequest", { id }),
      rejectRequest: id => invoke("rejectRequest", { id }) });
    Object.defineProperty(window, "NicolasCloud", { configurable: true, get: () => fake, set() {} });
    window.addEventListener("nicolas:locked", () => { generation++; authenticated = false; });
    window.print = () => { window.top.__printCount = (window.top.__printCount || 0) + 1; };
    window.open = (url, target, features) => {
      const popup = { closed: false, opener: null,
        document: document.implementation.createHTMLDocument("Solicitud de prueba"),
        close() { popup.closed = true; window.__uiEvents.push({ action: "popup-close" }); },
        location: { replace(value) { window.__opened.push(String(value)); window.__uiEvents.push({ action: "whatsapp", url: String(value) }); } } };
      window.__uiEvents.push({ action: "popup-reserve", url: String(url), target, features });
      if (String(url) !== "about:blank") { window.__opened.push(String(url)); window.__uiEvents.push({ action: "whatsapp", url: String(url) }); }
      return popup;
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => {
      window.__clipboard = String(value); window.__uiEvents.push({ action: "clipboard" });
    } } });
  });
}
async function prepare() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nicolas-requests-ui-"));
  const project = path.join(directory, "project"); await fs.mkdir(project);
  for (const name of ["scripts", "static", "shared", "integration", "client-request"]) await fs.cp(path.join(root, name), path.join(project, name), { recursive: true });
  await fs.mkdir(path.join(project, "entrega"));
  await fs.copyFile(path.join(root, "entrega/LEEME-SOLICITUD.txt"), path.join(project, "entrega/LEEME-SOLICITUD.txt"));
  // Always exercise the final delivery's disabled configuration; the test double
  // is injected only into disposable browser contexts, never into built files.
  await fs.writeFile(path.join(project, "integration/requests-config.json"), JSON.stringify({ enabled: false, supabase_url: "", publishable_key: "" }));
  execFileSync(process.execPath, [path.join(project, "scripts/build-client-request.cjs")], { stdio: "pipe" });
  execFileSync(process.execPath, [path.join(project, "scripts/build-standalone.cjs")], { stdio: "pipe" });
  publicUrl = pathToFileURL(path.join(project, "entrega/PRESTAMOS.html")).href;
  privateUrl = pathToFileURL(path.join(project, "entrega/ABRIR-NICOLAS.html")).href;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/tmp/nicolas-google-chrome/opt/google/chrome/chrome",
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installCloudDouble(context);
  await trackContext(context);
}
async function trackContext(target) {
  await target.route(/^https?:/, route => route.abort("internetdisconnected"));
  target.on("request", request => { if (!/^(file:|blob:|data:|about:)/.test(request.url())) network.push(request.url()); });
  target.on("page", page => page.on("pageerror", error => errors.push(error.stack || String(error))));
}
async function openPage(target, container = context) {
  const page = await container.newPage(); await page.clock.setFixedTime(new Date(fixedTime)); await page.goto(target);
  return page;
}
async function noOverflow(page) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(size.document <= size.viewport && size.body <= size.viewport, JSON.stringify(size));
}
async function fillCustomer(page) {
  for (const [name, value] of Object.entries(synthetic)) {
    const field = page.locator(`[name="${name}"]`);
    if (name === "term_months") await field.selectOption(value); else await field.fill(value);
  }
  await page.locator('[name="contact_consent"]').check();
}
function submitCalls() { return calls.filter(call => call.action === "submit"); }
async function waitHolding(page) { await page.waitForFunction(() => document.getElementById("request-form").getAttribute("aria-busy") === "true"); }
async function waitIdle(page) { await page.waitForFunction(() => !document.getElementById("request-form").hasAttribute("aria-busy")); }
async function waitForHold() {
  for (let attempt = 0; attempt < 100 && !release; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof release, "function", "Fake backend must have a pending receipt");
}
function releaseHold() { const pending = release; release = null; mode = "success"; pending(); }
async function opened(page) { return page.evaluate(() => window.__opened); }
async function privateApi(page, endpoint) { return page.evaluate(endpoint => NicolasStore.request(endpoint), endpoint); }
async function unlock(page, create = false) {
  await page.locator("#privacy-gate").waitFor({ state: "visible" });
  await page.locator("#privacy-password").fill(password);
  if (create) await page.locator("#privacy-password-repeat").fill(password);
  await page.locator("#privacy-access-form").evaluate(form => form.requestSubmit());
  await page.locator("#privacy-gate").waitFor({ state: "hidden" });
}
async function navigateRequests(page) {
  if (await page.locator("#nav-toggle").isVisible()) await page.locator("#nav-toggle").click();
  await page.locator('.main-nav [data-view="requests"]').click();
  await page.locator("#view-requests").waitFor({ state: "visible" });
}
async function login(page, valid = true) {
  await page.locator("#requests-auth-password").click();
  await page.locator("#requests-email").fill(credentials.email);
  await page.locator("#requests-password").fill(valid ? credentials.password : "Clave equivocada sintética");
  await page.locator("#requests-login-submit").click();
  if (valid) {
    await page.locator("#requests-connected").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.getElementById("requests-sync").disabled);
  } else await page.locator("#requests-login-error").waitFor({ state: "visible" });
}
function card(page, id) { return page.locator(`#requests-list article[data-request-id="${id}"]`); }
async function approve(page, id) {
  await page.locator("#requests-filter").selectOption("pending");
  await card(page, id).locator('[data-requests-action="review"]').click();
  await page.locator("#requests-modal").waitFor({ state: "visible" });
  assert.equal(await page.locator("#requests-approve").isDisabled(), true);
  await page.locator("#requests-approve-check").check(); await page.locator("#requests-approve").click();
  await page.locator("#requests-modal").waitFor({ state: "hidden" });
}
async function publicChecks() {
  const page = await openPage(publicUrl); await fillCustomer(page);
  await check("Envío público fallido conserva datos, no declara recepción y no abre WhatsApp", async () => {
    mode = "fail"; await page.locator("#send-request").click();
    await page.locator("#form-error").waitFor({ state: "visible" }); await waitIdle(page);
    assert.match(await page.locator("#form-error").textContent(), /No pudimos confirmar/);
    assert.equal(await page.locator('[name="full_name"]').inputValue(), synthetic.full_name);
    assert.equal(await page.locator("#send-request").isEnabled(), true);
    assert.equal(await page.locator("#send-status").isVisible(), false);
    assert.equal(rows.size, 0); assert.deepEqual(await opened(page), []);
  });
  await check("Reintenta el mismo UUID y espera confirmación antes de WhatsApp; doble envío bloqueado", async () => {
    const firstID = submitCalls()[0].args.payload.request_id;
    mode = "hold"; await page.locator("#send-request").click(); await waitHolding(page); await waitForHold();
    assert.equal(submitCalls()[1].args.payload.request_id, firstID);
    assert.deepEqual(await opened(page), []); assert.equal(rows.size, 0);
    assert.equal(await page.locator("#send-request").isDisabled(), true);
    assert.equal(await page.locator('[name="full_name"]').isDisabled(), true);
    await page.locator("#request-form").evaluate(form => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(submitCalls().length, 2);
    releaseHold(); await waitIdle(page); await page.waitForFunction(() => window.__opened.length === 1);
    assert.equal(rows.size, 1); assert.match(await page.locator("#send-status").textContent(), /se recibió para evaluación/);
    const events = await page.evaluate(() => window.__uiEvents);
    const ack = events.findIndex(item => item.action === "cloud-complete" && item.method === "submit");
    const whatsapp = events.findIndex(item => item.action === "whatsapp");
    assert.ok(ack >= 0 && whatsapp > ack);
    const target = new URL((await opened(page))[0]); assert.equal(target.hostname, "wa.me");
    assert.equal(target.pathname, "/5493544617342");
    assert.match(target.searchParams.get("text"), /Cliente Sintético de Prueba/);
    const count = submitCalls().length; await page.locator("#send-request").click(); await waitIdle(page);
    assert.equal(submitCalls().length, count, "Confirmed receipt must be reused without another submit");
  });
  const firstID = [...rows.keys()][0];
  let secondID, thirdID;
  await check("Recibo de otro UUID no muestra éxito; reintento conserva identidad y datos editados usan UUID nuevo", async () => {
    await page.locator('[name="address_number"]').fill("124"); mode = "wrong-receipt";
    const before = (await opened(page)).length; await page.locator("#send-request").click();
    await page.locator("#form-error").waitFor({ state: "visible" }); await waitIdle(page);
    secondID = submitCalls().at(-1).args.payload.request_id; assert.notEqual(secondID, firstID);
    assert.equal((await opened(page)).length, before); assert.equal(await page.locator("#send-status").isVisible(), false);
    mode = "success"; await page.locator("#send-request").click(); await waitIdle(page);
    assert.equal(submitCalls().at(-1).args.payload.request_id, secondID);
    assert.equal(rows.size, 2); assert.equal((await opened(page)).length, before + 1);
  });
  await check("Copiar también espera la recepción privada; datos públicos permanecen fuera del almacenamiento", async () => {
    await page.locator('[name="address_number"]').fill("125"); mode = "hold";
    await page.locator("#copy-request").click(); await waitHolding(page); await waitForHold();
    thirdID = submitCalls().at(-1).args.payload.request_id;
    assert.equal(await page.evaluate(() => window.__clipboard), null); releaseHold(); await waitIdle(page);
    assert.match(await page.evaluate(() => window.__clipboard), /Solicitud de préstamo/);
    assert.match(await page.locator("#send-status").textContent(), /se recibió para evaluación/);
    const storage = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
      databases: (await indexedDB.databases()).map(value => value.name) }));
    assert.deepEqual(storage, { local: 0, session: 0, databases: [] });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
  });
  await page.close(); return { firstID, secondID, thirdID };
}
async function privateChecks({ firstID, secondID, thirdID }) {
  const page = await openPage(privateUrl); await unlock(page, true); await navigateRequests(page);
  await check("Bandeja privada exige cuenta autorizada y limpia la contraseña al iniciar sesión", async () => {
    await login(page, false); assert.equal(await page.locator("#requests-password").inputValue(), "");
    assert.equal(await page.locator("#requests-list article").count(), 0);
    await login(page); assert.equal(await page.locator("#requests-list article").count(), 3);
    assert.equal(await page.locator("#requests-email").inputValue(), "");
    assert.equal(await page.locator("#requests-password").inputValue(), "");
  });
  await check("Revisión muestra seis cuotas; aprobar importa exactamente un préstamo con pagaré pendiente", async () => {
    await card(page, firstID).locator('[data-requests-action="review"]').click();
    assert.equal(await page.locator("#requests-modal tbody tr").count(), 6);
    assert.match(await page.locator("#requests-modal").textContent(), /1\.404\.000/);
    assert.equal(await page.locator("#requests-approve").isDisabled(), true);
    await page.locator("#requests-approve-check").check(); await page.locator("#requests-approve").click();
    await page.locator("#requests-modal").waitFor({ state: "hidden" });
    const loans = (await privateApi(page, "/loans")).loans; assert.equal(loans.length, 1);
    assert.equal(loans[0].request_id, firstID); assert.equal(loans[0].pricing_mode, "request_total");
    assert.equal(loans[0].total_cents, 140400000); assert.equal(loans[0].note.signed, false);
    assert.equal(rows.get(firstID).status, "approved");
    await page.locator("#requests-filter").selectOption("approved");
    assert.match(await card(page, firstID).textContent(), /Incorporada a tu cartera/);
  });
  await check("Detalle y pagaré conservan tasa total 40%, costo $404.000 y seis cuotas de $234.000", async () => {
    const loan = (await privateApi(page, "/loans")).loans[0];
    await page.locator('.main-nav [data-view="loans"]').click();
    const row = page.locator("#loans-body tr").filter({ hasText: loan.number });
    assert.match(await row.textContent(), /40% total sobre el capital/);
    assert.doesNotMatch(await row.textContent(), /\b0% mensual/);
    await row.locator('[data-action="view-loan"]').first().click();
    await page.locator(".loan-detail").waitFor();
    const detail = await page.locator(".loan-detail").textContent();
    assert.match(detail, /Tasa base total/); assert.match(detail, /40% total sobre el capital/);
    assert.match(detail, /Costo del préstamo\s*\$\s*404\.000/);
    assert.doesNotMatch(detail, /\b0% mensual/);
    const schedule = page.locator(".loan-detail .schedule-table tbody tr");
    assert.equal(await schedule.count(), 6);
    for (const installment of await schedule.all()) assert.match(await installment.textContent(), /234\.000/);
    await page.locator(`[data-action="print-note"][data-id="${loan.id}"]`).click();
    await page.locator(".promissory-note").waitFor();
    const note = await page.locator(".promissory-note").textContent();
    assert.match(note, /40% total sobre el capital/); assert.match(note, /Costo del préstamo\s*\$\s*404\.000/);
    assert.match(note, /1\.404\.000/); assert.doesNotMatch(note, /\b0% mensual/);
    assert.equal(await page.locator(".promissory-note tbody tr").count(), 6);
    await page.locator('[data-action="print-document"]').click();
    await page.waitForFunction(() => window.__printCount > 0);
    const frameText = await page.locator('iframe[title="Imprimir documento"]').contentFrame().locator("body").textContent();
    assert.match(frameText, /40% total sobre el capital/); assert.match(frameText, /1\.404\.000/);
    await page.locator('#modal [data-action="view-loan"]').click();
    await page.locator(".loan-detail").waitFor();
    await page.locator('#modal [data-action="close-modal"]').first().click();
    await navigateRequests(page);
  });
  await check("Rechazar exige confirmación y no crea préstamo ni modifica los ya incorporados", async () => {
    await page.locator("#requests-filter").selectOption("pending");
    await card(page, secondID).locator('[data-requests-action="review"]').click();
    await page.locator('[data-requests-action="confirm-reject"]').click();
    assert.equal(rows.get(secondID).status, "pending");
    await page.locator("#requests-reject-confirm").click(); await page.locator("#requests-modal").waitFor({ state: "hidden" });
    assert.equal(rows.get(secondID).status, "rejected"); assert.equal((await privateApi(page, "/loans")).loans.length, 1);
    await page.locator("#requests-filter").selectOption("rejected"); assert.match(await card(page, secondID).textContent(), /Rechazada/);
  });
  await check("Aprobación remota con disco local fallido queda recuperable; reintentar no vuelve a aprobar", async () => {
    await page.evaluate(() => { window.__originalIDBPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException("Synthetic disk full", "QuotaExceededError"); }; });
    try { await approve(page, thirdID); }
    finally { await page.evaluate(() => { IDBObjectStore.prototype.put = window.__originalIDBPut; delete window.__originalIDBPut; }); }
    assert.equal(rows.get(thirdID).status, "approved"); assert.equal((await privateApi(page, "/loans")).loans.length, 1);
    await page.locator("#requests-error").waitFor({ state: "visible" });
    await page.locator("#requests-filter").selectOption("import"); await card(page, thirdID).locator(".requests-import-error").waitFor();
    const approvals = calls.filter(call => call.action === "approveRequest" && call.args.id === thirdID).length;
    await card(page, thirdID).locator('[data-requests-action="retry-import"]').click();
    await page.waitForFunction(async () => (await NicolasStore.request("/loans")).loans.length === 2);
    await page.locator("#requests-filter").selectOption("approved");
    assert.match(await card(page, thirdID).textContent(), /Incorporada a tu cartera/);
    assert.equal(calls.filter(call => call.action === "approveRequest" && call.args.id === thirdID).length, approvals);
  });
  let recoveryID;
  await check("Al reabrir y actualizar recupera una aprobación remota y deduplica las anteriores", async () => {
    recoveryID = randomUUID(); const original = rows.get(firstID);
    const recovered = clone(original); recovered.id = recoveryID;
    recovered.approved_payload.request_id = recoveryID; recovered.approved_payload.customer.address_number = "126";
    rows.set(recoveryID, recovered);
    await page.reload(); await unlock(page); await navigateRequests(page); await login(page);
    const loans = (await privateApi(page, "/loans")).loans;
    assert.equal(loans.length, 3); assert.equal(loans.filter(loan => loan.request_id === firstID).length, 1);
    assert.equal(loans.filter(loan => loan.request_id === thirdID).length, 1);
    assert.equal(loans.filter(loan => loan.request_id === recoveryID).length, 1);
    await page.locator("#requests-filter").selectOption("approved");
    assert.match(await card(page, recoveryID).textContent(), /Incorporada a tu cartera/);
  });
  let xssID;
  await check("Nombres no confiables se muestran como texto y revisión/bandeja caben en móvil", async () => {
    xssID = randomUUID(); const row = clone(rows.get(secondID)); row.id = xssID; row.status = "pending";
    row.customer.full_name = '<img src=x onerror="window.__xss=1"> Persona Sintética'; row.customer.cuil = "27999999994";
    row.approved_payload = null; rows.set(xssID, row);
    await page.locator("#requests-sync").click(); await page.waitForFunction(() => !document.getElementById("requests-sync").disabled);
    await page.locator("#requests-filter").selectOption("pending");
    assert.ok((await card(page, xssID).textContent()).includes("<img")); assert.equal(await card(page, xssID).locator("img").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await card(page, xssID).locator('[data-requests-action="review"]').click();
    assert.equal(await page.locator("#requests-modal img").count(), 0); assert.equal(await page.evaluate(() => window.__xss), 0);
    await noOverflow(page);
    await page.locator('#requests-modal [data-requests-action="close-dialog"]').first().click();
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check("Bloquear cierra revisión, limpia PII/credenciales y exige reconectar la bandeja", async () => {
    await card(page, xssID).locator('[data-requests-action="review"]').click();
    // The private header sits behind a modal; call its existing action via DOM
    // exactly as a session timeout/keyboard lock can occur during a review.
    await page.locator('[data-private-action="lock"]').evaluate(button => button.click());
    await page.locator("#privacy-gate").waitFor({ state: "visible" });
    assert.equal(await page.locator("#requests-modal").isVisible(), false);
    assert.equal(await page.locator("#requests-list").textContent(), "");
    assert.equal(await page.locator("#requests-password").inputValue(), "");
    assert.equal(await page.locator("#requests-email").inputValue(), "");
    assert.ok(!(await page.locator("body").textContent()).includes(synthetic.full_name));
    await unlock(page); await navigateRequests(page);
    await page.locator("#requests-login-panel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#requests-list article").count(), 0);
    assert.equal((await privateApi(page, "/loans")).loans.length, 3);
  });
  await check("Login tardío tras bloquear/desbloquear no revive sesión ni deja el formulario ocupado", async () => {
    holdLogin = true;
    await page.locator("#requests-auth-password").click();
    await page.locator("#requests-email").fill(credentials.email);
    await page.locator("#requests-password").fill(credentials.password);
    await page.locator("#requests-login-submit").click();
    for (let attempt = 0; attempt < 100 && !releaseLogin; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof releaseLogin, "function");
    assert.equal(await page.locator("#requests-login-submit").isDisabled(), true);
    await page.locator('[data-private-action="lock"]').click();
    await page.locator("#privacy-gate").waitFor({ state: "visible" });
    await unlock(page); await navigateRequests(page);
    assert.equal(await page.locator("#requests-login-submit").isEnabled(), true);
    assert.equal(await page.locator("#requests-login-submit").textContent(), "Entrar a la bandeja");
    const completions = await page.evaluate(() => window.__uiEvents.filter(event => event.action === "cloud-complete" && event.method === "signIn").length);
    holdLogin = false; const complete = releaseLogin; releaseLogin = null; complete();
    await page.waitForFunction(count => window.__uiEvents.filter(event => event.action === "cloud-complete" && event.method === "signIn").length > count, completions);
    assert.equal(await page.locator("#requests-connected").isVisible(), false);
    assert.equal(await page.locator("#requests-list article").count(), 0);
    assert.equal(await page.locator("#requests-password").inputValue(), "");
    await login(page); assert.equal((await privateApi(page, "/loans")).loans.length, 3);
  });
  await page.close();
}
async function disabledCheck() {
  await check("Entrega sin configurar muestra conexión pendiente y nunca simula solicitudes recibidas", async () => {
    const isolated = await browser.newContext({ viewport: { width: 390, height: 844 } }); await trackContext(isolated);
    try {
      const page = await openPage(privateUrl, isolated); await unlock(page, true); await navigateRequests(page);
      await page.locator("#requests-unconfigured").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => NicolasCloud.configured), false);
      assert.equal(await page.locator("#requests-login-submit").isDisabled(), true);
      assert.equal(await page.locator("#requests-connected").isVisible(), false);
      await noOverflow(page); assert.equal((await privateApi(page, "/loans")).loans.length, 0);
    } finally { await isolated.close(); }
  });
}
async function main() {
  await prepare(); const ids = await publicChecks(); await privateChecks(ids); await disabledCheck();
  assert.deepEqual(network, []); assert.deepEqual(errors, []);
  console.log(`\n${checks} comprobaciones de interfaz pública/privada correctas. Cero red o mensajes reales.`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (release) releaseHold(); if (releaseLogin) releaseLogin(); if (browser) await browser.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
