/* Developer verification only. The customer page needs just a web browser.
 * CHROMIUM_PATH=/path/to/chrome node tests/client_request_smoke.cjs delivery.zip
 * Copies/extracts the HTML to /tmp, also serves it as a static local HTTP file.
 * WhatsApp and clipboard are intercepted; no message is sent or external site visited.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const source = path.resolve(process.argv[2] || "/workspace/nicolas/entrega/PRESTAMOS.html");
const owner = "5493544617342";
const fixedTime = "2026-10-21T15:00:00.000Z";
const fake = { full_name: "Cliente Sintético de Prueba", cuil: "20-00000000-1", address_street: "Calle de Prueba",
  address_number: "123", locality: "Localidad de Prueba", client_whatsapp: "+54 9 11 0000 0001", principal: "200000", term_months: "2" };
let directory, context, server, staticUrl, fileUrl, checks = 0;
const errors = [], external = [], extraResources = [];
function isStaticDocument(value) {
  if (!staticUrl) return false;
  try { const target = new URL(value), expected = new URL(staticUrl); return target.origin === expected.origin && target.pathname === expected.pathname; }
  catch (_) { return false; }
}
async function check(label, operation) {
  assert.deepEqual(errors, [], "JavaScript errors before a check"); await operation();
  assert.deepEqual(errors, [], `JavaScript error: ${label}`); console.log(`✓ ${label}`); checks++;
}
async function findHtml(root) {
  const results = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) results.push(...await findHtml(path.join(root, entry.name)));
    else if (/\.html$/i.test(entry.name)) results.push(path.join(root, entry.name));
  }
  return results;
}
async function prepare() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nicolas-request-test-")); let html;
  if (/\.zip$/i.test(source)) {
    const extracted = path.join(directory, "ZIP solicitud extraído"); execFileSync("unzip", ["-q", source, "-d", extracted]);
    const files = await findHtml(extracted); assert.equal(files.length, 1, "Customer ZIP must contain one HTML only"); html = files[0];
    const names = execFileSync("unzip", ["-Z1", source], { encoding: "utf8" }).trim().split(/\r?\n/).sort();
    assert.deepEqual(names, ["LEEME-SOLICITUD.txt", "PRESTAMOS.html"]);
  } else { html = path.join(directory, "PRESTAMOS.html"); await fs.copyFile(source, html); }
  const contents = await fs.readFile(html); fileUrl = pathToFileURL(html).href;
  server = http.createServer((request, response) => {
    if (new URL(request.url, "http://127.0.0.1").pathname !== "/PRESTAMOS.html") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(contents);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  staticUrl = `http://127.0.0.1:${server.address().port}/PRESTAMOS.html`;
  context = await chromium.launchPersistentContext(path.join(directory, "profile"), { executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  context.on("request", request => {
    const hostedDocument = isStaticDocument(request.url()) && request.isNavigationRequest() && request.resourceType() === "document";
    if (/^(?:https?|wss?):/.test(request.url()) && !hostedDocument) external.push(request.url());
    if (!hostedDocument && request.url() !== fileUrl && !/^(?:data:|blob:|about:)/.test(request.url())) extraResources.push(request.url());
  });
  await context.route(/^https?:/, route => isStaticDocument(route.request().url()) ? route.continue() : route.abort("internetdisconnected"));
  const track = page => page.on("pageerror", error => errors.push(error.stack || String(error)));
  context.pages().forEach(track); context.on("page", track);
  await context.addInitScript(() => {
    window.__requestTargets = []; window.__openCalls = []; window.__copiedRequest = null; window.__denyClipboard = false; window.__popupMode = "normal";
    window.__nativeShares = [];
    window.open = (url, target, features) => {
      window.__requestTargets.push(String(url)); window.__openCalls.push({ url: String(url), target, features });
      if (window.__popupMode === "throw") throw new Error("Popup opening failed in this test");
      if (window.__popupMode === "null") return null;
      return { closed: false, opener: null, focus() {} };
    };
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => {
      if (window.__denyClipboard) throw new DOMException("Clipboard is blocked for this test", "NotAllowedError"); window.__copiedRequest = String(text);
    } } });
  });
}
async function openPage(target, time = fixedTime) {
  const page = await context.newPage(); await page.clock.setFixedTime(new Date(time)); await page.goto(target);
  await page.waitForFunction(() => window.LoanRequestCore && document.getElementById("request-form")); return page;
}
async function core(page, method, argument) { return page.evaluate(({ method, argument }) => LoanRequestCore[method](argument), { method, argument }); }
async function noOverflow(page) {
  const result = await page.evaluate(() => ({ width: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(result.doc <= result.width && result.body <= result.width, JSON.stringify(result));
}
async function storageIsEmpty(page) {
  const result = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length,
    databases: (await indexedDB.databases()).map(database => database.name), search: location.search, hash: location.hash }));
  assert.deepEqual(result, { local: 0, session: 0, databases: [], search: "", hash: "" });
}
async function fillValid(page) {
  for (const [name, value] of Object.entries(fake)) {
    const field = page.locator(`[name="${name}"]`);
    if (await field.evaluate(element => element.tagName === "SELECT")) await field.selectOption(value); else await field.fill(value);
  }
  await page.locator('[name="contact_consent"]').check();
}
async function targetCount(page) { return page.evaluate(() => window.__requestTargets.length); }
async function attemptedSend(page) {
  const button = page.locator("#send-request");
  if (await button.isEnabled()) await button.click(); else await page.locator("#request-form").evaluate(form => form.requestSubmit());
}
function decodeTarget(value) {
  const target = new URL(value); assert.equal(target.protocol, "https:"); assert.equal(target.hostname, "wa.me");
  assert.equal(target.pathname, `/${owner}`); const text = target.searchParams.get("text"); assert.ok(text); return text;
}
function assertCompactRequest(text, { amount = "200.000", repayment = "270.000", months = 2, installment = "135.000" } = {}) {
  assert.match(text, /^Solicitud de pr[eé]stamo\b/i);
  const lines = text.trim().split(/\r?\n/).filter(line => line.trim());
  assert.equal(lines.length, 10, "Request contains title, personal data, requested amount, repayment, equal installments and first estimated due date only");
  for (const value of [fake.full_name, fake.address_street, fake.address_number, fake.locality]) assert.ok(text.includes(value), value);
  assert.ok(text.replace(/\D/g, "").includes("20000000001")); assert.ok(text.replace(/\D/g, "").includes("5491100000001"));
  const amountIndex = lines.findIndex(line => /^Monto solicitado:/i.test(line));
  assert.ok(amountIndex > 0); assert.ok(lines[amountIndex].includes(amount));
  assert.match(lines[amountIndex + 1], /^Monto a devolver:/i);
  assert.ok(lines[amountIndex + 1].includes(repayment));
  const schedule = lines.find(line => /^Cuotas?:/i.test(line)); assert.ok(schedule, "Monthly payment summary is present");
  assert.match(schedule, new RegExp(`${months}\\s+cuota${months === 1 ? "\\b" : "s"}`));
  if (months > 1) assert.match(schedule, /mensual(?:es)?/i);
  assert.doesNotMatch(schedule, /[uú]ltima/i);
  assert.ok(schedule.includes(installment));
  assert.match(text, /Primera cuota estimada:\s*21\/11\/2026/i);
  for (const line of lines.slice(1)) assert.match(line, /^(Nombre y apellido|CUIL|Domicilio|Localidad\s*\/\s*Ciudad|WhatsApp|Monto solicitado|Monto a devolver|Cuotas?|Primera cuota estimada):/i);
  assert.doesNotMatch(text, /simulaci[oó]n|inter[eé]s|tasa|plazo|consent|recordatori|\d\s*%/i);
}
function assertRoundedSchedule(value, { principal, months, rate, interest }) {
  const unit = 100000, installment = value.regular_installment_cents, base = principal + interest;
  assert.equal(value.principal_cents, principal); assert.equal(value.interest_percent, rate); assert.equal(value.interest_cents, interest);
  assert.equal(value.base_total_cents, base); assert.equal(value.installments.length, months);
  assert.ok(Number.isSafeInteger(installment) && installment > 0); assert.equal(installment % unit, 0);
  assert.equal(value.last_installment_cents, installment);
  assert.ok(value.installments.every(item => item.amount_cents === installment), "All installments, including the last, must be equal");
  assert.equal(value.total_cents, installment * months); assert.equal(value.installments.reduce((sum, item) => sum + item.amount_cents, 0), value.total_cents);
  assert.equal(value.rounding_adjustment_cents, value.total_cents - base);
  assert.ok(value.total_cents >= base, "Rounded installments must cover the base total");
  assert.ok(value.total_cents - unit * months < base, "Choosing the previous $1,000 installment must fail to cover the base total");
}
async function main() {
  await prepare(); const page = await openPage(fileUrl);
  await brandChecks(page); await layoutChecks(page); await mathChecks(page); await validationChecks(page); await formChecks(page);
  await whatsappRecoveryChecks(page); await offlineShareCheck(page); await reminderChecks(page); await privacyChecks(page);
  await monthEndChecks(); await staticHttpChecks(); await hostedShareChecks();
  await check("Todo el recorrido evita visitas externas y no produce errores JavaScript", async () => { assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(extraResources, []); });
  console.log(`\n${checks} comprobaciones de solicitud correctas; ningún WhatsApp real enviado.`);
}
async function layoutChecks(page) {
  await check("El ejemplo se muestra alineado en escritorio y en móvil, sin rotación", async () => {
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.locator(".example-card").evaluate(element => getComputedStyle(element).transform), "none");
      await noOverflow(page);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check("En móvil el importe y las cuotas aparecen antes de pedir los datos personales", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const tops = await page.evaluate(() => ({
      loan: document.getElementById("loan-title").closest("section").getBoundingClientRect().top,
      quote: document.getElementById("quote-title").closest("section").getBoundingClientRect().top,
      personal: document.getElementById("personal-title").closest("section").getBoundingClientRect().top,
    }));
    assert.ok(tops.loan < tops.quote && tops.quote < tops.personal, JSON.stringify(tops));
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
}
async function brandChecks(page) {
  await check("La página se presenta como Préstamos, sin nombres anteriores ni marcas de IA", async () => {
    assert.match(await page.title(), /pr[eé]stamos/i);
    assert.match(await page.locator(".brand-name").textContent(), /pr[eé]stamos/i);
    assert.match(await page.locator(".footer-brand").textContent(), /pr[eé]stamos/i);
    const facing = await page.evaluate(() => [document.title, document.body.innerText,
      document.querySelector('meta[name="description"]')?.content || "",
      ...[...document.querySelectorAll("[aria-label]")].map(element => element.getAttribute("aria-label"))].join("\n"));
    assert.doesNotMatch(facing, /nicol[aá]s|chatgpt|openai/i);
  });
}
async function mathChecks(page) {
  await check("$200.000 en dos meses: interés total $70.000, total $270.000 y cuotas $135.000", async () => {
    const value = await core(page, "calculate", { principal_cents: 20000000, term_months: 2, first_due_date: "2026-11-21" });
    assert.equal(value.interest_percent, 35); assert.equal(value.interest_cents, 7000000); assert.equal(value.total_cents, 27000000);
    assert.deepEqual(value.installments.map(item => item.amount_cents), [13500000, 13500000]);
  });
  await check("La base usa 35% hasta tres meses y 40% desde cuatro; las cuotas iguales se redondean hacia arriba a $1.000", async () => {
    for (const months of [1, 2, 3, 4, 5, 24]) {
      const value = await core(page, "calculate", { principal_cents: 20000000, term_months: months, first_due_date: "2026-11-21" });
      const rate = months <= 3 ? 35 : 40, interest = months <= 3 ? 7000000 : 8000000;
      assertRoundedSchedule(value, { principal: 20000000, months, rate, interest });
    }
    const three = await core(page, "calculate", { principal_cents: 20000000, term_months: 3, first_due_date: "2026-11-21" });
    assert.deepEqual(three.installments.map(item => item.amount_cents), [9000000, 9000000, 9000000]);
    const four = await core(page, "calculate", { principal_cents: 20000000, term_months: 4, first_due_date: "2026-11-21" });
    assert.deepEqual(four.installments.map(item => item.amount_cents), [7000000, 7000000, 7000000, 7000000]);
    const five = await core(page, "calculate", { principal_cents: 50000000, term_months: 5, first_due_date: "2026-11-21" });
    assert.equal(five.interest_cents, 20000000); assert.equal(five.total_cents, 70000000);
    assert.deepEqual(five.installments.map(item => item.amount_cents), [14000000, 14000000, 14000000, 14000000, 14000000]);
  });
  await check("El interés base redondea medio centavo hacia arriba; incluso importes pequeños generan cuotas iguales de miles", async () => {
    for (const [principal, shortInterest, longInterest] of [[1, 0, 0], [2, 1, 1], [3, 1, 1], [10, 4, 4], [50, 18, 20], [101, 35, 40]]) {
      for (const months of [1, 2, 3, 4, 5, 24]) {
        const interest = months <= 3 ? shortInterest : longInterest;
        const value = await core(page, "calculate", { principal_cents: principal, term_months: months, first_due_date: "2026-11-21" });
        assertRoundedSchedule(value, { principal, months, rate: months <= 3 ? 35 : 40, interest });
        assert.equal(value.regular_installment_cents, 100000);
      }
    }
    assert.equal(await core(page, "parseMoney", "200000,50"), 20000050); assert.equal(await core(page, "parseMoney", "0.01"), 1);
  });
  await check("$1.000.000 en seis cuotas produce $234.000 por cuota, total $1.404.000 y ajuste visible de $4.000", async () => {
    const value = await core(page, "calculate", { principal_cents: 100000000, term_months: 6, first_due_date: "2026-11-21" });
    assertRoundedSchedule(value, { principal: 100000000, months: 6, rate: 40, interest: 40000000 });
    assert.equal(value.base_total_cents, 140000000); assert.equal(value.total_cents, 140400000);
    assert.equal(value.regular_installment_cents, 23400000); assert.equal(value.rounding_adjustment_cents, 400000);
  });
  await check("El redondeo de $100.000 en dos meses y $200.000 en 24 meses informa el ajuste separado de la base", async () => {
    const short = await core(page, "calculate", { principal_cents: 10000000, term_months: 2, first_due_date: "2026-11-21" });
    assertRoundedSchedule(short, { principal: 10000000, months: 2, rate: 35, interest: 3500000 });
    assert.equal(short.regular_installment_cents, 6800000); assert.equal(short.base_total_cents, 13500000);
    assert.equal(short.total_cents, 13600000); assert.equal(short.rounding_adjustment_cents, 100000);
    const long = await core(page, "calculate", { principal_cents: 20000000, term_months: 24, first_due_date: "2026-11-21" });
    assertRoundedSchedule(long, { principal: 20000000, months: 24, rate: 40, interest: 8000000 });
    assert.equal(long.regular_installment_cents, 1200000); assert.equal(long.total_cents, 28800000); assert.equal(long.rounding_adjustment_cents, 800000);
  });
  await check("Calendario conserva el día 31 y distingue un vencimiento personalizado", async () => {
    const value = await core(page, "calculate", { principal_cents: 10000, term_months: 3, first_due_date: "2027-02-28", due_anchor_day: 31 });
    assert.deepEqual(value.installments.map(item => item.due_date), ["2027-02-28", "2027-03-31", "2027-04-30"]);
    const custom = await core(page, "calculate", { principal_cents: 10000, term_months: 3, first_due_date: "2027-02-28" });
    assert.deepEqual(custom.installments.map(item => item.due_date), ["2027-02-28", "2027-03-28", "2027-04-28"]);
    const leap = await core(page, "calculate", { principal_cents: 10000, term_months: 2, first_due_date: "2028-02-29", due_anchor_day: 31 });
    assert.deepEqual(leap.installments.map(item => item.due_date), ["2028-02-29", "2028-03-31"]);
  });
  await check("Importes, plazos y fechas inválidos no producen un cálculo válido", async () => {
    const invalid = await page.evaluate(() => {
      const values = [{ principal_cents: 0 }, { principal_cents: true }, { principal_cents: 1.5 }, { principal_cents: 100000000001 }, { term_months: 0 }, { term_months: 25 }, { term_months: 1.5 }, { first_due_date: "2027-02-29" }];
      return values.map(override => { try { LoanRequestCore.calculate({ principal_cents: 10000, term_months: 2, first_due_date: "2026-11-21", ...override }); return false; } catch (_) { return true; } });
    }); assert.ok(invalid.every(Boolean));
  });
}
async function validationChecks(page) {
  await check("CUIL sintético válido verifica módulo 11; letras, prefijos y dígitos incorrectos se rechazan", async () => {
    for (const value of ["20-00000000-1", "27-00000000-6"]) { const result = await core(page, "validateCuil", value); assert.equal(result.valid, true); assert.equal(result.normalized, value.replaceAll("-", "")); }
    for (const value of ["20-00000000-2", "CUIL20-00000000-1", "30-00000000-5", "20-00000015-9", "2000000000", "200000000011"]) assert.equal((await core(page, "validateCuil", value)).valid, false, value);
  });
  await check("WhatsApp del cliente exige país explícito y conserva números internacionales", async () => {
    assert.equal((await core(page, "normalizePhone", fake.client_whatsapp)).international, "5491100000001");
    assert.equal((await core(page, "normalizePhone", "+598 99 000 001")).international, "59899000001");
    for (const value of ["1100000001", "0111500000001", "+54 9 110", "texto", "+000000000000"]) assert.equal((await core(page, "normalizePhone", value)).valid, false, value);
  });
}
async function formChecks(page) {
  await check("Formulario accesible: etiquetas asociadas, recordatorios activados y navegación por teclado", async () => {
    assert.equal(await page.locator('[name="remind_me"]').isChecked(), true);
    for (const name of [...Object.keys(fake), "first_due_date", "contact_consent", "remind_me"]) {
      assert.ok(await page.locator(`[name="${name}"]`).evaluate(element => element.labels?.length > 0), name);
    }
    await page.locator('[name="full_name"]').focus(); await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.name), "cuil");
    await storageIsEmpty(page);
  });
  await fillValid(page);
  await check("La calculadora visible muestra dos cuotas, capital, interés total y total a devolver", async () => {
    await page.waitForFunction(() => document.getElementById("calculator-result").textContent.includes("270.000"));
    const text = await page.locator("#calculator-result").textContent();
    assert.ok(text.includes("200.000")); assert.ok(text.includes("70.000")); assert.ok(text.includes("270.000"));
    assert.equal(await page.locator("#installments-body tr").count(), 2);
    for (const row of await page.locator("#installments-body tr").all()) assert.ok((await row.textContent()).includes("135.000"));
    await page.locator('[name="term_months"]').selectOption("3");
    await page.waitForFunction(() => document.getElementById("installments-body").children.length === 3);
    assert.match(await page.locator("#calculator-result").textContent(), /35\s?%/);
    assert.ok((await page.locator("#calculator-result").textContent()).includes("270.000"));
    await page.locator('[name="term_months"]').selectOption("4");
    await page.waitForFunction(() => document.getElementById("installments-body").children.length === 4);
    assert.match(await page.locator("#calculator-result").textContent(), /40\s?%/);
    assert.ok((await page.locator("#calculator-result").textContent()).includes("280.000"));
    for (const row of await page.locator("#installments-body tr").all()) assert.ok((await row.textContent()).includes("70.000"));
    await page.locator('[name="term_months"]').selectOption("2");
  });
  await check("Los importes rápidos actualizan cuotas y selección sin abrir ni enviar WhatsApp", async () => {
    const before = await targetCount(page), copied = await page.evaluate(() => window.__copiedRequest);
    await page.evaluate(() => {
      window.__presetInputEvents = 0;
      document.querySelector('[name="principal"]').addEventListener("input", () => window.__presetInputEvents++);
    });
    for (const [amount, payment] of [["100000", "68.000"], ["200000", "135.000"], ["500000", "338.000"]]) {
      const button = page.locator(`[data-loan-amount="${amount}"]`);
      assert.equal(await button.getAttribute("type"), "button"); await button.click();
      assert.equal(await page.locator('[name="principal"]').inputValue(), amount);
      assert.ok((await page.locator(".installment-highlight").textContent()).includes(payment));
      assert.match(await page.locator(".installment-highlight").textContent(), /2\s+cuotas/i);
      for (const preset of await page.locator("[data-loan-amount]").all()) {
        assert.equal(await preset.getAttribute("aria-pressed"), (await preset.getAttribute("data-loan-amount")) === amount ? "true" : "false");
      }
      assert.equal(await targetCount(page), before);
    }
    assert.ok(await page.evaluate(() => window.__presetInputEvents >= 3), "Preset changes must dispatch input events");
    await page.locator('[name="principal"]').fill("123456");
    assert.equal(await page.locator('[data-loan-amount][aria-pressed="true"]').count(), 0);
    await page.locator('[name="term_months"]').selectOption("5"); await page.locator('[data-loan-amount="500000"]').click();
    assert.equal(await page.locator("#installments-body tr").count(), 5);
    assert.ok((await page.locator(".installment-highlight").textContent()).includes("140.000"));
    assert.match(await page.locator(".installment-highlight").textContent(), /5\s+cuotas/i);
    assert.equal(await targetCount(page), before); assert.equal(await page.evaluate(() => window.__copiedRequest), copied);
    await page.locator('[name="term_months"]').selectOption("2"); await page.locator('[data-loan-amount="200000"]').click();
  });
  await check("El formulario separa el interés base del ajuste y muestra las seis cuotas iguales de $234.000", async () => {
    const before = await targetCount(page);
    await page.locator('[name="principal"]').fill("1000000"); await page.locator('[name="term_months"]').selectOption("6");
    await page.waitForFunction(() => document.getElementById("installments-body").children.length === 6);
    const summary = await page.locator("#calculator-result").textContent();
    assert.match(summary, /inter[eé]s\s+base/i); assert.match(summary, /ajuste\s+por\s+redondeo/i);
    assert.ok(summary.includes("400.000")); assert.ok(summary.includes("4.000")); assert.ok(summary.includes("1.404.000"));
    assert.match(await page.locator(".installment-highlight").textContent(), /6\s+cuotas\s+mensuales/i);
    for (const row of await page.locator("#installments-body tr").all()) assert.ok((await row.textContent()).includes("234.000"));
    assert.equal(await targetCount(page), before, "Changing the simulation must not open WhatsApp");
    await page.locator('[name="principal"]').fill("200000"); await page.locator('[name="term_months"]').selectOption("2");
  });
  await check("CUIL, domicilio, teléfono, capital, plazo, fecha y consentimiento inválidos impiden abrir WhatsApp", async () => {
    const firstDate = await page.locator('[name="first_due_date"]').inputValue(), before = await targetCount(page);
    const invalid = { full_name: " ", cuil: "20-00000000-2", address_street: " ", address_number: " ", locality: " ", client_whatsapp: "12345", principal: "0", term_months: "", first_due_date: "2026-10-20" };
    for (const [name, value] of Object.entries(invalid)) {
      const field = page.locator(`[name="${name}"]`), original = await field.inputValue();
      if (await field.evaluate(element => element.tagName === "SELECT")) await field.evaluate((element, value) => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); }, value);
      else await field.fill(value);
      await attemptedSend(page); assert.equal(await targetCount(page), before, name);
      if (await field.evaluate(element => element.tagName === "SELECT")) await field.selectOption(original); else await field.fill(original);
    }
    await page.locator('[name="first_due_date"]').fill(firstDate);
    await page.locator('[name="contact_consent"]').uncheck(); await attemptedSend(page); assert.equal(await targetCount(page), before);
    await page.locator('[name="contact_consent"]').check();
  });
  await check("Texto parecido a HTML permanece como texto y no ejecuta código ni carga recursos", async () => {
    const payload = '<img src="request-xss" onerror="window.__requestXss=1"> Cliente';
    await page.locator('[name="full_name"]').fill(payload);
    await page.locator("#copy-request").click();
    assert.equal(await page.evaluate(() => window.__requestXss), undefined);
    assert.equal(await page.locator('img[src="request-xss"]').count(), 0);
    assert.ok((await page.evaluate(() => window.__copiedRequest))?.includes(payload));
    await page.locator('[name="full_name"]').fill(fake.full_name);
  });
  await check("Continuar en WhatsApp prepara datos, monto solicitado, monto a devolver, cuotas iguales y primera fecha sin enviar automáticamente", async () => {
    const current = page.url(), before = await targetCount(page);
    assert.equal(await page.locator("#send-request").getAttribute("type"), "submit");
    assert.match(await page.locator("#send-request").textContent(), /Continuar en WhatsApp/i);
    await page.locator("#copy-request").click(); await page.waitForFunction(() => window.__copiedRequest);
    const copied = await page.evaluate(() => window.__copiedRequest);
    await page.locator("#send-request").click(); assert.equal(await targetCount(page), before + 1);
    const text = decodeTarget(await page.evaluate(() => window.__requestTargets.at(-1)));
    assert.equal(text, copied, "Copied request and WhatsApp request must agree exactly");
    assertCompactRequest(text); assert.equal(page.url(), current);
    const status = await page.locator("#send-status").textContent(); assert.match(status, /WhatsApp/i); assert.match(status, /revis|toc[aá]|enviar/i);
    assert.doesNotMatch(status, /solicitud enviada|mensaje enviado|enviad[oa] con [eé]xito/i);
  });
  await check("Copiar sin permisos del portapapeles ofrece el texto completo para copia manual", async () => {
    await page.evaluate(() => { window.__denyClipboard = true; });
    await page.locator("#copy-request").click(); await page.locator("#copy-fallback-text").waitFor({ state: "visible" });
    const expected = decodeTarget(await page.evaluate(() => window.__requestTargets.at(-1)));
    assertCompactRequest(expected);
    assert.equal(await page.locator("#copy-fallback-text").inputValue(), expected);
    assert.equal(await page.locator("#copy-fallback-text").getAttribute("readonly"), "");
    await page.evaluate(() => { window.__denyClipboard = false; });
    assert.doesNotMatch(await page.locator("#send-status").textContent(), /solicitud enviada|mensaje enviado/i);
  });
  await check("WhatsApp informa el total a devolver y todas las cuotas mensuales iguales, incluso cuando hay ajuste por redondeo", async () => {
    for (const fixture of [
      { principal: "500000", months: "5", amount: "500.000", repayment: "700.000", installment: "140.000" },
      { principal: "200000", months: "1", amount: "200.000", repayment: "270.000", installment: "270.000" },
      { principal: "200000", months: "24", amount: "200.000", repayment: "288.000", installment: "12.000" },
      { principal: "1000000", months: "6", amount: "1.000.000", repayment: "1.404.000", installment: "234.000" },
      { principal: "0.50", months: "3", amount: "0,50", repayment: "3.000", installment: "1.000" },
    ]) {
      await page.locator('[name="principal"]').fill(fixture.principal); await page.locator('[name="term_months"]').selectOption(fixture.months);
      const before = await targetCount(page); await page.locator("#send-request").click(); assert.equal(await targetCount(page), before + 1);
      assertCompactRequest(decodeTarget(await page.evaluate(() => window.__requestTargets.at(-1))), {
        amount: fixture.amount, repayment: fixture.repayment, months: Number(fixture.months), installment: fixture.installment,
      });
    }
    await fillValid(page);
  });
}
async function whatsappRecoveryChecks(page) {
  await check("Consultas de cabecera y pie abren un mensaje genérico sin datos del formulario", async () => {
    for (const section of ["header", "footer"]) {
      const links = page.locator(`${section} a[href^="https://wa.me/"]`); assert.ok(await links.count() >= 1, section);
      for (const link of await links.all()) {
        const message = decodeTarget(await link.getAttribute("href"));
        assert.match(message, /consulta|pregunt|informaci[oó]n/i);
        for (const value of [fake.full_name, fake.cuil, fake.address_street, fake.locality, "20000000001", "5491100000001"]) assert.ok(!message.includes(value), value);
        assert.equal(await link.evaluate(element => element.closest("form") === null), true);
        assert.equal(await link.getAttribute("target"), "_blank"); assert.match(await link.getAttribute("rel"), /noopener/);
      }
    }
  });
  for (const mode of ["throw", "null"]) {
    await check(`WhatsApp ${mode === "throw" ? "con apertura bloqueada" : "con retorno nulo"} conserva un enlace para reintentar manualmente`, async () => {
      await fillValid(page); await page.evaluate(mode => { window.__popupMode = mode; }, mode);
      const previous = await targetCount(page); await page.locator("#send-request").click(); assert.equal(await targetCount(page), previous + 1);
      await page.locator("#whatsapp-actions").waitFor({ state: "visible" });
      const latest = await page.evaluate(() => window.__requestTargets.at(-1)); assert.equal(await page.locator("#reopen-whatsapp").getAttribute("href"), latest);
      const message = decodeTarget(latest); assertCompactRequest(message);
      const call = await page.evaluate(() => window.__openCalls.at(-1)); assert.equal(call.target, "_blank"); assert.match(call.features, /noopener/); assert.match(call.features, /noreferrer/);
      const status = await page.locator("#send-status").textContent(); assert.match(status, /WhatsApp/i); assert.match(status, /enviar|revis|abrir|toc[aá]/i);
      assert.doesNotMatch(status, /solicitud enviada|mensaje enviado|enviad[oa] con [eé]xito/i);
      await page.locator('[name="full_name"]').fill("Nombre cambiado tras preparar la solicitud");
      assert.equal(await page.locator("#whatsapp-actions").isVisible(), false);
      assert.equal(await page.locator("#reopen-whatsapp").getAttribute("href"), null, "An old link must not retain personal data after editing");
      await page.locator('[name="full_name"]').fill(fake.full_name);
    });
  }
  await page.evaluate(() => { window.__popupMode = "normal"; });
  await check("Editar cualquier campo invalida el enlace de solicitud anterior", async () => {
    const edits = { full_name: "Otro nombre de prueba", cuil: "27-00000000-6", address_street: "Otra calle de prueba",
      address_number: "124", locality: "Otra localidad", client_whatsapp: "+54 9 11 0000 0002", principal: "210000", term_months: "3", first_due_date: "2026-11-22",
      contact_consent: false, remind_me: false };
    for (const [name, value] of Object.entries(edits)) {
      await fillValid(page); await page.locator("#send-request").click(); await page.locator("#whatsapp-actions").waitFor({ state: "visible" });
      const field = page.locator(`[name="${name}"]`), kind = await field.evaluate(element => element.type), original = kind === "checkbox" ? await field.isChecked() : await field.inputValue();
      if (kind === "checkbox") await field.setChecked(value);
      else if (kind === "select-one") await field.selectOption(value); else await field.fill(value);
      assert.equal(await page.locator("#whatsapp-actions").isVisible(), false, name);
      assert.equal(await page.locator("#reopen-whatsapp").getAttribute("href"), null, name);
      if (kind === "checkbox") await field.setChecked(original);
      else if (kind === "select-one") await field.selectOption(original); else await field.fill(original);
      assert.equal(await page.locator("#whatsapp-actions").isVisible(), false, `${name}: restoring a field does not restore the old link`);
    }
    await storageIsEmpty(page);
  });
}
async function offlineShareCheck(page) {
  await check("Compartir un archivo local explica cómo publicar y evita ofrecer un enlace falso", async () => {
    await page.evaluate(() => { window.__copiedRequest = null; }); const before = await targetCount(page);
    assert.equal(await page.locator("#share-page").evaluate(element => element.form === null), true);
    await page.locator("#share-page").click(); await page.locator("#share-status").waitFor({ state: "visible" });
    const status = await page.locator("#share-status").textContent(); assert.match(status, /PRESTAMOS\.html/); assert.match(status, /publicad|publicar|enlace/i);
    assert.doesNotMatch(status, /https?:\/\/|file:\/\//i);
    assert.equal(await page.evaluate(() => window.__copiedRequest), null); assert.equal(await targetCount(page), before);
    assert.equal(await page.locator("#share-url-fallback").isVisible(), false); await storageIsEmpty(page);
  });
}
async function reminderChecks(page) {
  await check("Calendario estimado descarga sin datos personales ni consentimiento de contacto", async () => {
    for (const name of ["full_name", "cuil", "address_street", "address_number", "locality", "client_whatsapp"]) await page.locator(`[name="${name}"]`).fill("");
    await page.locator('[name="contact_consent"]').uncheck(); const targets = await targetCount(page);
    const downloading = page.waitForEvent("download"); await page.locator("#download-reminders").click();
    const saved = path.join(directory, "recordatorios.ics"); await (await downloading).saveAs(saved); const ics = await fs.readFile(saved, "utf8");
    assert.ok(ics.includes("BEGIN:VCALENDAR")); const events = [...ics.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map(match => match[1]);
    assert.match(ics, /X-WR-CALNAME:.*Pr[eé]stamos/i); assert.doesNotMatch(ics, /nicol[aá]s|chatgpt|openai/i);
    assert.equal(events.length, 2);
    for (const [index, event] of events.entries()) {
      const day = index === 0 ? "20261121" : "20261221"; assert.match(event, new RegExp(`DTSTART:${day}T120000Z`));
      assert.equal((event.match(/BEGIN:VALARM/g) || []).length, 2); assert.match(event, /TRIGGER:-P1D/); assert.match(event, /TRIGGER:PT0[MS]/);
      assert.match(event, /STATUS:TENTATIVE/);
      assert.match(event, /estimad|aproba/i);
    }
    assert.ok(!ics.includes(fake.cuil)); assert.ok(!ics.includes(fake.full_name)); assert.equal(await targetCount(page), targets);
    assert.doesNotMatch(await page.locator("#send-status").textContent(), /solicitud enviada|mensaje enviado/i);
  });
  await check("Desactivar recordatorios bloquea la descarga sin alterar el envío de solicitud", async () => {
    await page.locator('[name="remind_me"]').uncheck(); let downloads = 0;
    const observe = () => downloads++; page.on("download", observe);
    await page.locator("#download-reminders").click();
    await page.waitForFunction(() => document.getElementById("send-status").textContent.length > 0);
    assert.equal(downloads, 0); page.off("download", observe); await page.locator('[name="remind_me"]').check();
  });
}
async function privacyChecks(page) {
  await check("Datos de solicitud permanecen solo en memoria y no aparecen en almacenamiento ni URL", async () => {
    await fillValid(page); await storageIsEmpty(page); assert.ok(!page.url().includes(fake.cuil)); assert.ok(!page.url().includes(fake.full_name));
    await page.reload(); await page.waitForFunction(() => window.LoanRequestCore);
    for (const name of ["full_name", "cuil", "address_street", "address_number", "locality", "client_whatsapp"]) assert.equal(await page.locator(`[name="${name}"]`).inputValue(), "", name);
    await storageIsEmpty(page); assert.equal(await targetCount(page), 0);
  });
}
async function monthEndChecks() {
  const page = await openPage(fileUrl, "2027-01-31T15:00:00.000Z");
  await check("Primer cobro automático desde 31 de enero conserva marzo 31; fecha manual usa día 28", async () => {
    await page.locator('[name="principal"]').fill("200000"); await page.locator('[name="term_months"]').selectOption("2");
    assert.equal(await page.locator('[name="first_due_date"]').inputValue(), "2027-02-28");
    await page.waitForFunction(() => document.getElementById("installments-body").children.length === 2);
    const automatic = await page.locator("#installments-body tr").last().textContent(); assert.match(automatic, /31/); assert.match(automatic, /2027/);
    await page.locator('[name="first_due_date"]').fill("2027-02-28");
    await page.locator('[name="first_due_date"]').dispatchEvent("change");
    const custom = await page.locator("#installments-body tr").last().textContent(); assert.match(custom, /28/); assert.notEqual(custom, automatic);
    await storageIsEmpty(page);
  });
  await page.close();
}
async function staticHttpChecks() {
  const page = await openPage(staticUrl);
  await check("La misma página funciona por HTTP estático en móvil de 390 píxeles", async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await fillValid(page); await noOverflow(page);
    await page.locator("#send-request").click(); assert.equal(await targetCount(page), 1); assertCompactRequest(decodeTarget(await page.evaluate(() => window.__requestTargets[0])));
    await noOverflow(page); await storageIsEmpty(page);
    assert.doesNotMatch(await page.locator("#send-status").textContent(), /solicitud enviada|mensaje enviado/i);
  });
  await page.close();
}
async function hostedShareChecks() {
  const contaminated = new URL(staticUrl); contaminated.searchParams.set("full_name", fake.full_name); contaminated.searchParams.set("cuil", fake.cuil); contaminated.hash = `whatsapp=${encodeURIComponent(fake.client_whatsapp)}`;
  const page = await openPage(contaminated.href); await fillValid(page);
  await check("Compartir la página publicada copia su URL limpia sin CUIL, teléfono ni otros datos", async () => {
    assert.equal(await page.locator("#share-page").evaluate(element => element.form === null), true);
    await page.locator("#share-page").click(); await page.waitForFunction(() => typeof window.__copiedRequest === "string");
    assert.equal(await page.evaluate(() => window.__copiedRequest), staticUrl);
    assert.equal(page.url(), contaminated.href, "Sharing must not navigate or submit the form");
    const data = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, databases: (await indexedDB.databases()).length }));
    assert.deepEqual(data, { local: 0, session: 0, databases: 0 });
    assert.equal(await targetCount(page), 0); assert.ok((await page.locator("#share-status").textContent()).length > 0);
  });
  await check("La hoja nativa para compartir recibe solo la URL pública y cancelar no copia datos", async () => {
    await page.evaluate(() => {
      window.__copiedRequest = null;
      Object.defineProperty(navigator, "share", { configurable: true, value: async data => { window.__nativeShares.push(data); } });
    });
    await page.locator("#share-page").click(); await page.waitForFunction(() => window.__nativeShares.length === 1);
    const shared = await page.evaluate(() => window.__nativeShares[0]); assert.equal(shared.url, staticUrl); assert.match(shared.title, /pr[eé]stamos/i);
    const serialized = JSON.stringify(shared);
    for (const value of [fake.full_name, fake.cuil, fake.client_whatsapp, fake.address_street]) assert.ok(!serialized.includes(value), value);
    assert.equal(await page.evaluate(() => window.__copiedRequest), null);
    await page.evaluate(() => { Object.defineProperty(navigator, "share", { configurable: true, value: async () => { throw new DOMException("User cancelled", "AbortError"); } }); });
    await page.locator("#share-page").click();
    // Yield through the same event loop, without a timed sleep, so the rejected
    // native-share promise and its catch handler finish before the assertions.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => window.__copiedRequest), null);
    assert.equal(await page.locator("#share-url-fallback").isVisible(), false);
  });
  await check("Si el portapapeles está bloqueado, compartir ofrece únicamente la URL pública para copiar", async () => {
    await page.evaluate(() => { Object.defineProperty(navigator, "share", { configurable: true, value: undefined }); window.__denyClipboard = true; });
    await page.locator("#share-page").click(); await page.locator("#share-url-fallback").waitFor({ state: "visible" });
    assert.equal(await page.locator("#share-url-fallback").inputValue(), staticUrl);
    assert.equal(await page.locator("#share-url-fallback").evaluate(element => element.readOnly), true);
    assert.equal(await targetCount(page), 0);
  });
  await page.close();
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close(); if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
