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
  async function decrypt(envelope, key, token) {
    validateEnvelope(envelope); checkGeneration(token); let plaintext;
    try {
      plaintext = tracked(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(envelope.cipher.iv, 12), additionalData: aad(envelope), tagLength: 128 }, key, unbase64(envelope.cipher.data, MAX_BACKUP_BYTES, 16))));
      checkGeneration(token); let data;
      try { data = JSON.parse(decoder.decode(plaintext)); } catch (_) { fail("La copia descifrada contiene datos dañados."); }
      validateData(data); return data;
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
  function emptyData() { return { schema_version: 1, seq: { product: 0, client: 0, invoice: 0, movement: 0 }, products: [], clients: [], invoices: [], movements: [] }; }
  function checkArray(value, max, label) { if (!Array.isArray(value) || value.length > max) fail(`La copia contiene una lista de ${label} no válida.`); }
  function uniqueIDs(records, label) {
    const ids = new Set();
    for (const record of records) { int(record.id, 1, MAX_ID, `ID de ${label}`); if (ids.has(record.id)) fail(`La copia contiene IDs de ${label} repetidos.`); ids.add(record.id); }
    return ids;
  }
  function taxAmount(subtotal, rate) { return Number((BigInt(subtotal) * BigInt(Math.round(rate * 100)) + 5000n) / 10000n); }
  function safeSum(a, b, label, max = Number.MAX_SAFE_INTEGER) { const result = a + b; if (!Number.isSafeInteger(result) || result < 0 || result > max) fail(`El importe de ${label} supera el máximo permitido.`); return result; }
  function validateData(data) {
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
  async function loadSession(token) {
    const active = checkSession(token), envelope = await readEnvelope(); checkSession(token);
    if (!envelope || descriptor(envelope) !== active.descriptor) { lock(); fail("Los datos o la contraseña cambiaron en otra pestaña. Volvé a desbloquear el sistema.", 409); }
    return { envelope, data: await decrypt(envelope, active.key, token), active };
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
      if (serialized.length > 1048576) fail("La petición supera el tamaño máximo permitido.", 413);
      body = JSON.parse(serialized);
      const invoiceInput = path === "/invoices" && method === "POST" ? await normalizedInvoice(body) : null;
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
    const token = generation; return schedule(async () => { const { envelope } = await loadSession(token); checkSession(token); return JSON.stringify(envelope, null, 2); });
  }
  function inspectBackup(source, password) {
    const token = generation;
    return schedule(async () => {
      checkGeneration(token); const envelope = parseEnvelope(source), key = await derive(password, envelope.kdf, token), data = await decrypt(envelope, key, token); checkGeneration(token);
      return { products_count: data.products.length, clients_count: data.clients.length, invoices_count: data.invoices.length, created_at: envelope.created_at, updated_at: envelope.updated_at };
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
      return { restored: true, products_count: data.products.length, clients_count: data.clients.length, invoices_count: data.invoices.length };
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
