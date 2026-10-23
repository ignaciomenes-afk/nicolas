/* Private loan-request import checks against encrypted IndexedDB in real Chrome.
 * node tests/requests_integration_smoke.cjs [static/local-store.js|standalone.html]
 * No real customer data, cloud calls or WhatsApp messages; disposable profiles only.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const source = path.resolve(process.argv[2] || path.join(__dirname, "../static/local-store.js"));
const chrome = process.env.CHROMIUM_PATH || "/tmp/nicolas-google-chrome/opt/google/chrome/chrome";
const password = "Clave exclusivamente sintetica 2026!";
const fixedTime = "2026-10-23T15:00:00.000Z";
const person = { full_name: "Persona Sintética de Prueba", cuil: "20123456786",
  address_street: "Calle Sintética", address_number: "123", locality: "Ciudad de Prueba",
  client_whatsapp: "5491100000000" };
const errors = [], network = [];
let browser, context, directory, url, checks = 0;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
async function check(label, action) {
  await action();
  assert.deepEqual(errors, [], "No uncaught browser errors");
  checks++; console.log(`✓ ${label}`);
}
async function api(page, endpoint, method = "GET", body) {
  return page.evaluate(({ endpoint, method, body }) => NicolasStore.request(endpoint,
    { method, ...(body === undefined ? {} : { body }) }), { endpoint, method, body });
}
async function rejects(page, body, status) {
  const result = await page.evaluate(async body => {
    try { await NicolasStore.request("/loan-requests/import", { method: "POST", body }); return { rejected: false }; }
    catch (error) { return { rejected: true, status: error.status, message: error.message }; }
  }, body);
  assert.equal(result.rejected, true, JSON.stringify(result));
  if (status !== undefined) assert.equal(result.status, status, result.message);
  return result;
}
function monthDate(index) {
  const date = new Date(Date.UTC(2026, 10 + index + 1, 0));
  return date.toISOString().slice(0, 10);
}
function approvedRequest(months = 6) {
  // Fixed independently reviewed amounts: total interest is 35% through 3 months,
  // 40% thereafter; EACH installment rounds upward to a multiple of ARS 1,000.
  const values = {
    1: [10000000, 35, 3500000, 13500000, 0, 13500000, 13500000],
    3: [100000001, 35, 35000000, 135000001, 299999, 135300000, 45100000],
    4: [100000000, 40, 40000000, 140000000, 0, 140000000, 35000000],
    6: [100000000, 40, 40000000, 140000000, 400000, 140400000, 23400000],
    24: [100000000, 40, 40000000, 140000000, 1600000, 141600000, 5900000],
  }[months];
  const [principal, rate, interest, base, adjustment, total, amount] = values;
  return { request_id: randomUUID(), approved_at: "2026-10-23T14:30:00.000Z", issued_date: "2026-10-23",
    customer: clone(person), quote: { policy_version: "nicolas-total-v1", principal_cents: principal,
      term_months: months, first_due_date: "2026-11-30", due_anchor_day: 31,
      interest_percent: rate, interest_cents: interest, base_total_cents: base,
      rounding_adjustment_cents: adjustment, total_cents: total,
      installments: Array.from({ length: months }, (_, index) => ({ number: index + 1,
        due_date: monthDate(index), amount_cents: amount })) } };
}
async function openPage() {
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.stack || String(error)));
  await page.clock.setFixedTime(new Date(fixedTime));
  await page.goto(url);
  await page.waitForFunction(() => window.NicolasStore);
  return page;
}
async function backup(page) { return page.evaluate(() => NicolasStore.exportBackup()); }
async function readBackup(page, supplied) {
  return page.evaluate(async ({ source, password }) => {
    const envelope = JSON.parse(source || await NicolasStore.exportBackup());
    const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const encoder = new TextEncoder();
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: envelope.kdf.hash,
      iterations: envelope.kdf.iterations, salt: decode(envelope.kdf.salt) }, material,
      { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const header = { version: envelope.version, type: envelope.type, vault_id: envelope.vault_id,
      revision: envelope.revision, created_at: envelope.created_at, updated_at: envelope.updated_at,
      kdf: { name: envelope.kdf.name, hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: envelope.kdf.salt } };
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.cipher.iv),
      additionalData: encoder.encode(JSON.stringify(header)) }, key, decode(envelope.cipher.data));
    return { envelope, data: JSON.parse(new TextDecoder().decode(plaintext)) };
  }, { source: supplied, password });
}
async function snapshot(page) { return (await readBackup(page)).data; }
async function encryptFixture(page, original, data) {
  return page.evaluate(async ({ original, data, password }) => {
    const envelope = JSON.parse(original), encoder = new TextEncoder();
    const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: envelope.kdf.hash,
      iterations: envelope.kdf.iterations, salt: decode(envelope.kdf.salt) }, material,
      { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const header = { version: envelope.version, type: envelope.type, vault_id: envelope.vault_id,
      revision: envelope.revision, created_at: envelope.created_at, updated_at: envelope.updated_at,
      kdf: { name: envelope.kdf.name, hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: envelope.kdf.salt } };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv,
      additionalData: encoder.encode(JSON.stringify(header)) }, key, encoder.encode(JSON.stringify(data))));
    let encoded = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    envelope.cipher.iv = btoa(String.fromCharCode(...iv)); envelope.cipher.data = btoa(encoded);
    return JSON.stringify(envelope);
  }, { original, data, password });
}
async function restore(page, source) {
  return page.evaluate(({ source, password }) => NicolasStore.restoreBackup(source, password), { source, password });
}
async function main() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nicolas-request-import-"));
  const html = path.join(directory, "private-import-test.html"), contents = await fs.readFile(source, "utf8");
  await fs.writeFile(html, /\.html$/i.test(source) ? contents : `<!doctype html><html><meta charset="utf-8"><title>Private import test</title><script>${contents.replace(/<\/script/gi, "<\\/script")}</script></html>`);
  url = pathToFileURL(html).href;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort("internetdisconnected"));
  context.on("request", request => { if (!/^(file:|blob:|data:|about:)/.test(request.url())) network.push(request.url()); });
  // A supplied full HTML can be exercised at API level without its UI refreshing.
  await context.addInitScript(() => window.addEventListener("nicolas:unlocked", event => event.stopImmediatePropagation()));
  const page = await openPage();
  await check("La importación exige desbloquear el archivo privado", async () => {
    await rejects(page, approvedRequest(), 401);
    await page.evaluate(password => NicolasStore.create(password), password);
    assert.equal((await snapshot(page)).schema_version, 3);
  });

  const firstRequest = approvedRequest(), first = await api(page, "/loan-requests/import", "POST", firstRequest);
  await check("Aprobación crea cliente y préstamo atómicos; total y pagaré pendiente se conservan", async () => {
    assert.equal(first.created, true); assert.equal(first.client.document, person.cuil);
    const loan = first.loan, state = await snapshot(page);
    assert.equal(state.clients.length, 1); assert.equal(state.loans.length, 1);
    assert.equal(loan.pricing_mode, "request_total"); assert.equal(loan.monthly_rate_bps, 0);
    assert.equal(loan.principal_cents, 100000000); assert.equal(loan.interest_cents, 40400000);
    assert.equal(loan.total_cents, 140400000); assert.equal(loan.balance_cents, 140400000);
    assert.deepEqual(loan.request_quote, firstRequest.quote);
    assert.deepEqual(loan.request_customer, firstRequest.customer);
    assert.equal(loan.request_quote.interest_cents, 40000000);
    assert.equal(loan.request_quote.rounding_adjustment_cents, 400000);
    assert.deepEqual(loan.note, { signed: false, signed_date: "", attachment: null });
    assert.deepEqual(loan.installments.map(item => item.due_date), ["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    assert.equal(loan.installments.reduce((sum, item) => sum + item.principal_cents, 0), 100000000);
    assert.equal(loan.installments.reduce((sum, item) => sum + item.interest_cents, 0), 40400000);
    assert.ok(loan.installments.every(item => item.total_cents === 23400000));
  });
  await check("Reintento idéntico no duplica; mismo UUID con cambios devuelve conflicto", async () => {
    const before = await snapshot(page), repeated = await api(page, "/loan-requests/import", "POST", firstRequest);
    assert.equal(repeated.created, false); assert.equal(repeated.loan.id, first.loan.id);
    assert.equal(repeated.client.id, first.client.id); assert.deepEqual(await snapshot(page), before);
    const modified = clone(firstRequest); modified.customer.address_number = "124";
    await rejects(page, modified, 409); assert.deepEqual(await snapshot(page), before);
  });
  await check("Política 35/40 total y redondeo por cuota funcionan en límites 1,3,4 y 24 meses", async () => {
    for (const months of [1, 3, 4, 24]) {
      const body = approvedRequest(months), result = await api(page, "/loan-requests/import", "POST", body);
      assert.equal(result.loan.total_cents, body.quote.total_cents);
      assert.equal(result.loan.interest_cents, body.quote.total_cents - body.quote.principal_cents);
      assert.deepEqual(result.loan.request_quote, body.quote);
      assert.equal(result.loan.installments.length, months);
      assert.ok(result.loan.installments.every(item => item.total_cents % 100000 === 0));
    }
    assert.equal((await api(page, "/clients")).clients.length, 1);
  });
  await check("CUIL existente se reutiliza sin sobreescribir datos; identidad distinta se rechaza", async () => {
    await api(page, `/clients/${first.client.id}`, "PUT", { phone: "5491100000001", address: "Dirección privada anterior 456" });
    const beforeClient = (await api(page, "/clients")).clients[0];
    const incoming = approvedRequest(); incoming.customer.address_number = "999";
    const result = await api(page, "/loan-requests/import", "POST", incoming);
    assert.equal(result.client.id, first.client.id); assert.deepEqual(result.client, beforeClient);
    assert.equal(result.loan.client_address, "Calle Sintética 999, Ciudad de Prueba");
    assert.equal(result.loan.client_phone, person.client_whatsapp);
    const before = await snapshot(page), conflict = approvedRequest(); conflict.customer.full_name = "Otra Persona Sintética";
    await rejects(page, conflict, 409); assert.deepEqual(await snapshot(page), before);
  });
  await check("CUIL inválido, fechas antiguas/futuras y aritmética adulterada no crean registros", async () => {
    const mutations = [
      body => { body.customer.cuil = "20123456780"; },
      body => { body.quote.first_due_date = "2026-10-22"; },
      body => { body.approved_at = "2026-10-24T00:00:00.000Z"; },
      body => { body.issued_date = "2026-10-22"; },
      body => { body.quote.interest_percent = 41; },
      body => { body.quote.interest_cents++; },
      body => { body.quote.base_total_cents++; },
      body => { body.quote.rounding_adjustment_cents++; },
      body => { body.quote.total_cents++; },
      body => { body.quote.installments[0].amount_cents++; },
      body => { body.quote.installments[1].due_date = "2026-12-30"; },
      body => { body.quote.principal_cents = true; },
      body => { body.quote.term_months = 25; },
      body => { body.quote.policy_version = "otra-politica"; },
      body => { body.customer.unexpected = "campo no permitido"; },
    ];
    const before = await snapshot(page);
    for (const mutate of mutations) { const body = approvedRequest(); mutate(body); await rejects(page, body); }
    assert.deepEqual(await snapshot(page), before);
  });
  await check("Aprobación UTC cercana a medianoche usa la fecha de Argentina", async () => {
    const body = approvedRequest(); body.approved_at = "2026-10-23T01:00:00.000Z"; body.issued_date = "2026-10-22";
    const result = await api(page, "/loan-requests/import", "POST", body);
    assert.equal(result.loan.issued_date, "2026-10-22");
    const wrong = clone(body); wrong.request_id = randomUUID(); wrong.issued_date = "2026-10-23";
    await rejects(page, wrong, 400);
  });
  await check("Error de disco aborta cliente y préstamo y permite reintentar la aprobación", async () => {
    const before = await snapshot(page), body = approvedRequest();
    // Same synthetic identity with a different valid CUIL: this path creates BOTH records.
    body.customer.cuil = "27999999994";
    const failure = await page.evaluate(async body => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException("Synthetic disk full", "QuotaExceededError"); };
      try { await NicolasStore.request("/loan-requests/import", { method: "POST", body }); return { rejected: false }; }
      catch (error) { return { rejected: true, message: error.message }; }
      finally { IDBObjectStore.prototype.put = original; }
    }, body);
    assert.equal(failure.rejected, true); assert.match(failure.message, /disk full|espacio/i);
    assert.deepEqual(await snapshot(page), before);
    const result = await api(page, "/loan-requests/import", "POST", body);
    assert.equal(result.created, true); assert.notEqual(result.client.id, first.client.id);
    assert.equal((await snapshot(page)).clients.length, before.clients.length + 1);
  });
  await check("Dos pestañas aprueban el mismo UUID una sola vez", async () => {
    const second = await openPage(); await second.evaluate(password => NicolasStore.unlock(password), password);
    try {
      const before = await snapshot(page), body = approvedRequest();
      const results = await Promise.all([page, second].map(tab => api(tab, "/loan-requests/import", "POST", body)));
      assert.equal(results[0].loan.id, results[1].loan.id);
      assert.equal(results.filter(result => result.created).length, 1);
      const after = await snapshot(page);
      assert.equal(after.loans.length, before.loans.length + 1); assert.equal(after.clients.length, before.clients.length);
    } finally { await second.close(); }
  });
  await check("Bloquear cancela la importación en curso sin guardar datos y reabrir exige clave", async () => {
    const before = await snapshot(page), result = await page.evaluate(async body => {
      const pending = NicolasStore.request("/loan-requests/import", { method: "POST", body }); NicolasStore.lock();
      try { await pending; return { rejected: false }; } catch (error) { return { rejected: true, status: error.status }; }
    }, approvedRequest());
    assert.deepEqual(result, { rejected: true, status: 401 });
    await rejects(page, approvedRequest(), 401);
    await page.evaluate(password => NicolasStore.unlock(password), password);
    assert.deepEqual(await snapshot(page), before);
    await page.reload(); await page.waitForFunction(() => window.NicolasStore);
    await rejects(page, approvedRequest(), 401);
    await page.evaluate(password => NicolasStore.unlock(password), password);
    assert.deepEqual(await snapshot(page), before);
  });
  await migrationChecks(page, firstRequest);
  await check("PII sintética y clave se guardan cifradas; no hay red ni mensajes reales", async () => {
    const exported = await backup(page), stored = await page.evaluate(async () => {
      const result = [];
      for (const metadata of await indexedDB.databases()) {
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open(metadata.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        for (const name of db.objectStoreNames) result.push(await new Promise((resolve, reject) => { const request = db.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }));
        db.close();
      }
      return JSON.stringify({ result, local: { ...localStorage }, session: { ...sessionStorage } });
    });
    for (const secret of [person.full_name, person.cuil, person.address_street, person.client_whatsapp, password]) {
      assert.ok(!exported.includes(secret), "Backup must not contain plaintext PII");
      assert.ok(!stored.includes(secret), "Storage must not contain plaintext PII");
    }
    assert.deepEqual(network, []);
  });
  console.log(`\n${checks} comprobaciones de solicitudes privadas correctas; perfiles y datos temporales.`);
}
async function migrationChecks(page, imported) {
  await check("Copia schema 2 conserva cálculo mensual, cuotas y cobros al restaurar en schema 3", async () => {
    const client = (await api(page, "/clients")).clients[0];
    const monthly = (await api(page, "/loans", "POST", { client_id: client.id, principal_cents: 10000000,
      monthly_rate_bps: 1000, term_months: 3, issued_date: "2026-08-23", first_due_date: "2026-09-23",
      interest_method: "flat", payment_plan: "installments", notes: "Mensual anterior sintético", request_id: randomUUID() })).loan;
    await api(page, "/payments", "POST", { loan_id: monthly.id, amount_cents: 500000, paid_date: "2026-10-23",
      method: "cash", notes: "Cobro sintético", request_id: randomUUID() });
    const original = await backup(page), before = await snapshot(page), previous = (await api(page, `/loans/${monthly.id}`)).loan;
    const legacy = clone(before); legacy.schema_version = 2;
    legacy.loans = legacy.loans.filter(loan => loan.id === monthly.id);
    for (const loan of legacy.loans) { delete loan.pricing_mode; delete loan.request_quote; delete loan.request_customer; }
    const oldBackup = await encryptFixture(page, original, legacy);
    const summary = await page.evaluate(({ source, password }) => NicolasStore.inspectBackup(source, password), { source: oldBackup, password });
    assert.equal(summary.loans_count, 1); assert.equal(summary.payments_count, 1);
    await restore(page, oldBackup);
    const migrated = await snapshot(page), actual = (await api(page, `/loans/${monthly.id}`)).loan;
    assert.equal(migrated.schema_version, 3); assert.equal(actual.pricing_mode, "monthly");
    assert.equal(actual.monthly_rate_bps, 1000); assert.equal(actual.interest_cents, 3000000);
    assert.equal(actual.total_cents, 13000000); assert.equal(actual.paid_cents, 500000);
    assert.deepEqual(actual, previous); assert.deepEqual(migrated.payments, legacy.payments);
    assert.deepEqual(migrated.clients, legacy.clients);
    await api(page, "/loan-requests/import", "POST", imported);
    assert.deepEqual((await api(page, `/loans/${monthly.id}`)).loan, previous);
    await restore(page, original); assert.deepEqual(await snapshot(page), before);
  });
  await check("Copias con simulación importada adulterada se rechazan sin reemplazar el archivo", async () => {
    const original = await backup(page), before = await snapshot(page), tampered = clone(before);
    tampered.loans.find(loan => loan.pricing_mode === "request_total").request_quote.rounding_adjustment_cents++;
    const invalid = await encryptFixture(page, original, tampered);
    const rejected = await page.evaluate(async ({ source, password }) => {
      try { await NicolasStore.restoreBackup(source, password); return false; } catch (_) { return true; }
    }, { source: invalid, password });
    assert.equal(rejected, true); assert.deepEqual(await snapshot(page), before);
  });
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});
