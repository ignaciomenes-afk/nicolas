"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (cents) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format((cents || 0) / 100);
const date = (value, withTime = false) => new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}), timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(value));
const icons = {
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z"/><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5.66"/></svg>',
  sale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 7h6M9 11h6M9 15h3"/></svg>',
  trend: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m3 17 6-6 4 4 8-10M15 5h6v6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5"/></svg>',
  adjust: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 17h16M8 3v8M16 13v8"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 5v14M5 12h14"/></svg>',
};

const state = { products: [], clients: [], invoices: [], movements: [], dashboard: null, view: "dashboard", loaded: false };
const pageInfo = {
  dashboard: ["Resumen", "Una mirada clara a tu negocio."],
  products: ["Productos", "Tu catálogo, tus precios y tu inventario."],
  clients: ["Clientes", "Toda la información de tus clientes, a mano."],
  invoices: ["Ventas", "Cada venta y su comprobante, en un solo lugar."],
  stock: ["Actividad de stock", "El historial de entradas y salidas de tus productos."],
};
let dataGeneration = 0;
let cart = [];
let saleRequestId = "";
let currentReceipt = null;

async function storeStatus() {
  const store = window.NicolasStore;
  if (!store) return null;
  return typeof store.status === "function" ? await store.status() : await store.status;
}
function staleError() { const error = new Error("La sesión se bloqueó. Volvé a ingresar para continuar."); error.sessionChanged = true; return error; }
function checkGeneration(generation) { if (generation !== dataGeneration) throw staleError(); }

async function api(path, options = {}) {
  const generation = dataGeneration;
  let result;
  if (window.NicolasStore) {
    const status = await storeStatus();
    checkGeneration(generation);
    if (!status?.unlocked) throw staleError();
    result = await window.NicolasStore.request(path, options);
  } else {
    let response;
    try {
      response = await fetch(`/api${path}`, { ...options, headers: { "Content-Type": "application/json", ...options.headers }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    } catch { throw new Error("No pudimos conectar con el sistema. Verificá que el servidor esté funcionando."); }
    result = await response.json();
    if (!response.ok) throw new Error(result.error || "No pudimos completar la operación.");
  }
  checkGeneration(generation);
  return result;
}

function toast(message, error = false) {
  const region = $("#toast-region");
  if (!region) return;
  const item = document.createElement("div");
  item.className = `toast${error ? " toast-error" : " toast-success"}`;
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 5000);
}

async function refresh() {
  const generation = dataGeneration;
  const [products, clients, invoices, movements, dashboard] = await Promise.all([
    api("/products"), api("/clients"), api("/invoices"), api("/stock-movements"), api("/dashboard"),
  ]);
  checkGeneration(generation);
  Object.assign(state, { products: products.products, clients: clients.clients, invoices: invoices.invoices, movements: movements.movements, dashboard, loaded: true });
  render();
}

function navigate(view) {
  if (!pageInfo[view]) view = "dashboard";
  state.view = view;
  $$(".view").forEach((el) => { el.hidden = el.id !== `view-${view}`; el.classList.toggle("active", !el.hidden); });
  $$("[data-view]").forEach((el) => { el.classList.toggle("active", el.dataset.view === view); if (el.tagName === "A") { if (el.dataset.view === view) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current"); } });
  $("#page-title").textContent = pageInfo[view][0];
  $("#page-subtitle").textContent = pageInfo[view][1];
  const crumb = $("#breadcrumb-current"); if (crumb) crumb.textContent = pageInfo[view][0];
  document.title = `${pageInfo[view][0]} · Nicolás`;
  $("#sidebar").classList.remove("open");
  $("#overlay").hidden = true;
  $("#nav-toggle").setAttribute("aria-expanded", "false");
}

function emptyRow(cols, title, description = "", action = "", label = "") {
  return `<tr><td colspan="${cols}"><div class="empty-state"><span class="empty-icon">${icons.box}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${action ? `<button class="btn btn-secondary" data-action="${action}">${esc(label)}</button>` : ""}</div></td></tr>`;
}
function stockBadge(product) {
  const variant = product.stock === 0 ? "danger" : product.stock <= product.min_stock ? "warning" : "success";
  return `<span class="badge badge-${variant}"><span class="status-dot"></span>${product.stock} ${product.stock === 1 ? "unidad" : "unidades"}</span>`;
}
function invoiceRows(invoices, compact = false) {
  return invoices.map((invoice) => `<tr><td><button class="text-button table-primary" data-action="view-invoice" data-id="${invoice.id}">${esc(invoice.number)}</button><span class="table-secondary">${esc(date(invoice.created_at))}</span></td><td>${esc(invoice.client_name || "Consumidor final")}</td>${compact ? "" : `<td>${esc(({ cash: "Efectivo", card: "Tarjeta", transfer: "Transferencia" })[invoice.payment_method] || invoice.payment_method)}</td>`}<td class="money">${money(invoice.total_cents)}</td><td><span class="badge badge-${invoice.status === "cancelled" ? "neutral" : "success"}">${invoice.status === "cancelled" ? "Anulada" : "Pagada"}</span></td>${compact ? "" : `<td class="align-right"><button class="btn btn-secondary btn-sm" data-action="view-invoice" data-id="${invoice.id}">Ver detalle</button></td>`}</tr>`).join("");
}
function renderDashboard() {
  const d = state.dashboard;
  if (!d) return;
  const cards = [["Ventas del mes", money(d.revenue_month_cents), "Ingresos de ventas vigentes", "trend", "purple"], ["Operaciones del mes", d.sales_month, "Ventas registradas este mes", "sale", "blue"], ["Productos", d.products_count, `${d.low_stock.length} con stock bajo`, "box", "amber"], ["Clientes", d.clients_count, "Contactos en tu agenda", "people", "green"]];
  $("#dashboard-stats").innerHTML = cards.map(([label, value, note, icon, color]) => `<article class="metric-card"><div class="metric-top"><span class="metric-label">${label}</span><span class="metric-icon ${color}">${icons[icon]}</span></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></article>`).join("");
  const days = d.revenue_days || [];
  const max = Math.max(1, ...days.map((day) => day.total_cents));
  $("#revenue-chart").innerHTML = days.map((day) => {
    const label = new Intl.DateTimeFormat("es-AR", { weekday: "short", timeZone: "UTC" }).format(new Date(`${day.date}T12:00:00Z`));
    return `<div class="chart-column" title="${esc(day.date)}: ${esc(money(day.total_cents))}"><span class="chart-value">${day.total_cents ? money(day.total_cents) : "—"}</span><div class="chart-track"><div class="chart-bar${day.total_cents ? " has-value" : ""}" style="height:${day.total_cents ? Math.max(5, day.total_cents / max * 100) : 3}%"></div></div><span class="chart-label">${esc(label)}</span></div>`;
  }).join("");
  $("#recent-sales").innerHTML = d.recent_invoices.length ? invoiceRows(d.recent_invoices, true) : emptyRow(4, "Tu primera venta empieza acá", "Cargá un producto y registrá una venta para ver tu actividad.", "new-sale", "Registrar una venta");
  $("#low-stock-list").innerHTML = d.low_stock.length ? d.low_stock.slice(0, 6).map((p) => `<div class="stock-alert-row"><span class="product-avatar">${icons.box}</span><div><strong>${esc(p.name)}</strong><span class="table-secondary">Mínimo: ${p.min_stock} unidades</span></div><button class="text-button" data-action="adjust-stock" data-id="${p.id}" aria-label="Ajustar stock de ${esc(p.name)}">${stockBadge(p)}</button></div>`).join("") : `<div class="empty-state compact"><span class="all-good">✓</span><h3>${state.products.length ? "Tu stock está al día" : "Tu inventario te espera"}</h3><p>${state.products.length ? "Todos tus productos están por encima del mínimo." : "Agregá productos para empezar a controlar tus existencias."}</p><button class="btn btn-secondary btn-sm" data-action="add-product">Agregar producto</button></div>`;
  if ($("#chart-total")) $("#chart-total").textContent = money(days.reduce((sum, day) => sum + day.total_cents, 0));
}
function renderProducts() {
  const term = $("#product-search").value.toLocaleLowerCase("es");
  const products = state.products.filter((p) => `${p.name} ${p.sku}`.toLocaleLowerCase("es").includes(term));
  $("#product-count").textContent = `${state.products.length} ${state.products.length === 1 ? "producto" : "productos"}`;
  $("#products-body").innerHTML = products.length ? products.map((p) => `<tr><td><div class="product-cell"><span class="product-avatar">${icons.box}</span><div><strong class="table-primary">${esc(p.name)}</strong><span class="table-secondary">${esc(p.sku || "Sin código")}</span></div></div></td><td class="money">${money(p.price_cents)}</td><td>${stockBadge(p)}</td><td>${p.min_stock} u.</td><td><div class="row-actions"><button class="btn btn-icon" data-action="adjust-stock" data-id="${p.id}" title="Ajustar stock" aria-label="Ajustar stock de ${esc(p.name)}">${icons.adjust}</button><button class="btn btn-icon" data-action="edit-product" data-id="${p.id}" title="Editar producto" aria-label="Editar ${esc(p.name)}">${icons.edit}</button><button class="btn btn-icon danger" data-action="archive-product" data-id="${p.id}" title="Archivar producto" aria-label="Archivar ${esc(p.name)}">${icons.trash}</button></div></td></tr>`).join("") : emptyRow(5, term ? "No encontramos ese producto" : "Dale lugar a tu primer producto", term ? "Probá con otro nombre o código." : "Agregá tus productos, sus precios y el stock disponible.", term ? "" : "add-product", "Agregar producto");
}
function renderClients() {
  const term = $("#client-search").value.toLocaleLowerCase("es");
  const clients = state.clients.filter((c) => `${c.name} ${c.document} ${c.email} ${c.phone}`.toLocaleLowerCase("es").includes(term));
  $("#client-count").textContent = `${state.clients.length} ${state.clients.length === 1 ? "cliente" : "clientes"}`;
  $("#clients-body").innerHTML = clients.length ? clients.map((c) => `<tr><td><div class="product-cell"><span class="client-avatar">${esc(c.name.split(/\s+/).map((v) => v[0]).slice(0, 2).join("").toUpperCase())}</span><div><strong class="table-primary">${esc(c.name)}</strong><span class="table-secondary">${esc(c.address || "Sin dirección")}</span></div></div></td><td><span>${esc(c.email || "—")}</span><span class="table-secondary">${esc(c.phone || "Sin teléfono")}</span></td><td>${esc(c.document || "—")}</td><td><div class="row-actions"><button class="btn btn-icon" data-action="edit-client" data-id="${c.id}" title="Editar cliente" aria-label="Editar ${esc(c.name)}">${icons.edit}</button><button class="btn btn-icon danger" data-action="archive-client" data-id="${c.id}" title="Archivar cliente" aria-label="Archivar ${esc(c.name)}">${icons.trash}</button></div></td></tr>`).join("") : emptyRow(4, term ? "No encontramos ese cliente" : "Conocé mejor a tus clientes", term ? "Probá con otro nombre, documento o contacto." : "Guardá sus datos para asociarlos a tus próximas ventas.", term ? "" : "add-client", "Agregar cliente");
}
function renderInvoices() {
  const term = $("#invoice-search").value.toLocaleLowerCase("es");
  const invoices = state.invoices.filter((i) => `${i.number} ${i.client_name}`.toLocaleLowerCase("es").includes(term));
  $("#invoice-count").textContent = `${state.invoices.length} ${state.invoices.length === 1 ? "venta" : "ventas"}`;
  $("#invoices-body").innerHTML = invoices.length ? invoiceRows(invoices) : emptyRow(6, term ? "No encontramos esa venta" : "Cada venta cuenta", term ? "Buscá por número de comprobante o cliente." : "Registrá tu primera venta y el stock se actualizará automáticamente.", term ? "" : "new-sale", "Registrar una venta");
}
function renderStock() {
  $("#movements-body").innerHTML = state.movements.length ? state.movements.map((m) => `<tr><td><span class="table-primary">${esc(m.product_name)}</span></td><td><span class="badge badge-${m.quantity > 0 ? "success" : "warning"}">${m.quantity > 0 ? "+" : ""}${m.quantity} u.</span></td><td>${esc(m.reason)}</td><td class="table-secondary">${esc(date(m.created_at, true))}</td></tr>`).join("") : emptyRow(4, "Cada movimiento deja su huella", "Acá vas a ver el stock inicial, las ventas y los ajustes de inventario.");
}
function render() { renderDashboard(); renderProducts(); renderClients(); renderInvoices(); renderStock(); }

function modal(title, subtitle, body, footer, wide = false) {
  const dialog = $("#modal");
  if (dialog.open) dialog.close();
  dialog.classList.toggle("modal-wide", wide);
  $("#modal-content").innerHTML = `<div class="modal-header"><div><h2 id="modal-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="btn btn-icon" type="button" data-action="close-modal" aria-label="Cerrar">${icons.close}</button></div>${body}${footer || ""}`;
  dialog.setAttribute("aria-labelledby", "modal-title");
  dialog.showModal();
}
function errorInForm(message) { const target = $("#form-error"); if (target) { target.textContent = message; target.hidden = false; } else toast(message, true); }
function bindForm(id, handler) {
  const form = $(`#${id}`);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.saving || !form.reportValidity()) return;
    const generation = dataGeneration;
    const button = $('button[type="submit"]', form) || $(`button[form="${id}"]`);
    form.dataset.saving = "true";
    if (button) { button.disabled = true; button.dataset.label = button.textContent; button.textContent = "Guardando…"; }
    const error = $("#form-error"); if (error) error.hidden = true;
    try { await handler(new FormData(form)); }
    catch (error) { if (!error.sessionChanged && generation === dataGeneration) errorInForm(error.message); }
    finally { delete form.dataset.saving; if (button?.isConnected) { button.disabled = false; button.textContent = button.dataset.label; } }
  });
}
const formError = '<p class="form-error" id="form-error" role="alert" hidden></p>';
const formFooter = (formId, label = "Guardar") => `<div class="modal-footer"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancelar</button><button type="submit" form="${formId}" class="btn btn-primary">${label}</button></div>`;

function productForm(id) {
  const p = id ? state.products.find((v) => v.id === id) : null;
  if (id && !p) return;
  modal(p ? "Editar producto" : "Agregar producto", "Un catálogo ordenado hace más simple cada venta.", `<form id="product-form" class="modal-body"><div class="form-grid"><label class="field field-full">Nombre del producto<input name="name" required maxlength="160" placeholder="Ej.: Cuaderno A5" value="${esc(p?.name || "")}" autofocus></label><label class="field">Código / SKU<input name="sku" maxlength="80" placeholder="Ej.: CUA-001" value="${esc(p?.sku || "")}"></label><label class="field">Precio de venta (ARS)<input type="number" name="price" required min="0" max="999999999" step="0.01" placeholder="0,00" value="${p ? (p.price_cents / 100).toFixed(2) : ""}"></label>${p ? "" : '<label class="field">Stock inicial<input type="number" name="stock" required min="0" max="1000000" step="1" value="0"></label>'}<label class="field">Alerta de stock mínimo<input type="number" name="min_stock" required min="0" max="1000000" step="1" value="${p?.min_stock ?? 5}"></label></div><p class="form-hint">${p ? "Para registrar entradas o salidas, usá la opción Ajustar stock." : "Te avisaremos cuando el stock llegue al mínimo que elijas."}</p>${formError}</form>`, formFooter("product-form", p ? "Guardar cambios" : "Agregar producto"));
  bindForm("product-form", async (data) => {
    const payload = { name: data.get("name").trim(), sku: data.get("sku").trim(), price_cents: Math.round(Number(data.get("price")) * 100), min_stock: Number(data.get("min_stock")) };
    if (!p) payload.stock = Number(data.get("stock"));
    await api(p ? `/products/${p.id}` : "/products", { method: p ? "PUT" : "POST", body: payload });
    $("#modal").close(); toast(p ? "Producto actualizado." : "Producto agregado a tu catálogo."); await refresh();
  });
}
function clientForm(id) {
  const c = id ? state.clients.find((v) => v.id === id) : null;
  if (id && !c) return;
  modal(c ? "Editar cliente" : "Agregar cliente", "Guardá los datos de quienes eligen tu negocio.", `<form id="client-form" class="modal-body"><div class="form-grid"><label class="field field-full">Nombre y apellido / Razón social<input name="name" required maxlength="160" value="${esc(c?.name || "")}" placeholder="Ej.: María González" autofocus></label><label class="field">DNI / CUIT<input name="document" maxlength="80" value="${esc(c?.document || "")}" placeholder="Documento del cliente"></label><label class="field">Teléfono<input name="phone" type="tel" maxlength="80" value="${esc(c?.phone || "")}" placeholder="Ej.: 11 1234 5678"></label><label class="field field-full">Correo electrónico<input name="email" type="email" maxlength="250" value="${esc(c?.email || "")}" placeholder="nombre@ejemplo.com"></label><label class="field field-full">Dirección<input name="address" maxlength="300" placeholder="Calle, número y localidad" value="${esc(c?.address || "")}"></label></div>${formError}</form>`, formFooter("client-form", c ? "Guardar cambios" : "Agregar cliente"));
  bindForm("client-form", async (data) => {
    const payload = Object.fromEntries(["name", "document", "phone", "email", "address"].map((key) => [key, data.get(key).trim()]));
    await api(c ? `/clients/${c.id}` : "/clients", { method: c ? "PUT" : "POST", body: payload });
    $("#modal").close(); toast(c ? "Cliente actualizado." : "Cliente agregado."); await refresh();
  });
}
function adjustStock(id) {
  const p = state.products.find((v) => v.id === id); if (!p) return;
  modal("Ajustar stock", p.name, `<form id="stock-form" class="modal-body"><div class="stock-current">Stock actual ${stockBadge(p)}</div><div class="form-grid"><label class="field">Movimiento<select name="direction"><option value="1">Entrada de mercadería</option><option value="-1">Salida / corrección</option></select></label><label class="field">Cantidad<input type="number" name="quantity" required min="1" max="1000000" step="1" value="1" autofocus></label><label class="field field-full">Motivo<input name="reason" required maxlength="250" placeholder="Ej.: Reposición de proveedor"></label></div><p class="form-hint">El movimiento quedará registrado en el historial de stock.</p>${formError}</form>`, formFooter("stock-form", "Registrar movimiento"));
  bindForm("stock-form", async (data) => { await api(`/products/${id}/stock`, { method: "POST", body: { quantity: Number(data.get("quantity")) * Number(data.get("direction")), reason: data.get("reason").trim() } }); $("#modal").close(); toast("Stock actualizado y movimiento registrado."); await refresh(); });
}
function confirmAction(title, description, label, action) {
  modal(title, "Confirmá esta operación para continuar.", `<form id="confirm-form" class="modal-body"><p class="confirm-description">${esc(description)}</p>${formError}</form>`, `<div class="modal-footer"><button type="button" class="btn btn-secondary" data-action="close-modal">Volver</button><button type="submit" form="confirm-form" class="btn btn-danger">${esc(label)}</button></div>`);
  bindForm("confirm-form", action);
}
function archive(type, id) {
  const item = state[type].find((v) => v.id === id); if (!item) return;
  const isProduct = type === "products";
  confirmAction(`Archivar ${isProduct ? "producto" : "cliente"}`, `“${item.name}” dejará de aparecer en tu ${isProduct ? "catálogo" : "agenda"}. Las ventas anteriores conservarán sus datos.`, "Archivar", async () => { await api(`/${type}/${id}`, { method: "DELETE" }); $("#modal").close(); toast(`${isProduct ? "Producto archivado" : "Cliente archivado"}.`); await refresh(); });
}
function uuid() { return globalThis.crypto?.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }); }
function newSale() {
  if (!state.loaded) return toast("Esperá a que termine de cargar el sistema.", true);
  if (!state.products.length) { productForm(); toast("Primero agregá un producto para registrar tu venta."); return; }
  cart = []; saleRequestId = uuid();
  modal("Nueva venta", "Elegí los productos y generá tu comprobante.", `<form id="sale-form" class="modal-body"><div class="sale-layout"><div class="sale-products"><label class="field">Buscar productos<input id="sale-product-search" type="search" placeholder="Nombre o código…" autocomplete="off" autofocus></label><div id="sale-product-list" class="sale-product-list"></div></div><div class="sale-cart"><div class="form-grid"><label class="field field-full">Cliente<select name="client_id"><option value="">Consumidor final</option>${state.clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label><label class="field">Forma de pago<select name="payment_method"><option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="transfer">Transferencia</option></select></label><label class="field">IVA<select id="sale-tax" name="tax_rate"><option value="0">Sin IVA (0%)</option><option value="10.5">IVA 10,5%</option><option value="21">IVA 21%</option></select></label></div><div class="cart-heading">Detalle de la venta <span id="cart-count" class="badge badge-neutral">0</span></div><div id="sale-cart-items" class="sale-cart-items"></div><div id="sale-totals" class="totals"></div><label class="field">Notas <span class="optional">(opcional)</span><textarea name="notes" rows="2" maxlength="1000" placeholder="Una aclaración para el comprobante…"></textarea></label></div></div>${formError}</form>`, formFooter("sale-form", "Confirmar venta"), true);
  $("#sale-product-search").addEventListener("input", renderSalePicker);
  $("#sale-tax").addEventListener("change", renderCart);
  $("#sale-cart-items").addEventListener("change", (event) => {
    const input = event.target.closest("[data-cart-quantity]"); if (!input) return;
    const id = Number(input.dataset.cartQuantity); const line = cart.find((v) => v.product_id === id); const product = state.products.find((v) => v.id === id); const quantity = Number(input.value);
    if (!line || !product) return;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > product.stock) { toast(`La cantidad debe estar entre 1 y ${product.stock}.`, true); renderCart(); return; }
    line.quantity = quantity; renderCart();
  });
  renderSalePicker(); renderCart();
  bindForm("sale-form", async (data) => {
    if (!cart.length) throw new Error("Agregá al menos un producto a la venta.");
    const result = await api("/invoices", { method: "POST", body: { client_id: data.get("client_id") ? Number(data.get("client_id")) : null, payment_method: data.get("payment_method"), tax_rate: Number(data.get("tax_rate")), notes: data.get("notes").trim(), items: cart.map((line) => ({ ...line })), request_id: saleRequestId } });
    showReceipt(result.invoice); toast("Venta registrada. El stock se actualizó automáticamente.");
    try { await refresh(); } catch (error) { if (!error.sessionChanged) toast(error.message, true); }
  });
}
function renderSalePicker() {
  const term = $("#sale-product-search").value.toLocaleLowerCase("es");
  const products = state.products.filter((p) => `${p.name} ${p.sku}`.toLocaleLowerCase("es").includes(term));
  $("#sale-product-list").innerHTML = products.length ? products.map((p) => `<button type="button" class="sale-product${p.stock ? "" : " sold-out"}" data-action="add-cart" data-id="${p.id}" ${p.stock ? "" : "disabled"}><span class="product-avatar">${icons.box}</span><span class="sale-product-info"><strong>${esc(p.name)}</strong><small>${esc(p.sku || "Sin código")} · ${p.stock ? `${p.stock} disponibles` : "Sin stock"}</small></span><span class="sale-product-price">${money(p.price_cents)}</span><span class="add-circle">+</span></button>`).join("") : '<div class="empty-state compact"><h3>No hay coincidencias</h3><p>Probá con otro nombre o código.</p></div>';
}
function renderCart() {
  $("#cart-count").textContent = cart.reduce((sum, line) => sum + line.quantity, 0);
  $("#sale-cart-items").innerHTML = cart.length ? cart.map((line) => { const p = state.products.find((v) => v.id === line.product_id); return `<div class="cart-row"><div class="cart-product"><strong>${esc(p.name)}</strong><span class="table-secondary">${money(p.price_cents)} c/u</span></div><input type="number" class="quantity-input" data-cart-quantity="${p.id}" aria-label="Cantidad de ${esc(p.name)}" min="1" max="${p.stock}" step="1" value="${line.quantity}" required><strong class="money">${money(p.price_cents * line.quantity)}</strong><button type="button" class="btn btn-icon danger" data-action="remove-cart" data-id="${p.id}" aria-label="Quitar ${esc(p.name)}">${icons.close}</button></div>`; }).join("") : '<div class="cart-empty">Tu venta empieza con un producto.<br><span>Elegilo en el catálogo de la izquierda.</span></div>';
  const subtotal = cart.reduce((sum, line) => sum + state.products.find((p) => p.id === line.product_id).price_cents * line.quantity, 0);
  const rate = Number($("#sale-tax").value); const tax = Math.round(subtotal * rate / 100);
  $("#sale-totals").innerHTML = `<div><span>Subtotal</span><strong>${money(subtotal)}</strong></div><div><span>IVA (${String(rate).replace(".", ",")}%)</span><strong>${money(tax)}</strong></div><div class="total-line"><span>Total</span><strong>${money(subtotal + tax)}</strong></div>`;
}
function addCart(id) {
  const product = state.products.find((p) => p.id === id); if (!product) return;
  const existing = cart.find((p) => p.product_id === id);
  if ((existing?.quantity || 0) >= product.stock) return toast("Ya agregaste todas las unidades disponibles.", true);
  if (existing) existing.quantity++; else cart.push({ product_id: id, quantity: 1 }); renderCart();
}
function receiptMarkup(invoice) {
  return `<article class="receipt"><div class="receipt-heading"><div><span class="receipt-brand">Nicolás<span>.</span></span><p>Comprobante de venta</p></div><div class="receipt-number"><strong>${esc(invoice.number)}</strong><p>${esc(date(invoice.created_at, true))}</p><span class="badge badge-${invoice.status === "cancelled" ? "neutral" : "success"}">${invoice.status === "cancelled" ? "Anulada" : "Pagada"}</span></div></div><div class="receipt-customer"><div><span class="receipt-label">CLIENTE</span><strong>${esc(invoice.client_name || "Consumidor final")}</strong>${invoice.client_document ? `<p>DNI / CUIT: ${esc(invoice.client_document)}</p>` : ""}${invoice.client_address ? `<p>${esc(invoice.client_address)}</p>` : ""}</div><div><span class="receipt-label">FORMA DE PAGO</span><strong>${esc(({ cash: "Efectivo", card: "Tarjeta", transfer: "Transferencia" })[invoice.payment_method] || invoice.payment_method)}</strong></div></div><div class="table-wrap"><table class="table receipt-table"><thead><tr><th>Producto</th><th>Cant.</th><th>Precio unit.</th><th>Importe</th></tr></thead><tbody>${invoice.items.map((item) => `<tr><td>${esc(item.product_name)}${item.sku ? `<span class="table-secondary">${esc(item.sku)}</span>` : ""}</td><td>${item.quantity}</td><td class="money">${money(item.unit_price_cents)}</td><td class="money">${money(item.total_cents)}</td></tr>`).join("")}</tbody></table></div><div class="receipt-totals totals"><div><span>Subtotal</span><strong>${money(invoice.subtotal_cents)}</strong></div><div><span>IVA (${String(invoice.tax_rate).replace(".", ",")}%)</span><strong>${money(invoice.tax_cents)}</strong></div><div class="total-line"><span>Total</span><strong>${money(invoice.total_cents)}</strong></div></div>${invoice.notes ? `<div class="receipt-notes"><span class="receipt-label">NOTAS</span><p>${esc(invoice.notes)}</p></div>` : ""}<footer class="receipt-footnote">Comprobante interno de venta · Sin validez fiscal · Importes en pesos argentinos (ARS).</footer></article>`;
}
function showReceipt(invoice) {
  currentReceipt = invoice;
  modal("Detalle de venta", "Tu comprobante y toda la información de la operación.", `<div class="modal-body">${receiptMarkup(invoice)}</div>`, `<div class="modal-footer receipt-actions">${invoice.status !== "cancelled" ? `<button class="btn btn-danger btn-outline" data-action="cancel-invoice" data-id="${invoice.id}">Anular venta</button>` : ""}<span class="footer-spacer"></span><button class="btn btn-secondary" data-action="close-modal">Cerrar</button><button class="btn btn-primary" data-action="print-invoice">Imprimir / PDF</button></div>`, true);
}
function printReceipt() {
  if (!currentReceipt) return;
  const frame = document.createElement("iframe"); frame.title = "Imprimir comprobante"; frame.dataset.nicolasPrint = "true";
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  const embeddedStyle = $("style[data-nicolas-main]")?.textContent;
  const stylesheet = embeddedStyle ? `<style>${embeddedStyle.replace(/<\/style/gi, "<\\/style")}</style>` : location.protocol === "file:" ? "" : `<link rel="stylesheet" href="${location.origin}/styles.css">`;
  frame.srcdoc = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(currentReceipt.number)} · Nicolás</title>${stylesheet}<style>body{background:white;padding:24px;color:#202338}.receipt{max-width:850px;margin:auto}.receipt-table{width:100%}@page{margin:15mm}@media print{body{padding:0}.badge{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>${receiptMarkup(currentReceipt)}</body></html>`;
  const generation = dataGeneration;
  frame.addEventListener("load", () => { if (generation !== dataGeneration) { frame.remove(); return; } frame.contentWindow.focus(); frame.contentWindow.print(); });
  document.body.append(frame); setTimeout(() => frame.remove(), 60000);
}
async function exportCsv(kind, anchor) {
  const generation = dataGeneration;
  if (!window.NicolasStore) { location.href = anchor.href; return; }
  const status = await storeStatus(); checkGeneration(generation); if (!status?.unlocked) return;
  const result = await (typeof window.NicolasStore.export === "function" ? window.NicolasStore.export(kind) : window.NicolasStore.request(`/export/${kind}.csv`)); checkGeneration(generation);
  const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = result.filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function handleAction(action, id) {
  if (!state.loaded && !["close-modal", "retry-load"].includes(action)) return;
  switch (action) {
    case "add-product": productForm(); break;
    case "edit-product": productForm(id); break;
    case "adjust-stock": adjustStock(id); break;
    case "archive-product": archive("products", id); break;
    case "add-client": clientForm(); break;
    case "edit-client": clientForm(id); break;
    case "archive-client": archive("clients", id); break;
    case "new-sale": newSale(); break;
    case "close-modal": $("#modal").close(); break;
    case "add-cart": addCart(id); break;
    case "remove-cart": cart = cart.filter((line) => line.product_id !== id); renderCart(); break;
    case "view-invoice": showReceipt((await api(`/invoices/${id}`)).invoice); break;
    case "print-invoice": printReceipt(); break;
    case "cancel-invoice": {
      const invoice = currentReceipt; if (!invoice) return;
      confirmAction("Anular venta", `Se anulará ${invoice.number} y sus productos volverán al stock. El comprobante se conservará en el historial.`, "Anular y devolver stock", async () => { const result = await api(`/invoices/${id}/cancel`, { method: "POST", body: {} }); showReceipt(result.invoice); toast("Venta anulada. Stock restituido."); await refresh(); }); break;
    }
    case "retry-load": await load(); break;
  }
}
async function load() {
  const generation = dataGeneration;
  try {
    if (window.NicolasStore) { const status = await storeStatus(); checkGeneration(generation); if (!status?.unlocked) return; }
    await refresh(); $("#connection-error")?.remove();
  } catch (error) {
    if (error.sessionChanged || generation !== dataGeneration) return;
    toast(error.message, true);
    if (!$("#connection-error")) { const banner = document.createElement("div"); banner.id = "connection-error"; banner.className = "connection-error"; banner.setAttribute("role", "alert"); banner.innerHTML = '<span>No pudimos cargar los datos. Volvé a intentar.</span><button class="btn btn-secondary btn-sm" data-action="retry-load">Reintentar</button>'; $("#page-title").closest("header").after(banner); }
  }
}
function clearSession() {
  dataGeneration++;
  Object.assign(state, { products: [], clients: [], invoices: [], movements: [], dashboard: null, loaded: false });
  cart = []; saleRequestId = ""; currentReceipt = null;
  if ($("#modal").open) $("#modal").close();
  $("#modal-content").replaceChildren();
  $$('input[type="password"], input[type="search"]').forEach(input => { input.value = ""; });
  $$('iframe[data-nicolas-print]').forEach(frame => frame.remove());
  for (const id of ["dashboard-stats", "revenue-chart", "low-stock-list", "recent-sales", "products-body", "clients-body", "invoices-body", "movements-body", "toast-region"]) $(`#${id}`)?.replaceChildren();
  for (const id of ["product-count", "client-count", "invoice-count", "chart-total"]) if ($(`#${id}`)) $(`#${id}`).textContent = "";
  $("#connection-error")?.remove();
}

document.addEventListener("click", (event) => {
  const exportLink = event.target.closest('a[href*="/api/export/"]');
  if (exportLink && window.NicolasStore) { const kind = exportLink.getAttribute("href").match(/\/api\/export\/(products|invoices)\.csv/)?.[1]; if (kind) { event.preventDefault(); exportCsv(kind, exportLink).catch(error => { if (!error.sessionChanged) toast(error.message, true); }); return; } }
  const nav = event.target.closest("[data-view]"); if (nav) { event.preventDefault(); const view = nav.dataset.view; location.hash = view; navigate(view); }
  const button = event.target.closest("[data-action]"); if (button) { event.preventDefault(); Promise.resolve(handleAction(button.dataset.action, Number(button.dataset.id))).catch((error) => { if (!error.sessionChanged) toast(error.message, true); }); }
});
$("#add-product").addEventListener("click", () => { if (state.loaded) productForm(); });
$("#add-client").addEventListener("click", () => { if (state.loaded) clientForm(); });
$("#product-search").addEventListener("input", renderProducts);
$("#client-search").addEventListener("input", renderClients);
$("#invoice-search").addEventListener("input", renderInvoices);
$("#modal").addEventListener("click", (event) => { if (event.target === $("#modal")) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$("#nav-toggle").addEventListener("click", () => { const open = $("#sidebar").classList.toggle("open"); $("#overlay").hidden = !open; $("#nav-toggle").setAttribute("aria-expanded", String(open)); });
$("#overlay").addEventListener("click", () => { $("#sidebar").classList.remove("open"); $("#overlay").hidden = true; $("#nav-toggle").setAttribute("aria-expanded", "false"); });
window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
window.addEventListener("nicolas:locked", clearSession);
window.addEventListener("nicolas:unlocked", () => { load(); });
$("#current-date").textContent = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
navigate(location.hash.slice(1));
load();
