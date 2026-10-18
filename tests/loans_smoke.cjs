/* Development integration checks. The delivered HTML needs no Node or Python.
 * CHROMIUM_PATH=/path/to/chrome node tests/loans_smoke.cjs delivery.zip
 * Opens a temporary copy/extracted HTML via file:// and disposable profiles.
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
const source = path.resolve(process.argv[2] || "/workspace/nicolas/entrega/Nicolas-prestamos.zip");
const password = "Clave de prestamos privada 2026!";
const customerName = "María de Prueba Privada";
const lenderName = "Nicolás Prestamista de Prueba";
const fixedTime = "2026-10-18T15:00:00.000Z";
const pageErrors = [], network = [], contexts = new Set();
let directory, context, html, url, checks = 0;
async function check(label, operation) {
  assert.deepEqual(pageErrors, [], "JavaScript errors before check");
  await operation();
  assert.deepEqual(pageErrors, [], `JavaScript error: ${label}`);
  checks++; console.log(`✓ ${label}`);
}
async function api(page, endpoint, method = "GET", body) {
  return page.evaluate(({ endpoint, method, body }) => NicolasStore.request(endpoint,
    { method, ...(body === undefined ? {} : { body }) }), { endpoint, method, body });
}
async function rejects(page, endpoint, method = "GET", body) {
  const result = await page.evaluate(async ({ endpoint, method, body }) => {
    try { await NicolasStore.request(endpoint, { method, ...(body === undefined ? {} : { body }) }); return { rejected: false }; }
    catch (error) { return { rejected: true, message: error.message, status: error.status }; }
  }, { endpoint, method, body });
  assert.equal(result.rejected, true, `${method} ${endpoint} must reject ${JSON.stringify(body)?.slice(0, 180)}`);
  return result;
}
async function openBrowser(profile) {
  const browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    acceptDownloads: true, viewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  contexts.add(browser);
  browser.on("request", (request) => { if (!/^(file:|blob:|data:|about:)/.test(request.url())) network.push(request.url()); });
  await browser.route(/^https?:/, (route) => route.abort("internetdisconnected"));
  const track = (page) => page.on("pageerror", (error) => pageErrors.push(error.stack || String(error)));
  browser.pages().forEach(track); browser.on("page", track);
  await browser.addInitScript(() => { window.print = () => { window.top.__printCalls = (window.top.__printCalls || 0) + 1; }; });
  return browser;
}
async function openPage(browser, target = url) {
  const page = browser.pages()[0]?.url() === "about:blank" ? browser.pages()[0] : await browser.newPage();
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.goto(target);
  await page.waitForFunction(() => window.NicolasStore);
  return page;
}
async function closeBrowser(browser) { await browser.close(); contexts.delete(browser); }
async function findHtml(root) {
  const results = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) results.push(...await findHtml(path.join(root, entry.name)));
    else if (/\.html$/i.test(entry.name)) results.push(path.join(root, entry.name));
  }
  return results;
}
async function prepare() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nicolas-loans-test-"));
  if (/\.zip$/i.test(source)) {
    const extracted = path.join(directory, "ZIP descomprimido");
    execFileSync("unzip", ["-q", source, "-d", extracted]);
    const files = await findHtml(extracted); assert.equal(files.length, 1, "Exactly one standalone HTML must be delivered"); html = files[0];
  } else { html = path.join(directory, "Nicolas prestamos prueba.html"); await fs.copyFile(source, html); }
  url = pathToFileURL(html).href;
  context = await openBrowser(path.join(directory, "profile"));
  return openPage(context);
}
async function exportData(page) {
  return page.evaluate(async (secret) => {
    const envelope = JSON.parse(await NicolasStore.exportBackup());
    const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: bytes(envelope.kdf.salt) }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const additionalData = new TextEncoder().encode(JSON.stringify({ version: envelope.version, type: envelope.type, vault_id: envelope.vault_id, revision: envelope.revision, created_at: envelope.created_at, updated_at: envelope.updated_at, kdf: { name: envelope.kdf.name, hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: envelope.kdf.salt } }));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(envelope.cipher.iv), additionalData }, key, bytes(envelope.cipher.data));
    return { envelope, data: JSON.parse(new TextDecoder().decode(decrypted)) };
  }, password);
}
async function persistedText(page) {
  return page.evaluate(async () => {
    const records = [];
    for (const metadata of await indexedDB.databases()) {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(metadata.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      for (const name of database.objectStoreNames) records.push(await new Promise((resolve, reject) => {
        const request = database.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      }));
      database.close();
    }
    return JSON.stringify({ records, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } });
  });
}
async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport && dimensions.body <= dimensions.viewport, JSON.stringify(dimensions));
}
async function downloadText(page, selector, filename) {
  const downloading = page.waitForEvent("download"); await page.locator(selector).click();
  const download = await downloading, target = path.join(directory, filename); await download.saveAs(target);
  return fs.readFile(target, "utf8");
}
function loanInput(clientId, overrides = {}) {
  return { client_id: clientId, principal_cents: 10000000, monthly_rate_bps: 1000,
    term_months: 3, issued_date: "2026-08-18", first_due_date: "2026-09-18",
    interest_method: "flat", payment_plan: "installments", notes: "Préstamo de prueba privado",
    request_id: randomUUID(), ...overrides };
}
async function createLoan(page, clientId, overrides) { return (await api(page, "/loans", "POST", loanInput(clientId, overrides))).loan; }
function paymentInput(loanId, amount, overrides = {}) {
  return { loan_id: loanId, amount_cents: amount, paid_date: "2026-10-18", method: "cash",
    notes: "Cobro de prueba privado", request_id: randomUUID(), ...overrides };
}
async function preview(page, body) { return (await api(page, "/loans/preview", "POST", body)).preview; }
async function snapshot(page) { return (await exportData(page)).data; }
async function main() {
  const page = await prepare();
  await gateCheck(page);
  await businessChecks(page);
  await migrationCheck();
  await check("Archivo privado: cero peticiones de red y cero errores JavaScript", async () => {
    assert.deepEqual(network, []); assert.deepEqual(pageErrors, []);
  });
  console.log(`\n${checks} comprobaciones de préstamos correctas. Solo archivos y perfiles temporales.`);
}
async function gateCheck(page) {
  await check("HTML extraído abre directamente y protege el acceso con contraseña", async () => {
    assert.equal(new URL(page.url()).protocol, "file:");
    await page.locator("#privacy-gate").waitFor({ state: "visible" }); await rejects(page, "/loans");
    await page.locator("#privacy-password").fill(password); await page.locator("#privacy-password-repeat").fill("No coincide");
    await page.locator("#privacy-access-form").evaluate(form => form.requestSubmit());
    await page.locator("#privacy-access-error").waitFor({ state: "visible" }); await rejects(page, "/loans");
    await page.locator("#privacy-password-repeat").fill(password); await page.locator("#privacy-access-form").evaluate(form => form.requestSubmit());
    await page.locator("#privacy-gate").waitFor({ state: "hidden" });
    assert.equal((await exportData(page)).data.schema_version, 2);
  });
}
async function businessChecks(page) {
  await check("Alta de cliente y datos del prestamista desde la interfaz", async () => {
    await page.locator('.main-nav [data-view="clients"]').click(); await page.locator("#add-client").click();
    await page.locator('#client-form [name="name"]').fill(customerName);
    await page.locator('#client-form [name="document"]').fill("32123456");
    await page.locator('#client-form [name="phone"]').fill("1155550101");
    await page.locator('#client-form [name="address"]').fill("Calle Privada 123");
    await page.locator('button[form="client-form"]').click(); await page.locator("#modal").waitFor({ state: "hidden" });
    await page.locator("#clients-body").getByText(customerName, { exact: true }).waitFor();
    await page.locator('.main-nav [data-view="settings"]').click();
    for (const [name, value] of Object.entries({ lender_name: lenderName, lender_document: "20123456789",
      lender_phone: "1144440101", lender_address: "Oficina de Prueba 456", city: "Buenos Aires" })) {
      await page.locator(`#settings-form [name="${name}"]`).fill(value);
    }
    await page.locator('#settings-form [name="reminder_days"]').selectOption("3");
    await page.locator("#settings-form").evaluate(form => form.requestSubmit());
    await page.waitForFunction(async expected => (await NicolasStore.request("/settings")).settings.lender_name === expected, lenderName);
  });
  const client = (await api(page, "/clients")).clients.find(client => client.name === customerName);
  await check("Capital $100.000, tasa mensual 10%, tres cuotas: cálculo plano exacto", async () => {
    const before = await snapshot(page), value = await preview(page, loanInput(client.id));
    assert.deepEqual(value.installments.map(item => item.principal_cents), [3333333, 3333333, 3333334]);
    assert.deepEqual(value.installments.map(item => item.interest_cents), [1000000, 1000000, 1000000]);
    assert.equal(value.interest_cents, 3000000); assert.equal(value.total_cents, 13000000);
    assert.deepEqual(value.installments.map(item => item.due_date), ["2026-09-18", "2026-10-18", "2026-11-18"]);
    assert.deepEqual(await snapshot(page), before, "Preview must not create a loan or alter data");
  });
  await check("Capital fijo sobre saldo: intereses $10.000, $6.666,67 y $3.333,33", async () => {
    const value = await preview(page, loanInput(client.id, { interest_method: "declining" }));
    assert.deepEqual(value.installments.map(item => item.interest_cents), [1000000, 666667, 333333]);
    assert.deepEqual(value.installments.map(item => item.principal_cents), [3333333, 3333333, 3333334]);
    assert.equal(value.interest_cents, 2000000); assert.equal(value.total_cents, 12000000);
    const cents = await preview(page, loanInput(client.id, { principal_cents: 10001, interest_method: "declining" }));
    assert.deepEqual(cents.installments.map(item => item.principal_cents), [3333, 3333, 3335]);
    assert.deepEqual(cents.installments.map(item => item.interest_cents), [1000, 667, 334]); assert.equal(cents.total_cents, 12002);
  });
  await check("Planes de solo interés y pago único conservan capital y redondeo mensual", async () => {
    for (const method of ["flat", "declining"]) {
      const interestOnly = await preview(page, loanInput(client.id, { payment_plan: "interest_only", interest_method: method }));
      assert.deepEqual(interestOnly.installments.map(item => item.principal_cents), [0, 0, 10000000]);
      assert.deepEqual(interestOnly.installments.map(item => item.interest_cents), [1000000, 1000000, 1000000]);
      assert.equal(interestOnly.total_cents, 13000000);
    }
    const single = await preview(page, loanInput(client.id, { payment_plan: "single", principal_cents: 105 }));
    assert.equal(single.installments.length, 1); assert.equal(single.installments[0].due_date, "2026-11-18");
    assert.equal(single.interest_cents, 33); assert.equal(single.total_cents, 138);
  });
  await check("Fechas de fin de mes, año bisiesto, primer día personalizado e interés cero", async () => {
    const standard = loanInput(client.id, { principal_cents: 10000, monthly_rate_bps: 0, issued_date: "2027-01-31", first_due_date: "" });
    const automatic = await preview(page, standard);
    assert.deepEqual(automatic.installments.map(item => item.due_date), ["2027-02-28", "2027-03-31", "2027-04-30"]);
    assert.equal(automatic.total_cents, 10000); assert.equal(automatic.interest_cents, 0);
    assert.equal(automatic.due_anchor_day, 31);
    const explicit = await preview(page, { ...standard, first_due_date: "2027-02-28" });
    assert.deepEqual(explicit.installments.map(item => item.due_date), ["2027-02-28", "2027-03-28", "2027-04-28"]);
    assert.equal(explicit.due_anchor_day, 28);
    const leap = await preview(page, { ...standard, issued_date: "2028-01-31", first_due_date: null });
    assert.deepEqual(leap.installments.map(item => item.due_date), ["2028-02-29", "2028-03-31", "2028-04-30"]);
  });
  await check("Datos inválidos no crean préstamos ni alteran los registros", async () => {
    const before = await snapshot(page);
    for (const invalid of [{ principal_cents: true }, { principal_cents: 0 }, { principal_cents: -1 }, { principal_cents: 1.5 },
      { monthly_rate_bps: -1 }, { monthly_rate_bps: 0.5 }, { term_months: 0 }, { term_months: 121 },
      { issued_date: "2027-02-29" }, { first_due_date: "2026-08-18" }, { interest_method: "compound" }, { payment_plan: "unknown" }]) {
      await rejects(page, "/loans", "POST", loanInput(client.id, invalid));
    }
    await rejects(page, "/loans", "POST", loanInput(9999999));
    assert.deepEqual(await snapshot(page), before);
  });
  const uiLoan = await createLoanThroughUi(page, client.id);
  await paymentChecks(page, client.id, uiLoan);
  await noteChecks(page, uiLoan);
  const reminders = await dueAndLedgerChecks(page, client.id);
  await exportChecks(page, uiLoan, reminders);
  await privacyChecks(page, uiLoan);
}
async function createLoanThroughUi(page, clientId) {
  let created;
  await check("Crear préstamo desde el formulario exige revisar el cronograma y conserva sus condiciones", async () => {
    await page.locator('.page-actions [data-action="new-loan"]').click();
    await page.locator('#loan-form [name="client_id"]').selectOption(String(clientId));
    for (const [name, value] of Object.entries({ principal: "100000", monthly_rate: "10", term_months: "3", issued_date: "2026-08-18", first_due_date: "2026-09-18", notes: "Préstamo de prueba privado" })) await page.locator(`#loan-form [name="${name}"]`).fill(value);
    await page.locator('#loan-form [name="interest_method"]').selectOption("flat"); await page.locator('#loan-form [name="payment_plan"]').selectOption("installments");
    await page.locator("#loan-preview h3").getByText("Plan de cobro", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector("#loan-preview")?.textContent.includes("130.000"));
    assert.equal(await page.locator("#loan-preview tbody tr").count(), 3);
    await page.locator('button[form="loan-form"]').click(); await page.locator(".loan-detail").waitFor();
    created = (await api(page, "/loans")).loans[0];
    assert.equal(created.principal_cents, 10000000); assert.equal(created.total_cents, 13000000); assert.equal(created.monthly_rate_bps, 1000);
    assert.equal(created.client_name, customerName); assert.equal(created.lender.name, lenderName); assert.equal(created.note.signed, false);
    assert.equal(await page.locator(".loan-detail .schedule-table tbody tr").count(), 3);
    const repeated = await api(page, "/loans", "POST", loanInput(clientId, { request_id: created.request_id }));
    assert.equal(repeated.loan.id, created.id); assert.equal((await api(page, "/loans")).loans.length, 1);
    await rejects(page, "/loans", "POST", loanInput(clientId, { request_id: created.request_id, notes: "Solicitud alterada" }));
    await api(page, `/clients/${clientId}`, "PUT", { name: "Cliente modificado después del préstamo" });
    await api(page, "/settings", "PUT", { lender_name: "Prestamista modificado después del préstamo" });
    const unchanged = (await api(page, `/loans/${created.id}`)).loan;
    assert.equal(unchanged.client_name, customerName); assert.equal(unchanged.lender.name, lenderName);
    await api(page, `/clients/${clientId}`, "PUT", { name: customerName }); await api(page, "/settings", "PUT", { lender_name: lenderName });
    await page.locator('[data-action="close-modal"]').last().click();
  });
  return created;
}
async function collectThroughUi(page, loan) {
  await check("Registrar un abono desde la interfaz genera comprobante y actualiza el saldo", async () => {
    await page.locator('.main-nav [data-view="payments"]').click(); await page.locator('#view-payments [data-action="new-payment"]').first().click();
    await page.locator('#payment-form [name="loan_id"]').selectOption(String(loan.id));
    await page.locator('#payment-form [name="amount"]').fill("5000");
    await page.locator('#payment-form [name="paid_date"]').fill("2026-10-18"); await page.locator('#payment-form [name="method"]').selectOption("transfer");
    await page.locator('button[form="payment-form"]').click(); await page.locator(".payment-receipt").waitFor();
    assert.ok((await page.locator(".payment-receipt").textContent()).includes(customerName));
    await page.locator('[data-action="close-modal"]').last().click();
  });
}
function minimalPdf() {
  const chunks = ["%PDF-1.4\n"], offsets = [0];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>"];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(chunks.join(""))); chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join("")); chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); return Buffer.from(chunks.join(""));
}
async function noteChecks(page, loan) {
  const pdf = minimalPdf(), attachment = { name: "pagaré-firmado-prueba.pdf", type: "application/pdf", data: pdf.toString("base64") };
  await check("Pagaré pendiente imprime cliente, capital, tasa, vencimientos y espacios de firma", async () => {
    await page.locator('.main-nav [data-view="loans"]').click(); await page.locator(`#loans-body [data-action="view-loan"][data-id="${loan.id}"]`).first().click();
    await page.locator('.loan-detail').waitFor(); assert.match(await page.locator('.attachment-box').textContent(), /Pendiente de firma/);
    await page.locator(`[data-action="print-note"][data-id="${loan.id}"]`).click(); await page.locator(".promissory-note").waitFor();
    const text = await page.locator(".promissory-note").textContent();
    for (const term of [customerName, lenderName, "32123456", "Capital recibido", "100.000", "10", "2026", "Firma del deudor", "Firma del acreedor"]) assert.ok(text.includes(term), term);
    const prior = await page.evaluate(() => window.__printCalls || 0); await page.locator('[data-action="print-document"]').click(); await page.waitForFunction(prior => (window.__printCalls || 0) > prior, prior);
    const markup = await page.locator('iframe[title="Imprimir documento"]').last().getAttribute("srcdoc"); assert.ok(!/<link\b[^>]*stylesheet/i.test(markup)); assert.ok(markup.includes(customerName));
    assert.equal((await api(page, `/loans/${loan.id}`)).loan.note.signed, false, "Printing does not register a signature");
    await page.locator(`#modal [data-action="view-loan"][data-id="${loan.id}"]`).click();
  });
  await check("Firmas inválidas, SVG y falsos PDF son rechazados sin cambiar el pagaré", async () => {
    const before = await snapshot(page);
    for (const changes of [{ signed_date: "2026-08-17" }, { signed_date: "2026-02-30" }, { signed_date: "2026-10-19" },
      { attachment: { name: "falso.pdf", type: "application/pdf", data: Buffer.from("Documento falso sin cabecera de PDF").toString("base64") } },
      { attachment: { name: "activo.svg", type: "image/svg+xml", data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>").toString("base64") } }]) {
      await rejects(page, `/loans/${loan.id}/note`, "POST", { signed: true, signed_date: "2026-10-18", attachment: null, ...changes });
    }
    const oversized = Buffer.concat([pdf, Buffer.alloc(5 * 1024 * 1024 + 1 - pdf.length, 32)]).toString("base64");
    await rejects(page, `/loans/${loan.id}/note`, "POST", { signed: true, signed_date: "2026-10-18", attachment: { ...attachment, data: oversized } });
    assert.deepEqual(await snapshot(page), before);
  });
  await check("Un adjunto PDF de exactamente 5 MB se guarda y puede reemplazarse", async () => {
    const maximum = Buffer.concat([pdf, Buffer.alloc(5 * 1024 * 1024 - pdf.length, 32)]).toString("base64");
    const value = (await api(page, `/loans/${loan.id}/note`, "POST", { signed: true, signed_date: "2026-10-18", attachment: { ...attachment, data: maximum } })).loan;
    assert.equal(Buffer.from(value.note.attachment.data, "base64").length, 5 * 1024 * 1024);
    await api(page, `/loans/${loan.id}/note`, "POST", { signed: false, signed_date: "", attachment: null });
  });
  await check("Registrar firma con fecha y un PDF real desde la interfaz conserva el archivo", async () => {
    // Reopen from API-backed view so the form reflects the latest cleared note.
    await page.locator('[data-action="close-modal"]').last().click();
    await page.locator(`#loans-body [data-action="view-loan"][data-id="${loan.id}"]`).first().click();
    await page.locator(`[data-action="edit-note"][data-id="${loan.id}"]`).click();
    await page.locator('#note-form [name="signed"]').check(); await page.locator('#note-form [name="signed_date"]').fill("2026-10-18");
    await page.locator('#note-form [name="attachment"]').setInputFiles({ name: attachment.name, mimeType: attachment.type, buffer: pdf });
    await page.locator('button[form="note-form"]').click(); await page.locator(".loan-detail").waitFor();
    const signed = (await api(page, `/loans/${loan.id}`)).loan; assert.equal(signed.note.signed, true); assert.equal(signed.note.signed_date, "2026-10-18");
    assert.deepEqual(Buffer.from(signed.note.attachment.data, "base64"), pdf);
    const downloading = page.waitForEvent("download"); await page.locator(`[data-action="download-note"][data-id="${loan.id}"]`).click();
    const saved = path.join(directory, "firmado-recuperado.pdf"); await (await downloading).saveAs(saved); assert.deepEqual(await fs.readFile(saved), pdf);
    await page.locator('[data-action="close-modal"]').last().click();
  });
}
async function paymentChecks(page, clientId, uiLoan) {
  await collectThroughUi(page, uiLoan);
  await check("Abonos parciales se asignan primero a interés y luego al capital de cada cuota", async () => {
    const updated = (await api(page, `/loans/${uiLoan.id}`)).loan;
    assert.equal(updated.paid_cents, 500000); assert.equal(updated.interest_paid_cents, 500000);
    assert.equal(updated.principal_paid_cents, 0); assert.equal(updated.balance_cents, 12500000);
    assert.equal(updated.installments[0].balance_cents, 3833333);
  });
  await check("Revertir un cobro anterior recalcula los siguientes y no revierte dos veces", async () => {
    const loan = await createLoan(page, clientId, { principal_cents: 10000, term_months: 2 });
    const first = (await api(page, "/payments", "POST", paymentInput(loan.id, 7000))).payment;
    assert.equal(first.principal_cents, 5000); assert.equal(first.interest_cents, 2000);
    assert.deepEqual(first.allocations, [{ installment_number: 1, principal_cents: 5000, interest_cents: 1000 }, { installment_number: 2, principal_cents: 0, interest_cents: 1000 }]);
    const second = (await api(page, "/payments", "POST", paymentInput(loan.id, 4000))).payment;
    assert.equal(second.principal_cents, 4000); assert.equal(second.interest_cents, 0);
    const before = await snapshot(page); await rejects(page, "/payments", "POST", paymentInput(loan.id, 1001)); assert.deepEqual(await snapshot(page), before);
    await api(page, `/payments/${first.id}/reverse`, "POST", { reason: "Corrección del recibo anterior" });
    const result = (await api(page, `/loans/${loan.id}`)).loan;
    assert.equal(result.paid_cents, 4000); assert.equal(result.principal_paid_cents, 3000);
    assert.equal(result.interest_paid_cents, 1000); assert.equal(result.principal_balance_cents, 7000); assert.equal(result.balance_cents, 8000);
    const reallocated = (await api(page, "/payments")).payments.find(payment => payment.id === second.id);
    assert.equal(reallocated.principal_cents, 3000); assert.equal(reallocated.interest_cents, 1000);
    const once = await snapshot(page); await api(page, `/payments/${first.id}/reverse`, "POST", { reason: "Segundo clic" });
    assert.deepEqual(await snapshot(page), once);
    await rejects(page, `/loans/${loan.id}/cancel`, "POST", { reason: "Con cobros activos" });
  });
  await check("Cobros inválidos y cambios de payload con el mismo identificador no alteran saldos", async () => {
    const loan = await createLoan(page, clientId, { principal_cents: 10000, monthly_rate_bps: 0, term_months: 1 });
    const body = paymentInput(loan.id, 1000), first = await api(page, "/payments", "POST", body), repeat = await api(page, "/payments", "POST", body);
    assert.equal(first.payment.id, repeat.payment.id); assert.equal(repeat.loan.paid_cents, 1000);
    const before = await snapshot(page);
    for (const invalid of [{ amount_cents: 0 }, { amount_cents: true }, { amount_cents: -1 }, { amount_cents: 1.5 },
      { amount_cents: 9001 }, { paid_date: "2026-08-17" }, { paid_date: "2026-10-19" }, { paid_date: "2026-02-30" }, { method: "unknown" }]) {
      await rejects(page, "/payments", "POST", paymentInput(loan.id, 1000, invalid));
    }
    await rejects(page, "/payments", "POST", { ...body, notes: "Payload distinto" });
    assert.deepEqual(await snapshot(page), before);
  });
  await check("Dos pestañas deduplican cobros y no pueden sobrepasar el saldo simultáneamente", async () => {
    const loan = await createLoan(page, clientId, { principal_cents: 10000, monthly_rate_bps: 0, term_months: 1 });
    const second = await openPage(context); await second.evaluate(secret => NicolasStore.unlock(secret), password);
    try {
      const body = paymentInput(loan.id, 6000), repeated = await Promise.all([page, second].map(tab => api(tab, "/payments", "POST", body)));
      assert.equal(repeated[0].payment.id, repeated[1].payment.id);
      const outcomes = await Promise.all([page, second].map(tab => tab.evaluate(async body => {
        try { return { success: true, value: await NicolasStore.request("/payments", { method: "POST", body }) }; }
        catch (error) { return { success: false, message: error.message }; }
      }, paymentInput(loan.id, 3000))));
      assert.equal(outcomes.filter(value => value.success).length, 1, JSON.stringify(outcomes));
      const result = (await api(page, `/loans/${loan.id}`)).loan; assert.equal(result.paid_cents, 9000); assert.equal(result.balance_cents, 1000);
      const payments = (await api(page, "/payments")).payments.filter(payment => payment.loan_id === loan.id);
      assert.equal(payments.length, 2);
    } finally { await second.close(); }
  });
  await check("Cancelar sin cobros elimina el desembolso de caja y bloquea nuevos cobros", async () => {
    const loan = await createLoan(page, clientId, { principal_cents: 10000, term_months: 1, issued_date: "2026-10-01", first_due_date: "2026-11-01" });
    const cancelled = (await api(page, `/loans/${loan.id}/cancel`, "POST", { reason: "Operación no entregada" })).loan;
    assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.balance_cents, 0);
    const once = await snapshot(page); await api(page, `/loans/${loan.id}/cancel`, "POST", { reason: "Reintento" }); assert.deepEqual(await snapshot(page), once);
    await rejects(page, "/payments", "POST", paymentInput(loan.id, 100));
    assert.ok(!(await api(page, "/ledger")).entries.some(entry => entry.number === loan.number));
  });
}
async function dueAndLedgerChecks(page, clientId) {
  const ids = {};
  await check("Reloj fijo: avisos de vencidos, hoy y próximos excluyen cuotas pagadas", async () => {
    for (const [name, due] of Object.entries({ overdue: "2026-10-17", today: "2026-10-18", upcoming: "2026-10-20", later: "2026-10-22" })) {
      ids[name] = await createLoan(page, clientId, { principal_cents: 10000, monthly_rate_bps: 0, term_months: 1, issued_date: "2026-09-01", first_due_date: due });
    }
    const dashboard = await api(page, "/loan-dashboard"), selected = dashboard.upcoming.filter(item => Object.values(ids).some(loan => loan.id === item.loan_id));
    assert.deepEqual(selected.map(item => item.due_date), ["2026-10-17", "2026-10-18", "2026-10-20"]);
    assert.equal(selected[0].days_overdue, 1); assert.equal(selected[1].days_overdue, 0);
    await page.evaluate(() => refresh()); await page.locator('.main-nav [data-view="due"]').click();
    for (const [filter, name, label] of [["overdue", "overdue", /1 d[ií]as? de atraso/], ["today", "today", /Vence hoy/], ["upcoming", "upcoming", /En 2 d[ií]as/]]) {
      await page.locator("#due-filter").selectOption(filter);
      const row = page.locator("#due-body tr").filter({ hasText: ids[name].number });
      await row.waitFor(); assert.match(await row.textContent(), label);
    }
    assert.ok(!(await page.locator("#due-body").textContent()).includes(ids.later.number));
    await api(page, "/payments", "POST", paymentInput(ids.overdue.id, 10000));
    await api(page, "/payments", "POST", paymentInput(ids.today.id, 10000));
    const updated = await api(page, "/loan-dashboard");
    assert.equal(updated.overdue_count, dashboard.overdue_count - 1); assert.equal(updated.overdue_cents, dashboard.overdue_cents - 10000);
    assert.equal(updated.due_today_cents, dashboard.due_today_cents - 10000);
    assert.ok(!updated.upcoming.some(item => [ids.overdue.id, ids.today.id].includes(item.loan_id)));
    assert.ok(updated.upcoming.some(item => item.loan_id === ids.upcoming.id));
    await page.evaluate(() => refresh()); await page.locator("#due-filter").selectOption("all");
    assert.ok(!(await page.locator("#due-body").textContent()).includes(ids.overdue.number));
    assert.ok(!(await page.locator("#due-body").textContent()).includes(ids.today.number));
  });
  await check("Libro de caja ordenado: desembolsos, cobros y reparto capital/interés consistentes", async () => {
    const entries = (await api(page, "/ledger")).entries, loans = (await api(page, "/loans")).loans, payments = (await api(page, "/payments")).payments;
    let balance = 0;
    assert.deepEqual(entries.map(item => item.date), entries.map(item => item.date).sort());
    for (const entry of entries) {
      if (entry.type === "disbursement") {
        const loan = loans.find(loan => loan.number === entry.number); assert.notEqual(loan.status, "cancelled");
        assert.equal(entry.debit_cents, loan.principal_cents); assert.equal(entry.credit_cents, 0);
        assert.equal(entry.principal_cents, loan.principal_cents); assert.equal(entry.interest_cents, 0);
      } else {
        const payment = payments.find(payment => payment.number === entry.number); assert.equal(payment.status, "active");
        assert.equal(entry.credit_cents, payment.amount_cents); assert.equal(entry.debit_cents, 0);
        assert.equal(entry.principal_cents + entry.interest_cents, entry.credit_cents);
        assert.equal(entry.principal_cents, payment.principal_cents); assert.equal(entry.interest_cents, payment.interest_cents);
      }
      balance += entry.credit_cents - entry.debit_cents; assert.equal(entry.balance_cents, balance);
    }
    assert.equal(entries.filter(entry => entry.type === "payment").length, payments.filter(payment => payment.status === "active").length);
    const expected = payments.filter(payment => payment.status === "active").reduce((total, payment) => total + payment.amount_cents, 0) - loans.filter(loan => loan.status !== "cancelled").reduce((total, loan) => total + loan.principal_cents, 0);
    assert.equal(balance, expected);
  });
  return ids;
}
async function exportChecks(page, loan, reminders) {
  await check("Exportaciones CSV de préstamos, cobros y caja descargan sin servidor", async () => {
    await page.evaluate(() => { if (typeof refresh === "function") return refresh(); });
    for (const kind of ["loans", "payments", "ledger"]) {
      await page.locator(`.main-nav [data-view="${kind}"]`).click();
      const csv = await downloadText(page, `#view-${kind} a[download]`, `${kind}.csv`);
      assert.ok(csv.split(/\r?\n/).length > 2); assert.ok(csv.includes(customerName));
      if (kind === "loans") { assert.ok(csv.includes(loan.number)); assert.ok(csv.includes("10000000")); }
      if (kind === "payments") assert.match(csv, /Capital.*Interés/);
    }
  });
  await check("Calendario ICS conserva fechas y alarmas de cuotas pendientes y omite las pagadas", async () => {
    await page.locator('.main-nav [data-view="due"]').click();
    const ics = await downloadText(page, '[data-action="download-calendar"]', "vencimientos.ics");
    assert.ok(ics.includes("BEGIN:VCALENDAR")); assert.ok(ics.includes("BEGIN:VEVENT"));
    const events = [...ics.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map(match => match[1]);
    const upcoming = events.find(event => event.includes(reminders.upcoming.number)); assert.ok(upcoming, "Upcoming loan must be exported");
    assert.match(upcoming, /DTSTART;TZID=America\/Argentina\/Buenos_Aires:20261020T090000/); assert.match(upcoming, /BEGIN:VALARM/);
    assert.match(upcoming, /TRIGGER:-P3D/);
    assert.ok(!events.some(event => event.includes(reminders.today.number)), "Paid loan must not create reminders");
    assert.ok(!events.some(event => event.includes(reminders.overdue.number)), "Paid overdue loan must not create reminders");
  });
  await check("Vistas de préstamos, cobros, vencimientos y datos se usan en móvil de 390 píxeles", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const view of ["dashboard", "loans", "payments", "due", "ledger", "settings"]) {
      await page.locator("#nav-toggle").click(); await page.locator(`.main-nav [data-view="${view}"]`).click(); await noOverflow(page);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
}
async function invalidSchemaBackup(page, backup) {
  return page.evaluate(async ({ backup, password }) => {
    const envelope = JSON.parse(backup), encoder = new TextEncoder();
    const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: bytes(envelope.kdf.salt) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const additionalData = encoder.encode(JSON.stringify({ version: envelope.version, type: envelope.type, vault_id: envelope.vault_id, revision: envelope.revision, created_at: envelope.created_at, updated_at: envelope.updated_at, kdf: { name: envelope.kdf.name, hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: envelope.kdf.salt } }));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(envelope.cipher.iv), additionalData }, key, bytes(envelope.cipher.data));
    const data = JSON.parse(new TextDecoder().decode(plaintext)); data.loans[0].principal_cents = -1;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, encoder.encode(JSON.stringify(data))));
    let encoded = ""; for (let offset = 0; offset < encrypted.length; offset += 32768) encoded += String.fromCharCode(...encrypted.subarray(offset, offset + 32768));
    envelope.cipher.iv = btoa(String.fromCharCode(...iv)); envelope.cipher.data = btoa(encoded); return JSON.stringify(envelope);
  }, { backup, password });
}
async function privacyChecks(page, loan) {
  const before = await snapshot(page); let backup;
  await check("Clientes, pagarés y contraseña permanecen cifrados en IndexedDB y respaldo", async () => {
    backup = await downloadText(page, '[data-private-action="backup"]', "prestamos-copia.json");
    const envelope = JSON.parse(backup); assert.equal(envelope.cipher.name, "AES-GCM"); assert.ok(envelope.kdf.iterations >= 310000);
    const stored = await persistedText(page);
    for (const value of [customerName, lenderName, password, "Calle Privada 123", "pagaré-firmado-prueba.pdf"]) {
      assert.ok(!backup.includes(value), `Backup exposes ${value}`); assert.ok(!stored.includes(value), `Storage exposes ${value}`);
    }
    const summary = await page.evaluate(({ backup, password }) => NicolasStore.inspectBackup(backup, password), { backup, password });
    assert.equal(summary.clients_count, before.clients.length); assert.equal(summary.loans_count, before.loans.length); assert.equal(summary.payments_count, before.payments.length);
  });
  await check("Contraseña errónea, respaldo adulterado y esquema inválido no cambian datos", async () => {
    const tampered = JSON.parse(backup); tampered.cipher.data = (tampered.cipher.data[0] === "A" ? "B" : "A") + tampered.cipher.data.slice(1);
    const invalid = await invalidSchemaBackup(page, backup);
    const outcomes = await page.evaluate(async ({ backup, tampered, invalid, password }) => {
      const results = [];
      for (const [data, secret] of [[backup, "Equivocada"], [tampered, password], [invalid, password]]) {
        for (const operation of ["inspectBackup", "restoreBackup"]) {
          try { await NicolasStore[operation](data, secret); results.push(false); } catch (_) { results.push(true); }
        }
      }
      return results;
    }, { backup, tampered: JSON.stringify(tampered), invalid, password });
    assert.deepEqual(outcomes, [true, true, true, true, true, true]); assert.deepEqual(await snapshot(page), before);
  });
  await check("Restaurar una copia cifrada conserva préstamos, cobros y pagaré firmado", async () => {
    await api(page, "/settings", "PUT", { lender_name: "Cambio posterior a copia" });
    await page.evaluate(({ backup, password }) => NicolasStore.restoreBackup(backup, password), { backup, password });
    assert.deepEqual(await snapshot(page), before);
    const result = (await api(page, `/loans/${loan.id}`)).loan; assert.equal(result.note.signed, true);
    assert.equal(result.note.attachment.name, "pagaré-firmado-prueba.pdf"); assert.ok(result.note.attachment.data.startsWith("JVBERi0"));
  });
  await check("Bloquear limpia datos y formularios; contraseña errónea no permite acceso", async () => {
    await page.locator('[data-private-action="lock"]').click(); await page.locator("#privacy-gate").waitFor({ state: "visible" });
    await rejects(page, "/loans");
    assert.equal(await page.locator(".app-shell").evaluate(element => element.hidden && element.inert), true);
    assert.ok(!(await page.locator("body").textContent()).includes(customerName), "Locked DOM must clear client details");
    assert.equal(await page.locator("#privacy-password").inputValue(), "");
    await page.locator("#privacy-password").fill("Clave incorrecta"); await page.locator("#privacy-access-form").evaluate(form => form.requestSubmit());
    await page.locator("#privacy-access-error").waitFor({ state: "visible" }); await rejects(page, "/payments");
    await page.locator("#privacy-password").fill(password); await page.locator("#privacy-access-form").evaluate(form => form.requestSubmit()); await page.locator("#privacy-gate").waitFor({ state: "hidden" });
  });
  await check("Cerrar y reabrir el navegador conserva saldos y adjunto firmado y exige contraseña", async () => {
    await closeBrowser(context); context = await openBrowser(path.join(directory, "profile")); page = await openPage(context);
    await page.locator("#privacy-gate").waitFor({ state: "visible" }); await rejects(page, "/loans");
    await page.locator("#privacy-password").fill(password); await page.locator("#privacy-access-form").evaluate(form => form.requestSubmit()); await page.locator("#privacy-gate").waitFor({ state: "hidden" });
    assert.deepEqual(await snapshot(page), before);
    const restored = (await api(page, `/loans/${loan.id}`)).loan; assert.equal(restored.note.signed_date, "2026-10-18");
    assert.equal(restored.note.attachment.name, "pagaré-firmado-prueba.pdf");
  });
}
async function migrationCheck() {
  await check("La base de ventas anterior migra sin perder clientes, ventas, stock ni contraseña", async () => {
    const legacyHtml = path.join(directory, "Actualizacion misma ruta.html");
    const oldSource = execFileSync("git", ["-C", path.resolve(__dirname, ".."), "show", "8c51e8a:entrega/ABRIR-NICOLAS.html"]);
    await fs.writeFile(legacyHtml, oldSource);
    const browser = await openBrowser(path.join(directory, "migration-profile"));
    try {
      // API-level migration is independent from both versions' interface text.
      await browser.addInitScript(() => window.addEventListener("nicolas:unlocked", event => event.stopImmediatePropagation()));
      const page = await openPage(browser, pathToFileURL(legacyHtml).href);
      await page.evaluate(secret => NicolasStore.create(secret), password);
      const client = (await api(page, "/clients", "POST", { name: "Cliente anterior conservado", document: "24242424", phone: "1112345678", email: "anterior@example.com", address: "Dirección anterior 100" })).client;
      const product = (await api(page, "/products", "POST", { name: "Producto anterior conservado", sku: "ANTERIOR-1", price_cents: 1005, stock: 3, min_stock: 1 })).product;
      await api(page, "/invoices", "POST", { client_id: client.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash", tax_rate: 10.5, notes: "Venta histórica", request_id: randomUUID() });
      const oldBackup = await page.evaluate(() => NicolasStore.exportBackup()), old = await exportData(page);
      assert.equal(old.data.schema_version, 1); assert.equal(old.data.products[0].stock, 2);
      await fs.writeFile(legacyHtml, await fs.readFile(html)); await page.reload();
      await page.waitForFunction(() => window.NicolasStore);
      assert.equal((await page.evaluate(() => NicolasStore.status())).exists, true);
      await rejects(page, "/loans"); await page.evaluate(secret => NicolasStore.unlock(secret), password);
      assert.deepEqual((await api(page, "/loans")).loans, []);
      await api(page, "/settings", "PUT", { lender_name: "Prestamista actualizado" });
      const migrated = await exportData(page);
      assert.equal(migrated.data.schema_version, 2);
      for (const key of ["products", "clients", "invoices", "movements"]) assert.deepEqual(migrated.data[key], old.data[key], key);
      assert.equal(migrated.envelope.vault_id, old.envelope.vault_id); assert.deepEqual(migrated.envelope.kdf, old.envelope.kdf);
      assert.equal((await api(page, "/clients")).clients[0].name, "Cliente anterior conservado");
      const legacySummary = await page.evaluate(({ backup, secret }) => NicolasStore.inspectBackup(backup, secret), { backup: oldBackup, secret: password });
      assert.equal(legacySummary.clients_count, 1); assert.equal(legacySummary.loans_count, 0); assert.equal(legacySummary.payments_count, 0);
      await createLoan(page, client.id, { principal_cents: 10000, term_months: 1 });
      assert.equal((await api(page, "/loans")).loans.length, 1);
      await page.evaluate(({ backup, secret }) => NicolasStore.restoreBackup(backup, secret), { backup: oldBackup, secret: password });
      const restored = await exportData(page); assert.equal(restored.data.schema_version, 2); assert.deepEqual(restored.data.loans, []);
      for (const key of ["products", "clients", "invoices", "movements"]) assert.deepEqual(restored.data[key], old.data[key]);
    } finally { await closeBrowser(browser); }
  });
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled([...contexts].map(browser => browser.close()));
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
