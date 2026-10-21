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
const source = path.resolve(process.argv[2] || "/workspace/nicolas/entrega/SOLICITAR-PRESTAMO.html");
const owner = "5493544617342";
const fixedTime = "2026-10-21T15:00:00.000Z";
const fake = { full_name: "Cliente Sintético de Prueba", cuil: "20-00000000-1", address_street: "Calle de Prueba",
  address_number: "123", locality: "Localidad de Prueba", client_whatsapp: "+54 9 11 0000 0001", principal: "200000", term_months: "2" };
let directory, context, server, staticUrl, fileUrl, checks = 0;
const errors = [], external = [], extraResources = [];
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
  } else { html = path.join(directory, "Solicitud préstamo cliente.html"); await fs.copyFile(source, html); }
  const contents = await fs.readFile(html); fileUrl = pathToFileURL(html).href;
  server = http.createServer((request, response) => {
    if (request.url !== "/solicitud.html") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(contents);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  staticUrl = `http://127.0.0.1:${server.address().port}/solicitud.html`;
  context = await chromium.launchPersistentContext(path.join(directory, "profile"), { executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  context.on("request", request => {
    if (/^(?:https?|wss?):/.test(request.url()) && request.url() !== staticUrl) external.push(request.url());
    if (request.url() !== staticUrl && request.url() !== fileUrl && !/^(?:data:|blob:|about:)/.test(request.url())) extraResources.push(request.url());
  });
  await context.route(/^https?:/, route => route.request().url() === staticUrl ? route.continue() : route.abort("internetdisconnected"));
  const track = page => page.on("pageerror", error => errors.push(error.stack || String(error)));
  context.pages().forEach(track); context.on("page", track);
  await context.addInitScript(() => {
    window.__requestTargets = []; window.__copiedRequest = null; window.__denyClipboard = false;
    window.open = target => { window.__requestTargets.push(String(target)); return { closed: false, opener: null, focus() {} }; };
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
async function main() {
  await prepare(); const page = await openPage(fileUrl);
  await mathChecks(page); await validationChecks(page); await formChecks(page); await reminderChecks(page); await privacyChecks(page);
  await monthEndChecks(); await staticHttpChecks();
  await check("Todo el recorrido evita visitas externas y no produce errores JavaScript", async () => { assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(extraResources, []); });
  console.log(`\n${checks} comprobaciones de solicitud correctas; ningún WhatsApp real enviado.`);
}
async function mathChecks(page) {
  await check("$200.000 en dos meses: interés total $70.000, total $270.000 y cuotas $135.000", async () => {
    const value = await core(page, "calculate", { principal_cents: 20000000, term_months: 2, first_due_date: "2026-11-21" });
    assert.equal(value.interest_percent, 35); assert.equal(value.interest_cents, 7000000); assert.equal(value.total_cents, 27000000);
    assert.deepEqual(value.installments.map(item => item.amount_cents), [13500000, 13500000]);
  });
  await check("Cambiar de uno a 24 meses distribuye el mismo 35%, sin interés mensual adicional", async () => {
    for (const months of [1, 2, 3, 6, 12, 24]) {
      const value = await core(page, "calculate", { principal_cents: 20000000, term_months: months, first_due_date: "2026-11-21" });
      assert.equal(value.interest_cents, 7000000); assert.equal(value.total_cents, 27000000); assert.equal(value.installments.length, months);
      assert.equal(value.installments.reduce((sum, item) => sum + item.amount_cents, 0), 27000000);
    }
  });
  await check("Centavos y última cuota conservan exactamente la suma total", async () => {
    for (const [principal, interest] of [[1, 0], [2, 1], [3, 1], [10, 4], [50, 18], [101, 35]]) {
      for (const months of [1, 2, 3]) {
        const value = await core(page, "calculate", { principal_cents: principal, term_months: months, first_due_date: "2026-11-21" });
        assert.equal(value.interest_cents, interest); assert.equal(value.total_cents, principal + interest);
        assert.equal(value.installments.reduce((sum, item) => sum + item.amount_cents, 0), principal + interest);
      }
    }
    assert.equal(await core(page, "parseMoney", "200000,50"), 20000050); assert.equal(await core(page, "parseMoney", "0.01"), 1);
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
  await check("WhatsApp se prepara para el número autorizado con datos completos y el interés total del 35%", async () => {
    const current = page.url(), before = await targetCount(page);
    await page.locator("#copy-request").click(); await page.waitForFunction(() => window.__copiedRequest);
    const copied = await page.evaluate(() => window.__copiedRequest);
    await page.locator("#send-request").click(); assert.equal(await targetCount(page), before + 1);
    const text = decodeTarget(await page.evaluate(() => window.__requestTargets.at(-1)));
    assert.equal(text, copied, "Copied request and WhatsApp request must agree exactly");
    for (const value of [fake.full_name, fake.address_street, fake.address_number, fake.locality]) assert.ok(text.includes(value), value);
    assert.ok(text.replace(/\D/g, "").includes("20000000001")); assert.ok(text.replace(/\D/g, "").includes("5491100000001"));
    for (const amount of ["200.000", "70.000", "270.000", "135.000"]) assert.ok(text.includes(amount), amount);
    assert.match(text, /35\s?%/); assert.match(text, /total/i); assert.doesNotMatch(text, /35\s?%\s*(mensual|por mes)/i);
    assert.ok(text.includes("2026")); assert.equal(page.url(), current);
    const status = await page.locator("#send-status").textContent(); assert.match(status, /WhatsApp/i); assert.match(status, /revis|toc[aá]|enviar/i);
    assert.doesNotMatch(status, /solicitud enviada|mensaje enviado|enviad[oa] con [eé]xito/i);
  });
  await check("Copiar sin permisos del portapapeles ofrece el texto completo para copia manual", async () => {
    await page.evaluate(() => { window.__denyClipboard = true; });
    await page.locator("#copy-request").click(); await page.locator("#copy-fallback-text").waitFor({ state: "visible" });
    const expected = decodeTarget(await page.evaluate(() => window.__requestTargets.at(-1)));
    assert.equal(await page.locator("#copy-fallback-text").inputValue(), expected);
    assert.equal(await page.locator("#copy-fallback-text").getAttribute("readonly"), "");
    await page.evaluate(() => { window.__denyClipboard = false; });
    assert.doesNotMatch(await page.locator("#send-status").textContent(), /solicitud enviada|mensaje enviado/i);
  });
}
async function reminderChecks(page) {
  await check("Calendario estimado descarga sin datos personales ni consentimiento de contacto", async () => {
    for (const name of ["full_name", "cuil", "address_street", "address_number", "locality", "client_whatsapp"]) await page.locator(`[name="${name}"]`).fill("");
    await page.locator('[name="contact_consent"]').uncheck(); const targets = await targetCount(page);
    const downloading = page.waitForEvent("download"); await page.locator("#download-reminders").click();
    const saved = path.join(directory, "recordatorios.ics"); await (await downloading).saveAs(saved); const ics = await fs.readFile(saved, "utf8");
    assert.ok(ics.includes("BEGIN:VCALENDAR")); const events = [...ics.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map(match => match[1]);
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
    await page.locator("#send-request").click(); assert.equal(await targetCount(page), 1); decodeTarget(await page.evaluate(() => window.__requestTargets[0]));
    await noOverflow(page); await storageIsEmpty(page);
    assert.doesNotMatch(await page.locator("#send-status").textContent(), /solicitud enviada|mensaje enviado/i);
  });
  await page.close();
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close(); if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
