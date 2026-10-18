/* Legacy sales interface checks, retained for the previous sales delivery.
 * The current loans application is validated by tests/loans_smoke.cjs instead.
 * Developer checks only: users opening Nicolas.html need just their browser.
 * node tests/offline_smoke.cjs /path/Nicolas.html (or the delivered ZIP)
 * Uses only an extracted/copied temporary file and disposable browser profiles.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const source = path.resolve(process.argv[2] || "/workspace/nicolas-privado.html");
const password = "Clave privada Nicolas 2026!";
const productName = 'Café, edición "especial" privada';
const clientName = "María Privada López";
const network = [], pageErrors = [];
let context, directory, checks = 0;

async function check(label, operation) {
  assert.deepEqual(pageErrors, [], "JavaScript errors before check");
  await operation();
  assert.deepEqual(pageErrors, [], `JavaScript error: ${label}`);
  console.log(`✓ ${label}`); checks++;
}
async function request(page, endpoint, method = "GET", body) {
  return page.evaluate(({ endpoint, method, body }) => window.NicolasStore.request(endpoint,
    { method, ...(body === undefined ? {} : { body }) }), { endpoint, method, body });
}
async function rejectedRequest(page, endpoint, method = "GET", body) {
  return page.evaluate(async ({ endpoint, method, body }) => {
    try { await window.NicolasStore.request(endpoint, { method, ...(body === undefined ? {} : { body }) }); return { rejected: false }; }
    catch (error) { return { rejected: true, message: error.message, status: error.status }; }
  }, { endpoint, method, body });
}
async function product(page, overrides = {}) {
  return (await request(page, "/products", "POST", { name: "Producto auxiliar", sku: `TEST-${randomUUID()}`,
    price_cents: 1005, stock: 5, min_stock: 1, ...overrides })).product;
}
function saleBody(productId, overrides = {}) {
  return { client_id: null, items: [{ product_id: productId, quantity: 1 }], payment_method: "cash",
    tax_rate: 0, notes: "", request_id: randomUUID(), ...overrides };
}
async function products(page) { return (await request(page, "/products")).products; }
async function snapshot(page) {
  const [catalog, clients, invoices, movements, dashboard] = await Promise.all([
    request(page, "/products"), request(page, "/clients"), request(page, "/invoices"),
    request(page, "/stock-movements"), request(page, "/dashboard"),
  ]);
  return { catalog, clients, invoices, movements, dashboard };
}
async function openBrowser(profile) {
  const browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    acceptDownloads: true, viewport: { width: 1440, height: 1080 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  browser.on("request", (req) => { if (!/^(file:|data:|blob:|about:)/.test(req.url())) network.push(req.url()); });
  await browser.route(/^https?:/, (route) => route.abort("internetdisconnected"));
  const track = (page) => page.on("pageerror", (error) => pageErrors.push(error.stack || String(error)));
  browser.on("page", track); browser.pages().forEach(track);
  await browser.addInitScript(() => { window.print = () => { window.top.__printCalls = (window.top.__printCalls || 0) + 1; }; });
  return browser;
}
async function waitReady(page) { await page.waitForFunction(() => window.NicolasStore && window.NicolasStore.status); }
async function readPersistedData(page) {
  return page.evaluate(async () => {
    const records = [];
    for (const metadata of await indexedDB.databases()) {
      if (!metadata.name) continue;
      const db = await new Promise((resolve, reject) => {
        const opening = indexedDB.open(metadata.name);
        opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
      });
      for (const name of db.objectStoreNames) {
        const values = await new Promise((resolve, reject) => {
          const getting = db.transaction(name).objectStore(name).getAll();
          getting.onsuccess = () => resolve(getting.result); getting.onerror = () => reject(getting.error);
        });
        records.push({ database: metadata.name, store: name, values });
      }
      db.close();
    }
    return JSON.stringify({ records, localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } });
  });
}
async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport && dimensions.body <= dimensions.viewport, JSON.stringify(dimensions));
}
async function findHtml(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await findHtml(path.join(root, entry.name)));
    else if (/\.html$/i.test(entry.name)) files.push(path.join(root, entry.name));
  }
  return files;
}

async function main() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "nicolas-offline-test-"));
  let html = path.join(directory, "Nicolas privado.html");
  if (/\.zip$/i.test(source)) {
    const extracted = path.join(directory, "zip-extraido");
    execFileSync("unzip", ["-q", source, "-d", extracted]);
    const candidates = await findHtml(extracted);
    assert.equal(candidates.length, 1, "ZIP must contain exactly one standalone HTML");
    html = candidates[0];
    console.log(`ZIP extraído y probado: ${path.relative(extracted, html)}`);
  } else await fs.copyFile(source, html);
  const url = pathToFileURL(html).href, profile = path.join(directory, "browser-profile");
  context = await openBrowser(profile);
  let page = context.pages()[0] || await context.newPage();
  await page.goto(url); await waitReady(page);
  await check("El archivo abre sin servidor y pide crear una contraseña", async () => {
    await page.locator("#privacy-gate").waitFor({ state: "visible" });
    assert.equal((await rejectedRequest(page, "/products")).rejected, true);
  });
  await check("Crear contraseña con confirmación abre el panel vacío", async () => {
    await page.locator("#privacy-password").fill(password);
    await page.locator("#privacy-password-repeat").fill("Confirmación diferente");
    await page.locator("#privacy-access-form").evaluate((form) => form.requestSubmit());
    await page.locator("#privacy-access-error").waitFor({ state: "visible" });
    assert.equal((await rejectedRequest(page, "/products")).rejected, true);
    await page.locator("#privacy-password-repeat").fill(password);
    await page.locator("#privacy-access-form").evaluate((form) => form.requestSubmit());
    await page.locator("#privacy-gate").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#dashboard-stats")?.textContent.includes("Productos"));
    assert.deepEqual(await products(page), []);
  });
  await check("Alta real de un producto y un cliente desde los formularios", async () => {
    await page.locator('.main-nav [data-view="products"]').click(); await page.locator("#add-product").click();
    await page.locator('#product-form [name="name"]').fill(productName);
    await page.locator('#product-form [name="sku"]').fill("CAFÉ-PRIVADO");
    await page.locator('#product-form [name="price"]').fill("10.05");
    await page.locator('#product-form [name="stock"]').fill("9");
    await page.locator('#product-form [name="min_stock"]').fill("1");
    await page.locator('button[form="product-form"]').click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    await page.locator("#products-body").getByText(productName, { exact: true }).waitFor();
    await page.locator('.main-nav [data-view="clients"]').click(); await page.locator("#add-client").click();
    await page.locator('#client-form [name="name"]').fill(clientName);
    await page.locator('#client-form [name="document"]').fill("32123456");
    await page.locator('#client-form [name="email"]').fill("privado@example.com");
    await page.locator('button[form="client-form"]').click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    await page.locator("#clients-body").getByText(clientName, { exact: true }).waitFor();
  });
  const p = (await products(page))[0], client = (await request(page, "/clients")).clients[0];
  await check("Venta desde la interfaz: IVA 10,5%, redondeo y stock", async () => {
    await page.locator('.page-actions [data-action="new-sale"]').click();
    await page.locator(`[data-action="add-cart"][data-id="${p.id}"]`).click();
    await page.locator(`[data-cart-quantity="${p.id}"]`).fill("3");
    await page.locator(`[data-cart-quantity="${p.id}"]`).press("Tab");
    await page.locator('#sale-form [name="client_id"]').selectOption(String(client.id));
    await page.locator("#sale-tax").selectOption("10.5");
    await page.locator('button[form="sale-form"]').click(); await page.locator(".receipt").waitFor();
    const invoice = (await request(page, "/invoices")).invoices[0];
    assert.equal(invoice.subtotal_cents, 3015); assert.equal(invoice.tax_cents, 317); assert.equal(invoice.total_cents, 3332);
    assert.equal((await products(page))[0].stock, 6);
  });
  const invoiceId = (await request(page, "/invoices")).invoices[0].id;
  await check("Imprimir/PDF crea comprobante autónomo sin recursos externos", async () => {
    await page.locator('[data-action="print-invoice"]').click(); await page.waitForFunction(() => window.__printCalls > 0);
    const frame = page.locator('iframe[title="Imprimir comprobante"]'); assert.equal(await frame.count(), 1);
    const markup = await frame.getAttribute("srcdoc");
    assert.ok(markup.includes("Comprobante de venta")); assert.ok(!/<link\b[^>]*stylesheet/i.test(markup));
    assert.ok(markup.includes(productName.replaceAll('"', "&quot;")));
    await page.locator('[data-action="close-modal"]').last().click();
  });
  await check("Ventas guardan una copia del nombre y del precio original", async () => {
    await request(page, `/products/${p.id}`, "PUT", { name: "Producto modificado", sku: p.sku, price_cents: 5000, min_stock: 1 });
    await request(page, `/clients/${client.id}`, "PUT", { name: "Cliente modificado", document: "99999999" });
    const invoice = (await request(page, `/invoices/${invoiceId}`)).invoice;
    assert.equal(invoice.items[0].product_name, productName); assert.equal(invoice.items[0].unit_price_cents, 1005);
    assert.equal(invoice.client_name, clientName); assert.equal(invoice.client_document, "32123456");
  });
  await check("Anular dos veces devuelve el stock una sola vez", async () => {
    await request(page, `/invoices/${invoiceId}/cancel`, "POST", {});
    await request(page, `/invoices/${invoiceId}/cancel`, "POST", {}).catch((error) => assert.match(error.message, /anulad|cancel|409/i));
    assert.equal((await products(page)).find((item) => item.id === p.id).stock, 9);
    const movements = (await request(page, "/stock-movements")).movements.filter((item) => item.invoice_id === invoiceId);
    assert.deepEqual(movements.map((item) => item.quantity).sort((a, b) => a - b), [-3, 3]);
  });
  await check("IVA 21% y reintento de venta: un comprobante y un descuento", async () => {
    const item = await product(page, { name: "IVA veintiuno", stock: 5 });
    const body = saleBody(item.id, { items: [{ product_id: item.id, quantity: 2 }], tax_rate: 21 });
    const first = (await request(page, "/invoices", "POST", body)).invoice, repeat = (await request(page, "/invoices", "POST", body)).invoice;
    assert.equal(first.id, repeat.id); assert.equal(first.total_cents, 2432); assert.equal(first.tax_cents, 422);
    assert.equal((await products(page)).find((row) => row.id === item.id).stock, 3);
    assert.equal((await rejectedRequest(page, "/invoices", "POST", { ...body, notes: "Otro contenido" })).rejected, true);
  });
  await check("Una venta con stock insuficiente no deja cambios parciales", async () => {
    const first = await product(page, { stock: 4 }), second = await product(page, { stock: 1 }), before = await snapshot(page);
    const body = saleBody(first.id, { items: [{ product_id: first.id, quantity: 2 }, { product_id: second.id, quantity: 2 }] });
    assert.equal((await rejectedRequest(page, "/invoices", "POST", body)).rejected, true); assert.deepEqual(await snapshot(page), before);
  });
  await check("Cantidades, precios y tipos inválidos no modifican el inventario", async () => {
    const before = await snapshot(page);
    for (const invalid of [{ price_cents: true }, { price_cents: -1 }, { price_cents: 1.5 }, { stock: true }, { stock: -1 }, { stock: 1.5 }, { min_stock: -1 }]) {
      assert.equal((await rejectedRequest(page, "/products", "POST", { name: "Inválido", sku: randomUUID(), price_cents: 100, stock: 1, min_stock: 0, ...invalid })).rejected, true);
    }
    for (const quantity of [true, 0, -1, 1.5]) assert.equal((await rejectedRequest(page, "/invoices", "POST", saleBody(p.id, { items: [{ product_id: p.id, quantity }] }))).rejected, true);
    assert.deepEqual(await snapshot(page), before);
  });
  await check("Los códigos repetidos se rechazan sin archivar el producto existente", async () => {
    const before = await snapshot(page);
    assert.equal((await rejectedRequest(page, "/products", "POST", { name: "SKU duplicado", sku: p.sku.toLowerCase(), price_cents: 100, stock: 1, min_stock: 0 })).rejected, true);
    assert.deepEqual(await snapshot(page), before);
  });
  await check("Dos pestañas no pueden vender la última unidad simultáneamente", async () => {
    const item = await product(page, { stock: 1, name: "Última unidad" }), second = await context.newPage();
    await second.goto(url); await waitReady(second); await second.evaluate((secret) => window.NicolasStore.unlock(secret), password);
    const repeatedItem = await product(page, { stock: 5, name: "Reintento entre pestañas" });
    const repeatedBody = saleBody(repeatedItem.id, { items: [{ product_id: repeatedItem.id, quantity: 2 }] });
    const repeated = await Promise.all([page, second].map((tab) => request(tab, "/invoices", "POST", repeatedBody)));
    assert.equal(repeated[0].invoice.id, repeated[1].invoice.id); assert.equal((await products(page)).find((row) => row.id === repeatedItem.id).stock, 3);
    const results = await Promise.all([page, second].map((tab) => tab.evaluate(async (body) => {
      try { return { ok: true, value: await window.NicolasStore.request("/invoices", { method: "POST", body }) }; }
      catch (error) { return { ok: false, message: error.message }; }
    }, saleBody(item.id))));
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal((await products(page)).find((row) => row.id === item.id).stock, 0); await second.close();
  });
  await check("IndexedDB y almacenamientos no contienen datos ni contraseña en claro", async () => {
    const stored = await readPersistedData(page); assert.ok(stored.includes("records"));
    for (const secret of [productName, clientName, "Producto modificado", "Cliente modificado", password]) assert.ok(!stored.includes(secret), `Unencrypted data: ${secret}`);
  });
  await backupChecks(page);
  // Rechecking identical files after packaging need not repeat the large-data
  // stress case; the default always runs it for a changed implementation.
  if (process.env.NICOLAS_SKIP_LARGE !== "1") await largeBackupCheck(page, url);
  await check("CSV se descarga mediante Blob sin servidor", async () => {
    await page.evaluate(() => { if (typeof refresh === "function") return refresh(); });
    await page.locator('.main-nav [data-view="products"]').click();
    const downloading = page.waitForEvent("download"); await page.locator('#view-products a[download]').click();
    const download = await downloading, csvPath = path.join(directory, "products.csv"); await download.saveAs(csvPath);
    const csv = await fs.readFile(csvPath, "utf8"); assert.ok(csv.includes("Producto modificado")); assert.ok(csv.split(/\r?\n/).length >= 3);
  });
  await check("Diseño a 390 píxeles sin desborde horizontal", async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await page.locator("#nav-toggle").click(); await page.locator('.main-nav [data-view="dashboard"]').click(); await noOverflow(page);
  });
  await check("Cerrar el navegador conserva datos y vuelve a pedir contraseña", async () => {
    const before = await snapshot(page); await context.close(); context = await openBrowser(profile);
    page = context.pages()[0] || await context.newPage(); await page.goto(url); await waitReady(page);
    await page.locator("#privacy-gate").waitFor({ state: "visible" }); assert.equal((await rejectedRequest(page, "/products")).rejected, true);
    await page.locator("#privacy-password").fill("Contraseña equivocada");
    await page.locator("#privacy-access-form").evaluate((form) => form.requestSubmit());
    await page.locator("#privacy-access-error").waitFor({ state: "visible" }); assert.equal((await rejectedRequest(page, "/products")).rejected, true);
    await page.locator("#privacy-password").fill(password); await page.locator("#privacy-access-form").evaluate((form) => form.requestSubmit());
    await page.locator("#privacy-gate").waitFor({ state: "hidden" }); assert.deepEqual(await snapshot(page), before);
  });
  await check("Todo funciona sin peticiones de red ni errores JavaScript", async () => { assert.deepEqual(network, []); assert.deepEqual(pageErrors, []); });
  console.log(`\n${checks} comprobaciones correctas. Original y datos de usuario intactos.`);
}

// Generate authenticated encrypted input with invalid/large decrypted data.
// This exercises the production validator after successful AES authentication.
async function encryptedFixture(page, backup, mode) {
  return page.evaluate(async ({ backup, password, mode }) => {
    const envelope = JSON.parse(backup), encoder = new TextEncoder();
    const bytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const toBase64 = (value) => { let encoded = ""; for (let offset = 0; offset < value.length; offset += 32768) encoded += String.fromCharCode(...value.subarray(offset, offset + 32768)); return btoa(encoded); };
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: bytes(envelope.kdf.salt) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const additionalData = encoder.encode(JSON.stringify({ version: envelope.version, type: envelope.type, vault_id: envelope.vault_id, revision: envelope.revision, created_at: envelope.created_at, updated_at: envelope.updated_at, kdf: { name: envelope.kdf.name, hash: envelope.kdf.hash, iterations: envelope.kdf.iterations, salt: envelope.kdf.salt } }));
    let data;
    if (mode === "large") data = { schema_version: 1, seq: { product: 0, client: 6000, invoice: 0, movement: 0 }, products: [], clients: Array.from({ length: 6000 }, (_, index) => ({ id: index + 1, name: `Cliente ${String(index + 1).padStart(6, "0")}`.padEnd(250, "a"), document: "1".repeat(250), email: `${"c".repeat(235)}@example.com`, phone: "2".repeat(250), address: "Dirección ".padEnd(500, "z"), active: true })), invoices: [], movements: [] };
    else {
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(envelope.cipher.iv), additionalData }, key, bytes(envelope.cipher.data));
      data = JSON.parse(new TextDecoder().decode(plaintext)); data.products[0].stock = -100;
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, encoder.encode(JSON.stringify(data)));
    envelope.cipher.iv = toBase64(iv); envelope.cipher.data = toBase64(new Uint8Array(encrypted)); return JSON.stringify(envelope);
  }, { backup, password, mode });
}
async function backupChecks(page) {
  const before = await snapshot(page); let backup, backupFile;
  await check("Copia descargada: JSON cifrado sin datos personales", async () => {
    const downloading = page.waitForEvent("download"); await page.locator('[data-private-action="backup"]').click();
    const download = await downloading; backupFile = path.join(directory, "copia-cifrada.json"); await download.saveAs(backupFile);
    backup = await fs.readFile(backupFile, "utf8"); const envelope = JSON.parse(backup);
    assert.equal(envelope.type, "nicolas-sales-backup"); assert.equal(envelope.cipher.name, "AES-GCM");
    assert.equal(envelope.kdf.name, "PBKDF2"); assert.ok(envelope.kdf.iterations >= 310000);
    for (const secret of [productName, clientName, "Producto modificado", "Cliente modificado", password]) assert.ok(!backup.includes(secret));
  });
  await check("Contraseña errónea y copia alterada no cambian datos", async () => {
    const tampered = JSON.parse(backup); tampered.cipher.data = (tampered.cipher.data[0] === "A" ? "B" : "A") + tampered.cipher.data.slice(1);
    const results = await page.evaluate(async ({ backup, tampered, password }) => {
      const outcomes = [];
      for (const [source, secret] of [[backup, "Contraseña equivocada"], [tampered, password]]) {
        for (const method of ["inspectBackup", "restoreBackup"]) { try { await window.NicolasStore[method](source, secret); outcomes.push(false); } catch (_) { outcomes.push(true); } }
      }
      return outcomes;
    }, { backup, tampered: JSON.stringify(tampered), password });
    assert.deepEqual(results, [true, true, true, true]); assert.deepEqual(await snapshot(page), before);
  });
  await check("Un JSON cifrado válido con esquema inválido no modifica registros", async () => {
    const invalid = await encryptedFixture(page, backup, "invalid");
    const result = await page.evaluate(async ({ invalid, password }) => {
      const rejected = [];
      for (const method of ["inspectBackup", "restoreBackup"]) { try { await window.NicolasStore[method](invalid, password); rejected.push(false); } catch (_) { rejected.push(true); } }
      return rejected;
    }, { invalid, password });
    assert.deepEqual(result, [true, true]); assert.deepEqual(await snapshot(page), before);
  });
  await check("Restaurar exige revisar, respaldar y confirmar el reemplazo", async () => {
    const extra = await product(page, { name: "Producto posterior a la copia", stock: 7 }), modified = await snapshot(page);
    await page.locator('.privacy-toolbar [data-private-action="restore"]').click(); await page.locator("#privacy-modal").waitFor({ state: "visible" });
    await page.locator("#privacy-backup-file").setInputFiles(backupFile); await page.locator("#privacy-backup-password").fill("Contraseña equivocada");
    await page.locator("#privacy-inspect").click(); await page.locator("#privacy-restore-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#privacy-backup-preview").isVisible(), false); assert.deepEqual(await snapshot(page), modified);
    await page.locator("#privacy-backup-password").fill(password); await page.locator("#privacy-inspect").click(); await page.locator("#privacy-backup-preview").waitFor({ state: "visible" });
    assert.equal(await page.locator("#privacy-products-count").textContent(), String(before.catalog.products.length));
    assert.match(await page.locator("#privacy-replace-note").textContent(), /reemplazar/i); assert.equal(await page.locator("#privacy-confirm-restore").isDisabled(), true);
    await page.locator("#privacy-confirm-replace").check(); assert.equal(await page.locator("#privacy-confirm-restore").isDisabled(), true);
    assert.ok((await products(page)).some((row) => row.id === extra.id));
    const downloading = page.waitForEvent("download"); await page.locator("#privacy-save-before-restore").click();
    await (await downloading).saveAs(path.join(directory, "copia-antes-de-restaurar.json"));
    await page.waitForFunction(() => !document.getElementById("privacy-confirm-restore").disabled);
    await page.locator("#privacy-confirm-restore").click(); await page.locator("#privacy-modal").waitFor({ state: "hidden" }); assert.deepEqual(await snapshot(page), before);
  });
  await check("Bloquear elimina acceso y exige contraseña otra vez", async () => {
    await page.locator('[data-private-action="lock"]').click(); await page.locator("#privacy-gate").waitFor({ state: "visible" });
    assert.equal((await rejectedRequest(page, "/products")).rejected, true);
    assert.equal(await page.locator(".app-shell").evaluate((element) => element.hidden && element.inert), true);
    assert.equal(await page.locator("#privacy-password").inputValue(), "");
    await page.locator("#privacy-password").fill(password); await page.locator("#privacy-access-form").evaluate((form) => form.requestSubmit());
    await page.locator("#privacy-gate").waitFor({ state: "hidden" }); assert.deepEqual(await snapshot(page), before);
  });
}
async function largeBackupCheck(page, url) {
  await check("Copia válida con más de 8 MB de Base64 importa y abre sin pérdida", async () => {
    const backup = await page.evaluate(() => window.NicolasStore.exportBackup()), large = await encryptedFixture(page, backup, "large");
    assert.ok(JSON.parse(large).cipher.data.length > 8 * 1024 * 1024);
    const isolated = await openBrowser(path.join(directory, "large-backup-profile"));
    try {
      // Exercise the store without rendering 6000 unrelated client rows.
      await isolated.addInitScript(() => window.addEventListener("nicolas:unlocked", (event) => event.stopImmediatePropagation()));
      const other = isolated.pages()[0] || await isolated.newPage(); await other.goto(url); await waitReady(other);
      const summary = await other.evaluate(({ large, password }) => window.NicolasStore.inspectBackup(large, password), { large, password }); assert.equal(summary.clients_count, 6000);
      await other.evaluate(({ large, password }) => window.NicolasStore.restoreBackup(large, password), { large, password });
      assert.equal(await other.evaluate(async () => (await window.NicolasStore.request("/clients")).clients.length), 6000);
      const exported = await other.evaluate(() => window.NicolasStore.exportBackup()); assert.equal(JSON.parse(exported).cipher.data.length, JSON.parse(large).cipher.data.length);
      await other.evaluate(() => window.NicolasStore.lock()); await other.evaluate((secret) => window.NicolasStore.unlock(secret), password);
      assert.equal(await other.evaluate(async () => (await window.NicolasStore.request("/clients")).clients.length), 6000);
    } finally { await isolated.close(); }
  });
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close(); if (directory) await fs.rm(directory, { recursive: true, force: true });
});
