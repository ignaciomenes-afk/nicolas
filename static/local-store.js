/* Nicolás Ventas: encrypted, local-only persistence. No network or plaintext storage. */
(function () {
  "use strict";
  const DB_NAME = "nicolas-private-sales-v1", STORE = "vaults", PRIMARY = "primary";
  const TYPE = "nicolas-sales-backup", ITERATIONS = 310000;
  const MAX_MONEY = 1000000000000, MAX_QUANTITY = 1000000, MAX_ID = Number.MAX_SAFE_INTEGER - 1;
  const MAX_BACKUP_BYTES = 64 * 1024 * 1024, MAX_RECORDS = 100000, MAX_MOVEMENTS = 500000;
  const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
  let databasePromise = null, session = null, generation = 0, queue = Promise.resolve();
  const transactions = new Set(), buffers = new Set();

  function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
  const lockedMessage = "El sistema está bloqueado. Ingresá tu contraseña para continuar.";
  const databaseMessage = "No se puede guardar en este navegador. Abrí el archivo en Chrome o Edge, en modo normal (no incógnito), y permití el almacenamiento local.";
  function checkFeatures() {
    if (!globalThis.indexedDB) fail(databaseMessage, 503);
    if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) fail("Este navegador no permite el cifrado seguro. Abrí el archivo con una versión actual de Chrome o Edge.", 503);
  }
  function schedule(task) { const result = queue.then(task); queue = result.catch(() => {}); return result; }
  function checkGeneration(token) { if (generation !== token) fail(lockedMessage, 401); }
  function checkSession(token) { checkGeneration(token); if (!session) fail(lockedMessage, 401); return session; }
  function notify(name) { window.dispatchEvent(new CustomEvent(name)); }
  function lock() {
    generation += 1; session = null;
    for (const tx of transactions) { try { tx.abort(); } catch (_) {} }
    for (const buffer of buffers) buffer.fill(0);
    buffers.clear(); notify("nicolas:locked");
  }
  function tracked(bytes) { buffers.add(bytes); return bytes; }
  function clearBytes(bytes) { if (bytes) { bytes.fill(0); buffers.delete(bytes); } }
  function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
  function exactObject(value, keys, label) {
    if (!plainObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`La copia contiene ${label} con un formato no válido.`);
    if (Object.keys(value).some(key => ["__proto__", "prototype", "constructor"].includes(key))) fail("La copia contiene campos no permitidos.");
  }
  function int(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(`El campo ${label} debe ser un entero entre ${min} y ${max}.`); return value; }
  function text(value, label, max = 250, required = false) {
    if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim())) fail(`El campo ${label} no es válido${required ? " o está vacío" : ""}.`);
    return value;
  }
  function field(body, key, fallback = "", max = 250, required = false) {
    const value = Object.hasOwn(body, key) ? body[key] : fallback;
    if (typeof value !== "string") fail(`El campo ${key} debe ser texto.`);
    return text(value.trim(), key, max, required);
  }
  function numberField(body, key, fallback, min = 0, max = MAX_QUANTITY) { return int(Object.hasOwn(body, key) ? body[key] : fallback, min, max, key); }
  function dateValue(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail("La copia contiene una fecha no válida.");
    if (new Date(value).toISOString().replace(/\.000Z$/, "Z") !== value.replace(/\.000Z$/, "Z")) fail("La copia contiene una fecha no válida.");
    return value;
  }
  function now() { return new Date().toISOString(); }
  function uuid() {
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(n => n.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function validUUID(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
  function base64(bytes) {
    let string = "";
    for (let i = 0; i < bytes.length; i += 32768) string += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(string);
  }
  function unbase64(value, maximum, minimum = 0) {
    // A repeated regex group can overflow V8's stack for large, valid backups.
    if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail("La copia cifrada no tiene un formato válido.");
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const byteLength = value.length / 4 * 3 - padding;
    if (byteLength < minimum || byteLength > maximum) fail("La copia cifrada tiene un tamaño no válido.");
    if (padding) {
      const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value[value.length - padding - 1]);
      if (last < 0 || (padding === 2 ? last & 15 : last & 3)) fail("La copia cifrada no tiene un formato válido.");
    }
    let binary;
    try { binary = atob(value); } catch (_) { fail("La copia cifrada no tiene un formato válido."); }
    if (binary.length < minimum || binary.length > maximum) fail("La copia cifrada tiene un tamaño no válido.");
    const result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
    return result;
  }
  function validateEnvelope(value) {
    exactObject(value, ["version", "type", "vault_id", "revision", "created_at", "updated_at", "kdf", "cipher"], "un encabezado");
    if (value.version !== 1 || value.type !== TYPE || !validUUID(value.vault_id)) fail("Este archivo no es una copia compatible de Nicolás Ventas.");
    int(value.revision, 1, MAX_ID, "revisión"); dateValue(value.created_at); dateValue(value.updated_at);
    exactObject(value.kdf, ["name", "hash", "iterations", "salt"], "parámetros de cifrado");
    if (value.kdf.name !== "PBKDF2" || value.kdf.hash !== "SHA-256") fail("El formato de cifrado no está admitido.");
    int(value.kdf.iterations, ITERATIONS, 2000000, "iteraciones");
    if (unbase64(value.kdf.salt, 16, 16).length !== 16) fail("La sal de cifrado no es válida.");
    exactObject(value.cipher, ["name", "iv", "data"], "datos cifrados");
    if (value.cipher.name !== "AES-GCM" || unbase64(value.cipher.iv, 12, 12).length !== 12) fail("El formato de cifrado no está admitido.");
    unbase64(value.cipher.data, MAX_BACKUP_BYTES, 16);
    return value;
  }
  function parseEnvelope(source) {
    if (typeof source !== "string" || source.length > MAX_BACKUP_BYTES * 1.4 || source.length < 100) fail("La copia tiene un tamaño no válido.");
    let result;
    try { result = JSON.parse(source); } catch (_) { fail("El archivo no contiene una copia JSON válida."); }
    return validateEnvelope(result);
  }
  function descriptor(value) { return `${value.vault_id}|${value.kdf.name}|${value.kdf.hash}|${value.kdf.iterations}|${value.kdf.salt}`; }
  function aad(value) {
    return encoder.encode(JSON.stringify({ version: value.version, type: value.type, vault_id: value.vault_id, revision: value.revision, created_at: value.created_at, updated_at: value.updated_at, kdf: { name: value.kdf.name, hash: value.kdf.hash, iterations: value.kdf.iterations, salt: value.kdf.salt } }));
  }
  function passwordValue(password, creating = false) {
    if (typeof password !== "string" || !password.length || password.length > 1024) fail("Ingresá una contraseña válida.");
    if (creating && password.length < 8) fail("La contraseña debe tener al menos 8 caracteres.");
  }
  async function derive(password, kdf, token) {
    passwordValue(password);
    const bytes = tracked(encoder.encode(password)); let material;
    try { material = await crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey"]); }
    finally { clearBytes(bytes); }
    checkGeneration(token);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations, salt: unbase64(kdf.salt, 16, 16) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    checkGeneration(token); return key;
  }
  async function encrypt(data, key, metadata, token) {
    checkGeneration(token);
    const plaintext = tracked(encoder.encode(JSON.stringify(data)));
    if (plaintext.length > MAX_BACKUP_BYTES - 16) { clearBytes(plaintext); fail("El archivo de datos supera el tamaño permitido."); }
    const envelope = { version: 1, type: TYPE, vault_id: metadata.vault_id, revision: metadata.revision, created_at: metadata.created_at, updated_at: now(), kdf: { ...metadata.kdf }, cipher: { name: "AES-GCM", iv: base64(crypto.getRandomValues(new Uint8Array(12))), data: "" } };
    let ciphertext;
    try { ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: unbase64(envelope.cipher.iv, 12), additionalData: aad(envelope), tagLength: 128 }, key, plaintext); }
    finally { clearBytes(plaintext); }
    checkGeneration(token); envelope.cipher.data = base64(new Uint8Array(ciphertext)); return envelope;
  }
  async function decrypt(envelope, key, token, migrate = true) {
    validateEnvelope(envelope); checkGeneration(token); let plaintext;
    try {
      plaintext = tracked(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(envelope.cipher.iv, 12), additionalData: aad(envelope), tagLength: 128 }, key, unbase64(envelope.cipher.data, MAX_BACKUP_BYTES, 16))));
      checkGeneration(token); let data;
      try { data = JSON.parse(decoder.decode(plaintext)); } catch (_) { fail("La copia descifrada contiene datos dañados."); }
      validateData(data); return migrate ? migrateData(data) : data;
    } catch (error) {
      checkGeneration(token); if (error.status) throw error;
      fail("Contraseña incorrecta o archivo de datos dañado. Tus datos guardados no se modificaron.", 401);
    } finally { clearBytes(plaintext); }
  }
  async function database() {
    checkFeatures();
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(DB_NAME, 1); } catch (_) { reject(new Error(databaseMessage)); return; }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); databasePromise = null; lock(); }; resolve(db); };
      request.onerror = () => { databasePromise = null; reject(new Error(databaseMessage)); };
      request.onblocked = () => { databasePromise = null; reject(new Error("Cerrá las otras pestañas de Nicolás Ventas y volvé a abrir el archivo.")); };
    });
    return databasePromise;
  }
  async function readEnvelope() {
    const db = await database();
    return new Promise((resolve, reject) => {
      let tx, value;
      try { tx = db.transaction(STORE, "readonly"); const request = tx.objectStore(STORE).get(PRIMARY); request.onsuccess = () => { value = request.result; }; }
      catch (_) { reject(new Error(databaseMessage)); return; }
      tx.oncomplete = () => { try { resolve(value === undefined ? null : validateEnvelope(value)); } catch (error) { reject(error); } };
      tx.onabort = tx.onerror = () => reject(new Error(databaseMessage));
    });
  }
  async function compareAndSave(expected, next, token) {
    const db = await database(); checkGeneration(token);
    return new Promise((resolve, reject) => {
      let tx, conflict = false, reason = null;
      try { tx = db.transaction(STORE, "readwrite"); } catch (_) { reject(new Error(databaseMessage)); return; }
      transactions.add(tx);
      const request = tx.objectStore(STORE).get(PRIMARY);
      request.onsuccess = () => {
        try {
          checkGeneration(token); const current = request.result ?? null;
          if (current) validateEnvelope(current);
          if ((expected === null && current !== null) || (expected !== null && (current === null || current.revision !== expected.revision || descriptor(current) !== descriptor(expected) || current.cipher.data !== expected.cipher.data))) { conflict = true; tx.abort(); return; }
          tx.objectStore(STORE).put(next, PRIMARY);
        } catch (error) { reason = error; tx.abort(); }
      };
      tx.oncomplete = () => { transactions.delete(tx); try { checkGeneration(token); resolve(true); } catch (error) { reject(error); } };
      tx.onabort = () => {
        transactions.delete(tx);
        if (reason) reject(reason);
        else if (generation !== token) reject(Object.assign(new Error(lockedMessage), { status: 401 }));
        else if (conflict) resolve(false);
        else reject(new Error(tx.error?.name === "QuotaExceededError" ? "El navegador se quedó sin espacio. Descargá una copia de seguridad y liberá espacio antes de continuar." : databaseMessage));
      };
      tx.onerror = () => {};
    });
  }
  function defaultSettings() { return { lender_name: "", lender_document: "", lender_phone: "", lender_address: "", city: "", reminder_days: 3 }; }
  function emptyData() { return { schema_version: 2, seq: { product: 0, client: 0, invoice: 0, movement: 0, loan: 0, payment: 0 }, products: [], clients: [], invoices: [], movements: [], settings: defaultSettings(), loans: [], payments: [] }; }
  function migrateData(data) {
    if (data.schema_version === 1) { data.schema_version = 2; data.seq.loan = 0; data.seq.payment = 0; data.settings = defaultSettings(); data.loans = []; data.payments = []; }
    return data;
  }
  function checkArray(value, max, label) { if (!Array.isArray(value) || value.length > max) fail(`La copia contiene una lista de ${label} no válida.`); }
  function uniqueIDs(records, label) {
    const ids = new Set();
    for (const record of records) { int(record.id, 1, MAX_ID, `ID de ${label}`); if (ids.has(record.id)) fail(`La copia contiene IDs de ${label} repetidos.`); ids.add(record.id); }
    return ids;
  }
  function taxAmount(subtotal, rate) { return Number((BigInt(subtotal) * BigInt(Math.round(rate * 100)) + 5000n) / 10000n); }
  function safeSum(a, b, label, max = Number.MAX_SAFE_INTEGER) { const result = a + b; if (!Number.isSafeInteger(result) || result < 0 || result > max) fail(`El importe de ${label} supera el máximo permitido.`); return result; }
  function validateLegacyData(data) {
    exactObject(data, ["schema_version", "seq", "products", "clients", "invoices", "movements"], "datos");
    if (data.schema_version !== 1) fail("La versión de los datos no es compatible.");
    exactObject(data.seq, ["product", "client", "invoice", "movement"], "secuencias");
    checkArray(data.products, MAX_RECORDS, "productos"); checkArray(data.clients, MAX_RECORDS, "clientes"); checkArray(data.invoices, MAX_RECORDS, "ventas"); checkArray(data.movements, MAX_MOVEMENTS, "movimientos");
    const productIds = uniqueIDs(data.products, "productos"), clientIds = uniqueIDs(data.clients, "clientes"); uniqueIDs(data.invoices, "ventas"); uniqueIDs(data.movements, "movimientos");
    for (const [key, rows] of [["product", data.products], ["client", data.clients], ["invoice", data.invoices], ["movement", data.movements]]) {
      int(data.seq[key], 0, MAX_ID, `secuencia ${key}`);
      if (rows.some(row => row.id > data.seq[key])) fail("La copia contiene secuencias incompatibles con sus registros.");
    }
    const skus = new Set(), stockTotals = new Map(), invoiceMap = new Map(), movementSales = new Map(), movementCancels = new Map();
    for (const product of data.products) {
      exactObject(product, ["id", "name", "sku", "price_cents", "stock", "min_stock", "active"], "un producto");
      text(product.name, "name", 250, true); text(product.sku, "sku", 80); int(product.price_cents, 0, MAX_MONEY, "price_cents"); int(product.stock, 0, MAX_QUANTITY, "stock"); int(product.min_stock, 0, MAX_QUANTITY, "min_stock");
      if (typeof product.active !== "boolean") fail("La copia contiene un estado de producto no válido.");
      if (product.sku) { const sku = product.sku.toLocaleLowerCase("es"); if (skus.has(sku)) fail("La copia contiene códigos SKU repetidos."); skus.add(sku); }
      stockTotals.set(product.id, 0);
    }
    for (const client of data.clients) {
      exactObject(client, ["id", "name", "document", "email", "phone", "address", "active"], "un cliente");
      text(client.name, "name", 250, true); for (const field of ["document", "email", "phone", "address"]) text(client[field], field, field === "address" ? 500 : 250);
      if (typeof client.active !== "boolean") fail("La copia contiene un estado de cliente no válido.");
    }
    const requests = new Set();
    for (const invoice of data.invoices) {
      exactObject(invoice, ["id", "number", "client_id", "client_name", "client_document", "client_address", "created_at", "status", "payment_method", "subtotal_cents", "tax_rate", "tax_cents", "total_cents", "notes", "request_id", "request_hash", "items"], "una venta");
      if (invoice.number !== `V-${String(invoice.id).padStart(6, "0")}`) fail("La copia contiene una numeración de venta no válida.");
      if (invoice.client_id !== null && !clientIds.has(invoice.client_id)) fail("La copia contiene una venta con un cliente inexistente.");
      text(invoice.client_name, "client_name", 250, true); text(invoice.client_document, "client_document", 250); text(invoice.client_address, "client_address", 500); text(invoice.notes, "notes", 2000); dateValue(invoice.created_at);
      if (!["paid", "cancelled"].includes(invoice.status) || !["cash", "card", "transfer"].includes(invoice.payment_method) || ![0, 10.5, 21].includes(invoice.tax_rate)) fail("La copia contiene datos de venta no válidos.");
      if (!validUUID(invoice.request_id) || invoice.request_id !== invoice.request_id.toLowerCase() || requests.has(invoice.request_id) || !/^[0-9a-f]{64}$/.test(invoice.request_hash)) fail("La copia contiene identificadores de operación no válidos.");
      requests.add(invoice.request_id);
      for (const field of ["subtotal_cents", "tax_cents", "total_cents"]) int(invoice[field], 0, MAX_MONEY, field);
      checkArray(invoice.items, 500, "renglones de venta"); if (!invoice.items.length) fail("La copia contiene una venta sin productos.");
      const itemProducts = new Set(); let subtotal = 0;
      for (const item of invoice.items) {
        exactObject(item, ["product_id", "product_name", "sku", "quantity", "unit_price_cents", "total_cents"], "un renglón de venta");
        if (!productIds.has(item.product_id) || itemProducts.has(item.product_id)) fail("La copia contiene referencias de producto no válidas.");
        itemProducts.add(item.product_id); text(item.product_name, "product_name", 250, true); text(item.sku, "sku", 80); int(item.quantity, 1, MAX_QUANTITY, "quantity"); int(item.unit_price_cents, 0, MAX_MONEY, "unit_price_cents"); int(item.total_cents, 0, MAX_MONEY, "total_cents");
        if (BigInt(item.unit_price_cents) * BigInt(item.quantity) !== BigInt(item.total_cents)) fail("Los importes de los renglones de la copia no coinciden.");
        subtotal = safeSum(subtotal, item.total_cents, "la venta", MAX_MONEY);
      }
      if (subtotal !== invoice.subtotal_cents || invoice.tax_cents !== taxAmount(subtotal, invoice.tax_rate) || invoice.total_cents !== subtotal + invoice.tax_cents) fail("Los importes y el IVA de la copia no coinciden.");
      invoiceMap.set(invoice.id, invoice);
    }
    for (const movement of [...data.movements].sort((a, b) => a.id - b.id)) {
      exactObject(movement, ["id", "product_id", "product_name", "quantity", "reason", "created_at", "invoice_id"], "un movimiento");
      if (!productIds.has(movement.product_id)) fail("La copia contiene un movimiento de un producto inexistente.");
      text(movement.product_name, "product_name", 250, true); text(movement.reason, "reason", 500, true); dateValue(movement.created_at); int(movement.quantity, -MAX_QUANTITY, MAX_QUANTITY, "quantity");
      if (!movement.quantity) fail("La copia contiene un movimiento sin cantidad.");
      const runningStock = stockTotals.get(movement.product_id) + movement.quantity;
      if (!Number.isSafeInteger(runningStock) || runningStock < 0 || runningStock > MAX_QUANTITY) fail("El historial de stock de la copia no es coherente.");
      stockTotals.set(movement.product_id, runningStock);
      if (movement.invoice_id !== null) {
        const invoice = invoiceMap.get(movement.invoice_id), item = invoice?.items.find(item => item.product_id === movement.product_id);
        if (!item || Math.abs(movement.quantity) !== item.quantity) fail("La copia contiene movimientos incompatibles con las ventas.");
        const key = `${movement.invoice_id}:${movement.product_id}`, map = movement.quantity < 0 ? movementSales : movementCancels;
        if (map.has(key) || (movement.quantity > 0 && invoice.status !== "cancelled")) fail("La copia contiene movimientos de venta repetidos o inválidos.");
        map.set(key, movement);
        if (movement.reason !== `${movement.quantity < 0 ? "Venta" : "Anulación"} ${invoice.number}`) fail("La copia contiene un motivo de movimiento incompatible.");
      }
    }
    for (const product of data.products) if (stockTotals.get(product.id) !== product.stock) fail("El stock guardado no coincide con su historial.");
    for (const invoice of data.invoices) for (const item of invoice.items) {
      const key = `${invoice.id}:${item.product_id}`;
      if (!movementSales.has(key) || (invoice.status === "cancelled" && !movementCancels.has(key))) fail("La copia contiene ventas sin sus movimientos de stock.");
      if (movementCancels.has(key) && movementSales.get(key).id >= movementCancels.get(key).id) fail("La anulación de una venta tiene un orden no válido.");
    }
    return data;
  }
  // Loans use integer cents throughout. Payment allocations are derived by active payment ID,
  // oldest installment first, interest before principal; reversals therefore recompute later allocations.
  function calendarDate(value, label = "fecha") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`El campo ${label} debe tener formato AAAA-MM-DD.`);
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8));
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) fail(`El campo ${label} contiene una fecha inexistente.`);
    return value;
  }
  function daysInMonth(year, month) { const date = new Date(0); date.setUTCFullYear(year, month, 0); date.setUTCHours(12, 0, 0, 0); return date.getUTCDate(); }
  function addMonths(value, count, anchor = Number(value.slice(8))) {
    const index = Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1 + count, year = Math.floor(index / 12), month = index % 12 + 1;
    if (year < 1 || year > 9999) fail("El plazo genera vencimientos fuera del rango de fechas permitido.");
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(anchor, daysInMonth(year, month))).padStart(2, "0")}`;
  }
  function periodInterest(principal, rate) { return Number((BigInt(principal) * BigInt(rate) + 5000n) / 10000n); }
  function loanPreview(body, stored = false) {
    const principal = numberField(body, "principal_cents", undefined, 1, MAX_MONEY), rate = numberField(body, "monthly_rate_bps", undefined, 0, 100000), months = numberField(body, "term_months", undefined, 1, 120);
    const automatic = body.first_due_date === undefined || body.first_due_date === null || body.first_due_date === "";
    const issued = calendarDate(body.issued_date, "issued_date"), defaultDue = addMonths(issued, 1), firstDue = calendarDate(automatic ? defaultDue : body.first_due_date, "first_due_date");
    if (firstDue <= issued) fail("El primer vencimiento debe ser posterior a la fecha de emisión.");
    const method = body.interest_method ?? "flat", plan = body.payment_plan ?? "installments";
    if (!["flat", "declining"].includes(method)) fail("El método de interés debe ser flat o declining.");
    if (!["installments", "interest_only", "single"].includes(plan)) fail("El plan de pago no es válido.");
    const anchor = stored ? int(body.due_anchor_day, 1, 31, "due_anchor_day") : automatic ? Number(issued.slice(8)) : Number(firstDue.slice(8)), installments = [];
    if (stored && anchor !== Number(firstDue.slice(8)) && !(firstDue === defaultDue && anchor === Number(issued.slice(8)))) fail("El día de vencimiento no coincide con las fechas del préstamo.");
    const regularPrincipal = Math.floor(principal / months); let remaining = principal, interest = 0;
    for (let index = 0; index < months; index++) {
      const principalPart = plan === "installments" ? (index === months - 1 ? remaining : regularPrincipal) : (index === months - 1 ? principal : 0);
      const interestPart = periodInterest(method === "flat" ? principal : remaining, rate);
      interest = safeSum(interest, interestPart, "los intereses", MAX_MONEY);
      const total = safeSum(principalPart, interestPart, "la cuota", MAX_MONEY);
      installments.push({ number: index + 1, due_date: addMonths(firstDue, index, anchor), principal_cents: principalPart, interest_cents: interestPart, total_cents: total });
      remaining -= principalPart;
    }
    const total = safeSum(principal, interest, "el préstamo", MAX_MONEY);
    const schedule = plan === "single" ? [{ number: 1, due_date: installments[months - 1].due_date, principal_cents: principal, interest_cents: interest, total_cents: total }] : installments;
    return { principal_cents: principal, monthly_rate_bps: rate, term_months: months, issued_date: issued, first_due_date: firstDue, due_anchor_day: anchor, interest_method: method, payment_plan: plan, interest_cents: interest, total_cents: total, installment_count: schedule.length, installments: schedule };
  }
  function validateSettings(settings) {
    exactObject(settings, ["lender_name", "lender_document", "lender_phone", "lender_address", "city", "reminder_days"], "configuración");
    for (const key of ["lender_name", "lender_document", "lender_phone", "lender_address", "city"]) text(settings[key], key, key === "lender_address" ? 500 : 250);
    int(settings.reminder_days, 0, 30, "reminder_days"); return settings;
  }
  function saveSettings(data, body) {
    const merged = { ...data.settings, ...body }, settings = {};
    for (const key of ["lender_name", "lender_document", "lender_phone", "lender_address", "city"]) settings[key] = field(merged, key, "", key === "lender_address" ? 500 : 250);
    settings.reminder_days = numberField(merged, "reminder_days", 3, 0, 30); data.settings = validateSettings(settings); return { settings: { ...settings } };
  }
  function validateAttachment(attachment) {
    if (attachment === null) return null;
    exactObject(attachment, ["name", "type", "data"], "un adjunto de pagaré"); text(attachment.name, "nombre del adjunto", 250, true);
    if (!/[.]pdf$/i.test(attachment.name) && !/[.](?:png|jpe?g)$/i.test(attachment.name)) fail("El adjunto debe tener extensión PDF, PNG o JPG.");
    if (!["application/pdf", "image/png", "image/jpeg"].includes(attachment.type)) fail("Solo se permiten documentos PDF o imágenes PNG/JPG.");
    const bytes = unbase64(attachment.data, 5 * 1024 * 1024, 8);
    const pdf = bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70 && bytes[4] === 45;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const valid = (attachment.type === "application/pdf" && pdf && /[.]pdf$/i.test(attachment.name)) || (attachment.type === "image/png" && png && /[.]png$/i.test(attachment.name)) || (attachment.type === "image/jpeg" && jpeg && /[.]jpe?g$/i.test(attachment.name));
    if (!valid) fail("El contenido del adjunto no coincide con su tipo de archivo.");
    return attachment;
  }
  function validateNote(note, issuedDate) {
    exactObject(note, ["signed", "signed_date", "attachment"], "un pagaré");
    if (typeof note.signed !== "boolean") fail("El estado de firma no es válido.");
    if (note.signed) { calendarDate(note.signed_date, "signed_date"); if (note.signed_date < issuedDate) fail("La firma no puede ser anterior a la emisión."); if (note.signed_date > localDate(now())) fail("La fecha de firma no puede ser futura."); }
    else if (note.signed_date !== "") fail("Un pagaré sin firma no debe tener fecha de firma.");
    validateAttachment(note.attachment); return note;
  }
  function paymentAllocation(data, loan) {
    const balances = loan.installments.map(item => ({ principal: item.principal_cents, interest: item.interest_cents })), allocations = new Map();
    let paid = 0, principalPaid = 0, interestPaid = 0;
    for (const payment of data.payments.filter(payment => payment.loan_id === loan.id && payment.status === "active").sort((a, b) => a.id - b.id)) {
      let remaining = payment.amount_cents, principalPart = 0, interestPart = 0; const parts = [];
      for (let index = 0; index < balances.length && remaining > 0; index++) {
        const balance = balances[index], interest = Math.min(remaining, balance.interest); remaining -= interest; balance.interest -= interest;
        const principal = Math.min(remaining, balance.principal); remaining -= principal; balance.principal -= principal;
        if (interest || principal) parts.push({ installment_number: loan.installments[index].number, principal_cents: principal, interest_cents: interest });
        interestPart += interest; principalPart += principal;
      }
      if (remaining) fail("Los cobros guardados superan el saldo del préstamo.");
      paid = safeSum(paid, payment.amount_cents, "los cobros del préstamo", MAX_MONEY); principalPaid += principalPart; interestPaid += interestPart;
      allocations.set(payment.id, { allocations: parts, principal_cents: principalPart, interest_cents: interestPart });
    }
    return { balances, allocations, paid, principalPaid, interestPaid };
  }
  function loanResult(data, loan) {
    const today = localDate(now()), calculated = paymentAllocation(data, loan), result = { ...loan };
    delete result.request_hash; delete result.cancelled;
    result.lender = { ...loan.lender }; result.note = { ...loan.note, attachment: loan.note.attachment ? { ...loan.note.attachment } : null };
    result.installment_count = loan.installments.length;
    result.installments = loan.installments.map((item, index) => {
      const balance = calculated.balances[index].principal + calculated.balances[index].interest, paid = item.total_cents - balance;
      return { ...item, paid_cents: paid, balance_cents: balance, status: balance === 0 ? "paid" : item.due_date < today ? "overdue" : paid ? "partial" : "pending" };
    });
    Object.assign(result, { status: loan.cancelled ? "cancelled" : calculated.paid === loan.total_cents ? "paid" : "active", paid_cents: calculated.paid, principal_paid_cents: calculated.principalPaid, interest_paid_cents: calculated.interestPaid, balance_cents: loan.cancelled ? 0 : loan.total_cents - calculated.paid, principal_balance_cents: loan.cancelled ? 0 : loan.principal_cents - calculated.principalPaid, next_due_date: loan.cancelled ? null : result.installments.find(item => item.balance_cents > 0)?.due_date || null });
    return result;
  }
  function paymentResult(data, payment) {
    const loan = data.loans.find(loan => loan.id === payment.loan_id), result = { ...payment }; delete result.request_hash;
    const allocation = payment.status === "active" ? paymentAllocation(data, loan).allocations.get(payment.id) : { allocations: [], principal_cents: 0, interest_cents: 0 };
    return { ...result, ...allocation };
  }
  function findLoan(data, id) { const loan = data.loans.find(loan => loan.id === id); if (!loan) fail("No se encontró el préstamo.", 404); return loan; }
  function findPayment(data, id) { const payment = data.payments.find(payment => payment.id === id); if (!payment) fail("No se encontró el cobro.", 404); return payment; }
  async function hashRequest(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
  async function normalizedLoan(body) {
    const preview = loanPreview(body), clientId = numberField(body, "client_id", undefined, 1, MAX_ID), notes = field(body, "notes", "", 2000), requestId = field(body, "request_id", "", 80, true).toLowerCase();
    if (!validUUID(requestId)) fail("request_id debe ser un UUID válido.");
    const request = { client_id: clientId, principal_cents: preview.principal_cents, monthly_rate_bps: preview.monthly_rate_bps, term_months: preview.term_months, issued_date: preview.issued_date, first_due_date: preview.first_due_date, due_anchor_day: preview.due_anchor_day, interest_method: preview.interest_method, payment_plan: preview.payment_plan, notes };
    return { request, requestId, preview, hash: await hashRequest(request) };
  }
  function createLoan(data, normalized) {
    const { request, requestId, preview, hash } = normalized, existing = data.loans.find(loan => loan.request_id === requestId);
    if (existing) { if (existing.request_hash !== hash) fail("Ese identificador ya se usó para otro préstamo.", 409); return { loan: loanResult(data, existing) }; }
    if (request.issued_date > localDate(now())) fail("La fecha de emisión de un préstamo registrado no puede ser futura.");
    requireRoom(data.loans, "préstamos"); const client = activeClient(data, request.client_id), settings = data.settings, id = nextID(data, "loan");
    const loan = { id, number: `P-${String(id).padStart(6, "0")}`, client_id: client.id, client_name: client.name, client_document: client.document, client_phone: client.phone, client_email: client.email, client_address: client.address, lender: { name: settings.lender_name, document: settings.lender_document, phone: settings.lender_phone, address: settings.lender_address, city: settings.city }, created_at: now(), principal_cents: preview.principal_cents, monthly_rate_bps: preview.monthly_rate_bps, term_months: preview.term_months, issued_date: preview.issued_date, first_due_date: preview.first_due_date, due_anchor_day: preview.due_anchor_day, interest_method: preview.interest_method, payment_plan: preview.payment_plan, interest_cents: preview.interest_cents, total_cents: preview.total_cents, notes: request.notes, cancelled: false, cancel_reason: "", cancelled_at: "", request_id: requestId, request_hash: hash, installments: preview.installments.map(item => ({ ...item })), note: { signed: false, signed_date: "", attachment: null } };
    data.loans.push(loan); return { loan: loanResult(data, loan) };
  }
  function saveLoanNote(data, id, body) {
    const loan = findLoan(data, id); if (typeof body.signed !== "boolean") fail("Indicá si el pagaré está firmado.");
    const note = { signed: body.signed, signed_date: body.signed ? field(body, "signed_date", "", 10, true) : "", attachment: Object.hasOwn(body, "attachment") ? body.attachment : loan.note.attachment };
    validateNote(note, loan.issued_date); loan.note = note; return { loan: loanResult(data, loan) };
  }
  function cancelLoan(data, id, body) {
    const loan = findLoan(data, id); if (loan.cancelled) return { loan: loanResult(data, loan) };
    if (data.payments.some(payment => payment.loan_id === id && payment.status === "active")) fail("Revertí los cobros activos antes de cancelar este préstamo.", 409);
    loan.cancel_reason = field(body, "reason", "", 500, true); loan.cancelled_at = now(); loan.cancelled = true; return { loan: loanResult(data, loan) };
  }
  async function normalizedPayment(body) {
    const request = { loan_id: numberField(body, "loan_id", undefined, 1, MAX_ID), amount_cents: numberField(body, "amount_cents", undefined, 1, MAX_MONEY), paid_date: calendarDate(body.paid_date, "paid_date"), method: field(body, "method", "", 30, true), notes: field(body, "notes", "", 2000) };
    if (!["cash", "transfer", "card"].includes(request.method)) fail("El medio de cobro debe ser cash, transfer o card.");
    const requestId = field(body, "request_id", "", 80, true).toLowerCase(); if (!validUUID(requestId)) fail("request_id debe ser un UUID válido.");
    return { request, requestId, hash: await hashRequest(request) };
  }
  function createPayment(data, normalized) {
    const { request, requestId, hash } = normalized, existing = data.payments.find(payment => payment.request_id === requestId);
    if (existing) { if (existing.request_hash !== hash) fail("Ese identificador ya se usó para otro cobro.", 409); return { payment: paymentResult(data, existing), loan: loanResult(data, findLoan(data, existing.loan_id)) }; }
    requireRoom(data.payments, "cobros"); const loan = findLoan(data, request.loan_id), result = loanResult(data, loan);
    if (loan.cancelled) fail("No se puede cobrar un préstamo cancelado.", 409);
    if (request.paid_date < loan.issued_date) fail("La fecha del cobro no puede ser anterior a la emisión.");
    if (request.paid_date > localDate(now())) fail("La fecha del cobro no puede ser futura.");
    if (request.amount_cents > result.balance_cents) fail("El cobro supera el saldo pendiente del préstamo.", 409);
    const id = nextID(data, "payment"), payment = { id, number: `C-${String(id).padStart(6, "0")}`, loan_id: loan.id, loan_number: loan.number, client_id: loan.client_id, client_name: loan.client_name, client_document: loan.client_document, client_phone: loan.client_phone, amount_cents: request.amount_cents, paid_date: request.paid_date, method: request.method, notes: request.notes, created_at: now(), request_id: requestId, request_hash: hash, status: "active", reversal_reason: "", reversed_at: "" };
    data.payments.push(payment); return { payment: paymentResult(data, payment), loan: loanResult(data, loan) };
  }
  function reversePayment(data, id, body) {
    const payment = findPayment(data, id), loan = findLoan(data, payment.loan_id);
    if (payment.status !== "reversed") { payment.reversal_reason = field(body, "reason", "", 500, true); payment.reversed_at = now(); payment.status = "reversed"; }
    return { payment: paymentResult(data, payment), loan: loanResult(data, loan) };
  }
  function validateData(data) {
    if (data?.schema_version === 1) return validateLegacyData(data);
    exactObject(data, ["schema_version", "seq", "products", "clients", "invoices", "movements", "settings", "loans", "payments"], "datos");
    if (data.schema_version !== 2) fail("La versión de los datos no es compatible.");
    exactObject(data.seq, ["product", "client", "invoice", "movement", "loan", "payment"], "secuencias");
    validateLegacyData({ schema_version: 1, seq: { product: data.seq.product, client: data.seq.client, invoice: data.seq.invoice, movement: data.seq.movement }, products: data.products, clients: data.clients, invoices: data.invoices, movements: data.movements });
    validateSettings(data.settings); checkArray(data.loans, MAX_RECORDS, "préstamos"); checkArray(data.payments, MAX_RECORDS, "cobros");
    uniqueIDs(data.loans, "préstamos"); uniqueIDs(data.payments, "cobros");
    for (const [key, rows] of [["loan", data.loans], ["payment", data.payments]]) { int(data.seq[key], 0, MAX_ID, `secuencia ${key}`); if (rows.some(row => row.id > data.seq[key])) fail("Las secuencias de la copia no coinciden con sus registros."); }
    const clientIds = new Set(data.clients.map(client => client.id)), loanRequests = new Set(), paymentRequests = new Set();
    for (const loan of data.loans) {
      exactObject(loan, ["id", "number", "client_id", "client_name", "client_document", "client_phone", "client_email", "client_address", "lender", "created_at", "principal_cents", "monthly_rate_bps", "term_months", "issued_date", "first_due_date", "due_anchor_day", "interest_method", "payment_plan", "interest_cents", "total_cents", "notes", "cancelled", "cancel_reason", "cancelled_at", "request_id", "request_hash", "installments", "note"], "un préstamo");
      if (loan.number !== `P-${String(loan.id).padStart(6, "0")}` || !clientIds.has(loan.client_id)) fail("La numeración o el cliente de un préstamo no es válido.");
      for (const key of ["client_name", "client_document", "client_phone", "client_email", "client_address"]) text(loan[key], key, key === "client_address" ? 500 : 250, key === "client_name");
      exactObject(loan.lender, ["name", "document", "phone", "address", "city"], "datos del prestamista"); for (const key of ["name", "document", "phone", "address", "city"]) text(loan.lender[key], key, key === "address" ? 500 : 250);
      dateValue(loan.created_at); text(loan.notes, "notes", 2000); text(loan.cancel_reason, "cancel_reason", 500);
      if (typeof loan.cancelled !== "boolean") fail("El estado del préstamo no es válido.");
      if (loan.cancelled) { dateValue(loan.cancelled_at); text(loan.cancel_reason, "cancel_reason", 500, true); } else if (loan.cancelled_at !== "" || loan.cancel_reason !== "") fail("Un préstamo activo contiene datos de cancelación.");
      if (!validUUID(loan.request_id) || loan.request_id !== loan.request_id.toLowerCase() || loanRequests.has(loan.request_id) || !/^[0-9a-f]{64}$/.test(loan.request_hash)) fail("Los identificadores de un préstamo no son válidos."); loanRequests.add(loan.request_id);
      const preview = loanPreview(loan, true); if (loan.issued_date > localDate(now())) fail("La copia contiene un préstamo con emisión futura."); int(loan.interest_cents, 0, MAX_MONEY, "interest_cents"); int(loan.total_cents, 1, MAX_MONEY, "total_cents");
      if (loan.interest_cents !== preview.interest_cents || loan.total_cents !== preview.total_cents) fail("Los importes del préstamo no coinciden con su cálculo.");
      checkArray(loan.installments, 120, "cuotas"); if (loan.installments.length !== preview.installments.length) fail("La cantidad de cuotas es incompatible con el préstamo.");
      for (let index = 0; index < loan.installments.length; index++) { const item = loan.installments[index]; exactObject(item, ["number", "due_date", "principal_cents", "interest_cents", "total_cents"], "una cuota"); for (const key of Object.keys(item)) if (item[key] !== preview.installments[index][key]) fail("El cronograma de la copia no coincide con las condiciones del préstamo."); }
      validateNote(loan.note, loan.issued_date);
    }
    for (const payment of data.payments) {
      exactObject(payment, ["id", "number", "loan_id", "loan_number", "client_id", "client_name", "client_document", "client_phone", "amount_cents", "paid_date", "method", "notes", "created_at", "request_id", "request_hash", "status", "reversal_reason", "reversed_at"], "un cobro");
      const loan = data.loans.find(loan => loan.id === payment.loan_id); if (!loan || payment.number !== `C-${String(payment.id).padStart(6, "0")}` || payment.loan_number !== loan.number || payment.client_id !== loan.client_id || payment.client_name !== loan.client_name || payment.client_document !== loan.client_document || payment.client_phone !== loan.client_phone) fail("Las referencias o los datos del cliente de un cobro no coinciden.");
      int(payment.amount_cents, 1, MAX_MONEY, "amount_cents"); calendarDate(payment.paid_date, "paid_date"); if (payment.paid_date < loan.issued_date || payment.paid_date > localDate(now())) fail("La copia contiene un cobro con fecha anterior a la emisión o futura.");
      if (!["cash", "transfer", "card"].includes(payment.method) || !["active", "reversed"].includes(payment.status)) fail("El medio o el estado de un cobro no es válido.");
      if (loan.cancelled && payment.status === "active") fail("Un préstamo cancelado contiene cobros activos.");
      dateValue(payment.created_at); text(payment.notes, "notes", 2000); text(payment.reversal_reason, "reversal_reason", 500);
      if (payment.status === "reversed") { dateValue(payment.reversed_at); text(payment.reversal_reason, "reversal_reason", 500, true); } else if (payment.reversed_at !== "" || payment.reversal_reason !== "") fail("Un cobro activo contiene datos de reversión.");
      if (!validUUID(payment.request_id) || payment.request_id !== payment.request_id.toLowerCase() || paymentRequests.has(payment.request_id) || !/^[0-9a-f]{64}$/.test(payment.request_hash)) fail("Los identificadores de un cobro no son válidos."); paymentRequests.add(payment.request_id);
    }
    for (const loan of data.loans) paymentAllocation(data, loan);
    return data;
  }
  function loanDashboard(data) {
    const today = localDate(now()), limitDate = new Date(`${today}T12:00:00Z`); limitDate.setUTCDate(limitDate.getUTCDate() + data.settings.reminder_days); const limit = limitDate.toISOString().slice(0, 10), upcoming = [];
    let capital = 0, receivable = 0, interest = 0, collected = 0, disbursed = 0, active = 0, overdue = 0, overdueCount = 0, dueToday = 0;
    for (const loan of data.loans) {
      const result = loanResult(data, loan); if (loan.cancelled) continue;
      if (loan.issued_date.slice(0, 7) === today.slice(0, 7)) disbursed = safeSum(disbursed, loan.principal_cents, "el capital desembolsado");
      if (result.status === "active") { active++; capital = safeSum(capital, result.principal_balance_cents, "el capital pendiente"); receivable = safeSum(receivable, result.balance_cents, "el saldo a cobrar"); }
      for (const item of result.installments) if (item.balance_cents > 0) {
        if (item.due_date < today) { overdue = safeSum(overdue, item.balance_cents, "los vencidos"); overdueCount++; }
        if (item.due_date === today) dueToday = safeSum(dueToday, item.balance_cents, "los vencimientos de hoy");
        if (item.due_date <= limit) upcoming.push({ loan_id: loan.id, loan_number: loan.number, client_name: loan.client_name, client_phone: loan.client_phone, installment_number: item.number, due_date: item.due_date, balance_cents: item.balance_cents, days_overdue: Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${item.due_date}T12:00:00Z`)) / 86400000)) });
      }
    }
    for (const payment of data.payments) if (payment.status === "active" && payment.paid_date.slice(0, 7) === today.slice(0, 7)) { collected = safeSum(collected, payment.amount_cents, "los cobros del mes"); interest = safeSum(interest, paymentResult(data, payment).interest_cents, "los intereses cobrados"); }
    upcoming.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.loan_id - b.loan_id || a.installment_number - b.installment_number);
    return { capital_outstanding_cents: capital, total_receivable_cents: receivable, interest_collected_month_cents: interest, collected_month_cents: collected, disbursed_month_cents: disbursed, active_loans_count: active, clients_count: data.clients.filter(client => client.active).length, overdue_cents: overdue, overdue_count: overdueCount, due_today_cents: dueToday, upcoming, recent_payments: data.payments.slice().sort((a, b) => b.id - a.id).slice(0, 8).map(payment => paymentResult(data, payment)) };
  }
  function ledger(data) {
    const entries = [];
    for (const loan of data.loans) if (!loan.cancelled) entries.push({ date: loan.issued_date, type: "disbursement", number: loan.number, client_name: loan.client_name, description: `Entrega de capital ${loan.number}`, debit_cents: loan.principal_cents, credit_cents: 0, balance_cents: 0, principal_cents: loan.principal_cents, interest_cents: 0, _id: loan.id });
    for (const payment of data.payments) if (payment.status === "active") { const calculated = paymentResult(data, payment); entries.push({ date: payment.paid_date, type: "payment", number: payment.number, client_name: payment.client_name, description: `Cobro de ${payment.loan_number}`, debit_cents: 0, credit_cents: payment.amount_cents, balance_cents: 0, principal_cents: calculated.principal_cents, interest_cents: calculated.interest_cents, _id: payment.id }); }
    entries.sort((a, b) => a.date.localeCompare(b.date) || (a.type !== b.type ? a.type === "disbursement" ? -1 : 1 : a._id - b._id));
    let balance = 0; for (const entry of entries) { balance += entry.credit_cents - entry.debit_cents; if (!Number.isSafeInteger(balance)) fail("El saldo del libro supera el máximo permitido."); entry.balance_cents = balance; delete entry._id; }
    return { entries };
  }
  function loansCsv(data, kind) {
    let rows, filename;
    if (kind === "loans") { filename = "prestamos.csv"; rows = [["Número", "Cliente", "Emisión", "Capital (centavos)", "Tasa mensual (%)", "Meses", "Interés (centavos)", "Total (centavos)", "Cobrado (centavos)", "Saldo (centavos)", "Estado", "Próximo vencimiento"], ...data.loans.map(loan => { const value = loanResult(data, loan); return [value.number, value.client_name, value.issued_date, value.principal_cents, value.monthly_rate_bps / 100, value.term_months, value.interest_cents, value.total_cents, value.paid_cents, value.balance_cents, value.status, value.next_due_date || ""]; })]; }
    else if (kind === "payments") { filename = "cobros.csv"; rows = [["Número", "Préstamo", "Cliente", "Fecha", "Importe (centavos)", "Capital (centavos)", "Interés (centavos)", "Medio", "Estado"], ...data.payments.map(payment => { const value = paymentResult(data, payment); return [value.number, value.loan_number, value.client_name, value.paid_date, value.amount_cents, value.principal_cents, value.interest_cents, value.method, value.status]; })]; }
    else if (kind === "clients") { filename = "clientes.csv"; rows = [["ID", "Cliente", "Documento", "Teléfono", "Correo", "Dirección", "Activo"], ...data.clients.map(client => [client.id, client.name, client.document, client.phone, client.email, client.address, client.active ? 1 : 0])]; }
    else { filename = "libro.csv"; rows = [["Fecha", "Tipo", "Número", "Cliente", "Descripción", "Salida (centavos)", "Entrada (centavos)", "Saldo (centavos)", "Capital (centavos)", "Interés (centavos)"], ...ledger(data).entries.map(entry => [entry.date, entry.type, entry.number, entry.client_name, entry.description, entry.debit_cents, entry.credit_cents, entry.balance_cents, entry.principal_cents, entry.interest_cents])]; }
    return { csv: `\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`, filename };
  }
  async function loadSession(token) {
    const active = checkSession(token), envelope = await readEnvelope(); checkSession(token);
    if (!envelope || descriptor(envelope) !== active.descriptor) { lock(); fail("Los datos o la contraseña cambiaron en otra pestaña. Volvé a desbloquear el sistema.", 409); }
    const data = await decrypt(envelope, active.key, token, false), needsMigration = data.schema_version === 1;
    return { envelope, data: migrateData(data), active, needsMigration };
  }
  async function mutate(operation, token) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const loaded = await loadSession(token), result = await operation(loaded.data);
      checkSession(token); validateData(loaded.data);
      const metadata = { ...loaded.envelope, revision: loaded.envelope.revision + 1 }; int(metadata.revision, 1, MAX_ID, "revisión");
      const next = await encrypt(loaded.data, loaded.active.key, metadata, token);
      if (await compareAndSave(loaded.envelope, next, token)) return result;
    }
    fail("Otra pestaña está modificando los datos. Volvé a intentar la operación.", 409);
  }
  function nextID(data, type) { data.seq[type] = int(data.seq[type] + 1, 1, MAX_ID, "secuencia"); return data.seq[type]; }
  function addMovement(data, product, quantity, reason, invoiceId = null, productName = product.name) {
    if (data.movements.length >= MAX_MOVEMENTS) fail("Se alcanzó el límite de movimientos. Exportá una copia y solicitá una ampliación.");
    data.movements.push({ id: nextID(data, "movement"), product_id: product.id, product_name: productName, quantity, reason, created_at: now(), invoice_id: invoiceId });
  }
  function activeProduct(data, id) { const product = data.products.find(product => product.id === id && product.active); if (!product) fail("No se encontró el producto activo.", 404); return product; }
  function activeClient(data, id) { const client = data.clients.find(client => client.id === id && client.active); if (!client) fail("No se encontró el cliente activo.", 404); return client; }
  function findInvoice(data, id) { const invoice = data.invoices.find(invoice => invoice.id === id); if (!invoice) fail("No se encontró el comprobante.", 404); return invoice; }
  function invoiceResult(invoice, details = true) { const result = { ...invoice }; delete result.request_hash; if (!details) { for (const key of ["items", "client_document", "client_address", "notes", "request_id"]) delete result[key]; } else result.items = invoice.items.map(item => ({ ...item })); return result; }
  function clientResult(client) { const result = { ...client }; delete result.active; return result; }
  function sortNames(a, b) { return a.name.localeCompare(b.name, "es", { sensitivity: "base" }) || a.id - b.id; }
  function ensureSku(data, sku, id = null) { if (sku && data.products.some(product => product.id !== id && product.sku.toLocaleLowerCase("es") === sku.toLocaleLowerCase("es"))) fail("Ya existe un producto con ese código SKU, incluso si está archivado.", 409); }
  function requireRoom(array, label) { if (array.length >= MAX_RECORDS) fail(`Se alcanzó el límite de ${label}. Descargá una copia de seguridad.`); }
  function createProduct(data, body) {
    requireRoom(data.products, "productos");
    const name = field(body, "name", "", 250, true), sku = field(body, "sku", "", 80), price = numberField(body, "price_cents", undefined, 0, MAX_MONEY), stock = numberField(body, "stock", 0), minStock = numberField(body, "min_stock", 0);
    ensureSku(data, sku);
    const product = { id: nextID(data, "product"), name, sku, price_cents: price, stock, min_stock: minStock, active: true };
    data.products.push(product); if (stock) addMovement(data, product, stock, "Stock inicial"); return { product: { ...product } };
  }
  function updateProduct(data, id, body) {
    if (Object.hasOwn(body, "stock")) fail("Para cambiar el stock utiliza el ajuste de inventario.");
    const product = activeProduct(data, id), merged = { ...product, ...body };
    const name = field(merged, "name", "", 250, true), sku = field(merged, "sku", "", 80), price = numberField(merged, "price_cents", undefined, 0, MAX_MONEY), minStock = numberField(merged, "min_stock", undefined);
    ensureSku(data, sku, id); Object.assign(product, { name, sku, price_cents: price, min_stock: minStock }); return { product: { ...product } };
  }
  function adjustStock(data, id, body) {
    const quantity = numberField(body, "quantity", undefined, -MAX_QUANTITY), reason = field(body, "reason", "", 500, true);
    if (!quantity) fail("El ajuste de stock debe ser distinto de cero.");
    const product = activeProduct(data, id), stock = product.stock + quantity;
    if (stock < 0) fail("El ajuste dejaría el stock por debajo de cero.", 409);
    int(stock, 0, MAX_QUANTITY, "stock"); product.stock = stock; addMovement(data, product, quantity, reason); return { product: { ...product } };
  }
  function saveClient(data, id, body) {
    const client = id ? activeClient(data, id) : null, merged = { ...client, ...body };
    if (!client) requireRoom(data.clients, "clientes");
    const values = { name: field(merged, "name", "", 250, true), document: field(merged, "document"), email: field(merged, "email"), phone: field(merged, "phone"), address: field(merged, "address", "", 500) };
    if (client) { Object.assign(client, values); return { client: clientResult(client) }; }
    const created = { id: nextID(data, "client"), ...values, active: true }; data.clients.push(created); return { client: clientResult(created) };
  }
  async function normalizedInvoice(body) {
    const requestId = field(body, "request_id", "", 80, true).toLowerCase(); if (!validUUID(requestId)) fail("request_id debe ser un UUID válido.");
    const clientId = body.client_id ?? null; if (clientId !== null) int(clientId, 1, MAX_ID, "client_id");
    const payment = field(body, "payment_method", "", 250, true); if (!["cash", "card", "transfer"].includes(payment)) fail("El medio de pago debe ser cash, card o transfer.");
    const rate = Object.hasOwn(body, "tax_rate") ? body.tax_rate : 0; if (![0, 10.5, 21].includes(rate)) fail("La alícuota de IVA debe ser 0, 10.5 o 21.");
    const notes = field(body, "notes", "", 2000), items = body.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 500) fail("La venta debe incluir entre 1 y 500 productos.");
    const seen = new Set(), normalized = [];
    for (const item of items) {
      if (!plainObject(item)) fail("Cada producto de la venta debe ser un objeto.");
      const productId = numberField(item, "product_id", undefined, 1, MAX_ID), quantity = numberField(item, "quantity", undefined, 1);
      if (seen.has(productId)) fail("No se puede repetir un producto en la misma venta.");
      seen.add(productId); normalized.push({ product_id: productId, quantity });
    }
    const request = { client_id: clientId, payment_method: payment, tax_rate: rate, notes, items: normalized.slice().sort((a, b) => a.product_id - b.product_id) };
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(request))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return { requestId, request, items: normalized, hash };
  }
  function createInvoice(data, normalized) {
    const { requestId, request, items, hash } = normalized, existing = data.invoices.find(invoice => invoice.request_id === requestId);
    if (existing) { if (existing.request_hash !== hash) fail("Ese identificador de venta ya se utilizó con otros datos.", 409); return { invoice: invoiceResult(existing) }; }
    requireRoom(data.invoices, "ventas");
    const client = request.client_id === null ? null : activeClient(data, request.client_id), snapshots = []; let subtotal = 0;
    for (const item of items) {
      const product = activeProduct(data, item.product_id);
      if (product.stock < item.quantity) fail(`Stock insuficiente para ${product.name}. Disponible: ${product.stock}.`, 409);
      const line = BigInt(product.price_cents) * BigInt(item.quantity); if (line > BigInt(MAX_MONEY)) fail("El importe de la venta supera el máximo permitido.");
      const total = Number(line); subtotal = safeSum(subtotal, total, "la venta", MAX_MONEY);
      snapshots.push({ product_id: product.id, product_name: product.name, sku: product.sku, quantity: item.quantity, unit_price_cents: product.price_cents, total_cents: total });
    }
    const tax = taxAmount(subtotal, request.tax_rate), total = safeSum(subtotal, tax, "la venta", MAX_MONEY), id = nextID(data, "invoice");
    const invoice = { id, number: `V-${String(id).padStart(6, "0")}`, client_id: request.client_id, client_name: client?.name || "Consumidor final", client_document: client?.document || "", client_address: client?.address || "", created_at: now(), status: "paid", payment_method: request.payment_method, subtotal_cents: subtotal, tax_rate: request.tax_rate, tax_cents: tax, total_cents: total, notes: request.notes, request_id: requestId, request_hash: hash, items: snapshots };
    data.invoices.push(invoice);
    for (const item of snapshots) { const product = activeProduct(data, item.product_id); product.stock -= item.quantity; addMovement(data, product, -item.quantity, `Venta ${invoice.number}`, id); }
    return { invoice: invoiceResult(invoice) };
  }
  function cancelInvoice(data, id) {
    const invoice = findInvoice(data, id);
    if (invoice.status !== "cancelled") {
      for (const item of invoice.items) { const product = data.products.find(product => product.id === item.product_id); int(product.stock + item.quantity, 0, MAX_QUANTITY, "stock después de anular"); }
      for (const item of invoice.items) { const product = data.products.find(product => product.id === item.product_id); product.stock += item.quantity; addMovement(data, product, item.quantity, `Anulación ${invoice.number}`, invoice.id, item.product_name); }
      invoice.status = "cancelled";
    }
    return { invoice: invoiceResult(invoice) };
  }
  function localDate(value) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)); const part = type => parts.find(part => part.type === type).value; return `${part("year")}-${part("month")}-${part("day")}`; }
  function dashboard(data) {
    const today = localDate(now()), date = new Date(`${today}T12:00:00Z`), days = [];
    for (let offset = 6; offset >= 0; offset--) { const day = new Date(date); day.setUTCDate(date.getUTCDate() - offset); days.push({ date: day.toISOString().slice(0, 10), total_cents: 0, count: 0 }); }
    let revenue = 0, count = 0;
    for (const invoice of data.invoices) if (invoice.status === "paid") {
      const day = localDate(invoice.created_at);
      if (day.slice(0, 7) === today.slice(0, 7)) { revenue = safeSum(revenue, invoice.total_cents, "las ventas mensuales"); count++; }
      const bucket = days.find(bucket => bucket.date === day); if (bucket) { bucket.total_cents = safeSum(bucket.total_cents, invoice.total_cents, "las ventas diarias"); bucket.count++; }
    }
    return { revenue_month_cents: revenue, sales_month: count, products_count: data.products.filter(product => product.active).length, clients_count: data.clients.filter(client => client.active).length, low_stock: data.products.filter(product => product.active && product.stock <= product.min_stock).sort((a, b) => a.stock - b.stock || sortNames(a, b)).map(product => ({ ...product })), recent_invoices: data.invoices.slice().sort((a, b) => b.id - a.id).slice(0, 5).map(invoice => invoiceResult(invoice, false)), revenue_days: days };
  }
  function csvCell(value) { let string = String(value ?? ""); if (typeof value === "string" && /^[\s]*[=+\-@]/.test(string)) string = `'${string}`; return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string; }
  function csvExport(data, products) {
    const rows = products ? [["ID", "Producto", "SKU", "Precio (centavos)", "Stock", "Stock mínimo", "Activo"], ...data.products.slice().sort((a, b) => a.id - b.id).map(p => [p.id, p.name, p.sku, p.price_cents, p.stock, p.min_stock, p.active ? 1 : 0])] : [["ID", "Número", "Cliente", "Fecha UTC", "Estado", "Medio de pago", "Subtotal (centavos)", "IVA (%)", "IVA (centavos)", "Total (centavos)"], ...data.invoices.slice().sort((a, b) => a.id - b.id).map(i => [i.id, i.number, i.client_name, i.created_at, i.status, i.payment_method, i.subtotal_cents, i.tax_rate, i.tax_cents, i.total_cents])];
    return { csv: `\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`, filename: products ? "productos.csv" : "comprobantes.csv" };
  }
  function parseRoute(path) { if (typeof path !== "string" || path.includes("?") || path.includes("#") || !path.startsWith("/")) fail("La ruta no es válida.", 404); return path.replace(/\/$/, ""); }
  function routeID(value) { if (!/^[1-9]\d*$/.test(value)) fail("El identificador no es válido."); return int(Number(value), 1, MAX_ID, "identificador"); }
  function readRoute(data, path) {
    if (path === "/settings") return { settings: { ...data.settings } };
    if (path === "/loans") return { loans: data.loans.slice().sort((a, b) => b.id - a.id).map(loan => loanResult(data, loan)) };
    const loanMatch = /^\/loans\/([^/]+)$/.exec(path); if (loanMatch) return { loan: loanResult(data, findLoan(data, routeID(loanMatch[1]))) };
    if (path === "/payments") return { payments: data.payments.slice().sort((a, b) => b.id - a.id).map(payment => paymentResult(data, payment)) };
    if (path === "/loan-dashboard") return loanDashboard(data);
    if (path === "/ledger") return ledger(data);
    const csvMatch = /^\/export\/(loans|payments|clients|ledger)\.csv$/.exec(path); if (csvMatch) return loansCsv(data, csvMatch[1]);
    if (path === "/health") return { ok: true };
    if (path === "/products") return { products: data.products.filter(product => product.active).sort(sortNames).map(product => ({ ...product })) };
    if (path === "/clients") return { clients: data.clients.filter(client => client.active).sort(sortNames).map(clientResult) };
    if (path === "/invoices") return { invoices: data.invoices.slice().sort((a, b) => b.id - a.id).map(invoice => invoiceResult(invoice, false)) };
    const match = /^\/invoices\/([^/]+)$/.exec(path); if (match) return { invoice: invoiceResult(findInvoice(data, routeID(match[1]))) };
    if (path === "/stock-movements") return { movements: data.movements.slice().sort((a, b) => b.id - a.id).slice(0, 500).map(movement => ({ ...movement })) };
    if (path === "/dashboard") return dashboard(data);
    if (path === "/export/products.csv" || path === "/export/invoices.csv") return csvExport(data, path.endsWith("products.csv"));
    fail("Ruta no encontrada o método no permitido.", 404);
  }
  function writeRoute(data, path, method, body, invoiceInput) {
    if (path === "/settings" && method === "PUT") return saveSettings(data, body);
    if (path === "/loans" && method === "POST") return createLoan(data, invoiceInput);
    if (path === "/payments" && method === "POST") return createPayment(data, invoiceInput);
    let loanMatch = /^\/loans\/([^/]+)\/(note|cancel)$/.exec(path);
    if (loanMatch && method === "POST") return loanMatch[2] === "note" ? saveLoanNote(data, routeID(loanMatch[1]), body) : cancelLoan(data, routeID(loanMatch[1]), body);
    loanMatch = /^\/payments\/([^/]+)\/reverse$/.exec(path); if (loanMatch && method === "POST") return reversePayment(data, routeID(loanMatch[1]), body);
    if (path === "/products" && method === "POST") return createProduct(data, body);
    if (path === "/clients" && method === "POST") return saveClient(data, null, body);
    if (path === "/invoices" && method === "POST") return createInvoice(data, invoiceInput);
    let match = /^\/products\/([^/]+)(?:\/(stock))?$/.exec(path);
    if (match) {
      const id = routeID(match[1]);
      if (match[2] === "stock" && method === "POST") return adjustStock(data, id, body);
      if (!match[2] && method === "PUT") return updateProduct(data, id, body);
      if (!match[2] && method === "DELETE") { activeProduct(data, id).active = false; return { ok: true }; }
    }
    match = /^\/clients\/([^/]+)$/.exec(path);
    if (match) { const id = routeID(match[1]); if (method === "PUT") return saveClient(data, id, body); if (method === "DELETE") { activeClient(data, id).active = false; return { ok: true }; } }
    match = /^\/invoices\/([^/]+)\/cancel$/.exec(path); if (match && method === "POST") return cancelInvoice(data, routeID(match[1]));
    fail("Ruta no encontrada o método no permitido.", 404);
  }
  function request(path, options = {}) {
    const token = generation;
    return schedule(async () => {
      checkSession(token); path = parseRoute(path); const method = (options.method || "GET").toUpperCase();
      if (method === "GET") { const loaded = await loadSession(token); checkSession(token); return readRoute(loaded.data, path); }
      if (!["POST", "PUT", "DELETE"].includes(method)) fail("Método no permitido.", 405);
      let body = options.body ?? {}; if (!plainObject(body)) fail("El cuerpo debe ser un objeto.");
      let serialized; try { serialized = JSON.stringify(body); } catch (_) { fail("El cuerpo no contiene JSON válido."); }
      const maxBody = /^\/loans\/[1-9]\d*\/note$/.test(path) ? 8 * 1024 * 1024 : 1048576;
      if (serialized.length > maxBody) fail("La petición supera el tamaño máximo permitido.", 413);
      body = JSON.parse(serialized);
      if (path === "/loans/preview" && method === "POST") return { preview: loanPreview(body) };
      const invoiceInput = method === "POST" ? path === "/invoices" ? await normalizedInvoice(body) : path === "/loans" ? await normalizedLoan(body) : path === "/payments" ? await normalizedPayment(body) : null : null;
      checkSession(token); return mutate(data => writeRoute(data, path, method, body, invoiceInput), token);
    });
  }
  async function status() {
    const envelope = await readEnvelope(); if (session && (!envelope || descriptor(envelope) !== session.descriptor)) lock();
    return { exists: envelope !== null, unlocked: session !== null };
  }
  function create(password) {
    const token = generation;
    return schedule(async () => {
      checkGeneration(token); passwordValue(password, true); checkFeatures();
      if (await readEnvelope()) fail("Ya existe información guardada. Desbloqueá el sistema con tu contraseña.", 409);
      const kdf = { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: base64(crypto.getRandomValues(new Uint8Array(16))) }, key = await derive(password, kdf, token);
      const date = now(), envelope = await encrypt(emptyData(), key, { vault_id: uuid(), revision: 1, created_at: date, kdf }, token);
      if (!await compareAndSave(null, envelope, token)) fail("Otra pestaña creó datos. Volvé a abrir y desbloqueá el sistema.", 409);
      checkGeneration(token); session = { key, descriptor: descriptor(envelope) }; notify("nicolas:unlocked"); return { exists: true, unlocked: true };
    });
  }
  function unlock(password) {
    const token = generation;
    return schedule(async () => {
      checkGeneration(token); passwordValue(password);
      const envelope = await readEnvelope(); if (!envelope) fail("Todavía no hay datos guardados. Creá tu acceso privado.", 404);
      const key = await derive(password, envelope.kdf, token); await decrypt(envelope, key, token); checkGeneration(token);
      const latest = await readEnvelope(); checkGeneration(token);
      if (!latest || descriptor(latest) !== descriptor(envelope)) fail("Los datos cambiaron en otra pestaña. Volvé a intentar el acceso.", 409);
      session = { key, descriptor: descriptor(envelope) }; notify("nicolas:unlocked"); return { exists: true, unlocked: true };
    });
  }
  function exportBackup() {
    const token = generation; return schedule(async () => { let loaded = await loadSession(token); if (loaded.needsMigration) { await mutate(() => ({ ok: true }), token); loaded = await loadSession(token); } checkSession(token); return JSON.stringify(loaded.envelope, null, 2); });
  }
  function inspectBackup(source, password) {
    const token = generation;
    return schedule(async () => {
      checkGeneration(token); const envelope = parseEnvelope(source), key = await derive(password, envelope.kdf, token), data = await decrypt(envelope, key, token); checkGeneration(token);
      return { products_count: data.products.length, clients_count: data.clients.length, invoices_count: data.invoices.length, legacy_products_count: data.products.length, legacy_invoices_count: data.invoices.length, loans_count: data.loans.length, payments_count: data.payments.length, created_at: envelope.created_at, updated_at: envelope.updated_at };
    });
  }
  function restoreBackup(source, password) {
    const token = generation;
    return schedule(async () => {
      checkGeneration(token); const backup = parseEnvelope(source), backupKey = await derive(password, backup.kdf, token), data = await decrypt(backup, backupKey, token); checkGeneration(token);
      if (!session) {
        const existing = await readEnvelope(); checkGeneration(token); if (existing) fail("Para reemplazar datos guardados, primero desbloqueá el sistema con tu contraseña actual.", 409);
        const fresh = await encrypt(data, backupKey, { ...backup, vault_id: uuid(), revision: 1, created_at: now() }, token);
        if (!await compareAndSave(null, fresh, token)) fail("Otra pestaña creó datos. Desbloqueá el sistema antes de restaurar.", 409);
        checkGeneration(token); session = { key: backupKey, descriptor: descriptor(fresh) }; notify("nicolas:unlocked");
      } else {
        const { envelope, active } = await loadSession(token), fresh = await encrypt(data, active.key, { ...envelope, revision: envelope.revision + 1 }, token);
        if (!await compareAndSave(envelope, fresh, token)) fail("Otra pestaña modificó datos durante la restauración. Revisá los cambios y volvé a intentar.", 409);
        checkSession(token); notify("nicolas:unlocked");
      }
      return { restored: true, products_count: data.products.length, clients_count: data.clients.length, invoices_count: data.invoices.length, loans_count: data.loans.length, payments_count: data.payments.length };
    });
  }
  function changePassword(currentPassword, newPassword) {
    const token = generation;
    return schedule(async () => {
      passwordValue(newPassword, true);
      const { envelope, data } = await loadSession(token), currentKey = await derive(currentPassword, envelope.kdf, token); await decrypt(envelope, currentKey, token); checkSession(token);
      const kdf = { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: base64(crypto.getRandomValues(new Uint8Array(16))) }, newKey = await derive(newPassword, kdf, token);
      const next = await encrypt(data, newKey, { ...envelope, revision: envelope.revision + 1, kdf }, token);
      if (!await compareAndSave(envelope, next, token)) fail("Otra pestaña cambió los datos. Volvé a intentar el cambio de contraseña.", 409);
      checkSession(token); session = { key: newKey, descriptor: descriptor(next) }; return { ok: true };
    });
  }
  window.NicolasStore = Object.freeze({ status, create, unlock, lock, request, exportBackup, inspectBackup, restoreBackup, changePassword });
})();
