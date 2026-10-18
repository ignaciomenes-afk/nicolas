"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = value => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format((value || 0) / 100);
const today = () => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map(t => parts.find(p => p.type === t).value).join("-");
};
const formatDate = value => value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeZone: value.length === 10 ? "UTC" : "America/Argentina/Buenos_Aires" }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value)) : "—";
const dueDays = value => Math.round((Date.parse(`${value}T12:00:00Z`) - Date.parse(`${today()}T12:00:00Z`)) / 86400000);
const rateLabel = bps => `${new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(bps / 100)}% mensual`;
const plans = { installments: "Cuotas mensuales de capital e interés", interest_only: "Interés mensual y capital al final", single: "Un pago al vencimiento" };
const methods = { flat: "Interés simple sobre capital inicial", declining: "Interés sobre saldo programado · capital fijo" };
const paymentMethods = { cash: "Efectivo", transfer: "Transferencia", card: "Tarjeta" };
const icon = name => ({
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="m16 3 5 5L9 20l-6 1 1-6L16 3Zm-3 3 5 5"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5.66"/></svg>',
  money: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="3"/><circle cx="12" cy="12" r="3"/><path d="M5 9h1M18 15h1"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>',
  trend: '<svg viewBox="0 0 24 24"><path d="m3 17 6-6 4 4 8-10M15 5h6v6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  archive: '<svg viewBox="0 0 24 24"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h5"/></svg>',
}[name] || "").replace('<svg ', '<svg fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" ');

const state = { clients: [], loans: [], payments: [], dashboard: null, entries: [], settings: {}, loaded: false, view: "dashboard" };
let generation = 0;
let activeLoan = null;
let printedDocument = null;
const pages = {
  dashboard: ["Resumen", "Tu cartera de préstamos, al día."], clients: ["Clientes", "Los datos de cada persona y su historial."],
  loans: ["Préstamos", "Capital entregado, intereses y saldos pendientes."], payments: ["Cobros", "Cada abono registrado y su comprobante."],
  due: ["Vencimientos", "Las fechas de cobro que necesitan tu atención."], ledger: ["Movimientos", "Desembolsos, cobros y saldo de caja de préstamos."],
  settings: ["Mis datos", "Tus datos para los documentos y los avisos de cobro."],
};

async function api(path, options = {}) {
  if (!window.NicolasStore) throw new Error("Abrí la versión descargable completa para usar tu espacio privado.");
  return window.NicolasStore.request(path, options);
}
function toast(message, error = false) {
  const el = document.createElement("div"); el.className = `toast${error ? " toast-error" : ""}`; el.textContent = message;
  $("#toast-region").append(el); setTimeout(() => el.remove(), error ? 8000 : 4500);
}
function uuid() { return crypto.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }); }
function decimalCents(value, label = "importe") {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`Revisá el ${label}: usá hasta dos decimales.`);
  const [whole, fraction = ""] = text.split("."); const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > 1000000000000n) throw new Error(`El ${label} supera el máximo permitido.`);
  return Number(cents);
}
async function refresh() {
  const own = generation;
  const [clients, loans, payments, dashboard, ledger, settings] = await Promise.all([api("/clients"), api("/loans"), api("/payments"), api("/loan-dashboard"), api("/ledger"), api("/settings")]);
  if (own !== generation) return;
  Object.assign(state, { clients: clients.clients, loans: loans.loans, payments: payments.payments, dashboard, entries: ledger.entries, settings: settings.settings, loaded: true });
  render(); $("#connection-error")?.remove();
}
async function load() {
  try { await refresh(); }
  catch (error) {
    if (!(await window.NicolasStore.status().catch(() => ({}))).unlocked) return;
    toast(error.message, true);
    if (!$("#connection-error")) {
      const el = document.createElement("div"); el.id = "connection-error"; el.className = "connection-error"; el.setAttribute("role", "alert");
      el.innerHTML = '<span>No pudimos abrir los registros. Volvé a intentar; tus datos guardados se conservan.</span><button class="btn btn-secondary" data-action="retry">Reintentar</button>';
      $("#page-title").closest("header").after(el);
    }
  }
}
function navigate(view) {
  if (!pages[view]) view = "dashboard"; state.view = view;
  $$(".view").forEach(el => { el.hidden = el.id !== `view-${view}`; el.classList.toggle("active", !el.hidden); });
  $$("[data-view]").forEach(el => { el.classList.toggle("active", el.dataset.view === view); if (el.dataset.view === view) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current"); });
  $("#page-title").textContent = pages[view][0]; $("#page-subtitle").textContent = pages[view][1]; $("#breadcrumb-current").textContent = pages[view][0];
  document.title = `${pages[view][0]} · Nicolás Préstamos`;
  $("#sidebar").classList.remove("open"); $("#overlay").hidden = true; $("#nav-toggle").setAttribute("aria-expanded", "false");
  if (view === "settings") fillSettings();
}
const statusName = loan => loan.status === "cancelled" ? "Anulado" : loan.balance_cents === 0 || loan.status === "paid" ? "Saldado" : loan.installments.some(i => i.balance_cents > 0 && i.due_date < today()) ? "Con atraso" : "Activo";
function loanBadge(loan) { const label = statusName(loan); return `<span class="badge badge-${label === "Saldado" ? "success" : label === "Con atraso" ? "danger" : label === "Anulado" ? "neutral" : "purple"}">${label}</span>`; }
function emptyRow(columns, title, description, action = "", label = "") { return `<tr><td colspan="${columns}"><div class="empty-state"><span class="empty-icon">${icon("file")}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${action ? `<button class="btn btn-secondary" data-action="${action}">${esc(label)}</button>` : ""}</div></td></tr>`; }
function renderDashboard() {
  const d = state.dashboard; if (!d) return;
  const cards = [["Capital pendiente", d.capital_outstanding_cents, "Capital entregado que falta recuperar", "money", "purple"], ["Saldo total a cobrar", d.total_receivable_cents, "Capital e interés del cronograma pactado", "file", "blue"], ["Cobrado este mes", d.collected_month_cents, "Abonos efectivamente registrados", "calendar", "green"], ["Interés cobrado", d.interest_collected_month_cents, "Parte de los cobros del mes", "trend", "amber"]];
  $("#dashboard-stats").innerHTML = cards.map(([label, value, hint, symbol, color]) => `<article class="metric-card"><div class="metric-top"><span class="metric-label">${label}</span><span class="metric-icon ${color}">${icon(symbol)}</span></div><div class="metric-value">${money(value)}</div><p class="metric-note">${hint}</p></article>`).join("");
  $("#due-alerts").innerHTML = d.overdue_count ? `<div class="notice-card overdue" role="status"><strong>${d.overdue_count} ${d.overdue_count === 1 ? "cuota vencida" : "cuotas vencidas"} · ${money(d.overdue_cents)}</strong><p>Hay cobros pendientes de fechas anteriores.</p><button class="btn btn-secondary btn-sm" data-action="show-overdue">Revisar vencimientos</button></div>` : d.due_today_cents > 0 ? `<div class="notice-card"><strong>Hoy tenés cobros por ${money(d.due_today_cents)}</strong><button class="btn btn-secondary btn-sm" data-action="show-due">Ver cobros de hoy</button></div>` : "";
  const upcoming = (d.upcoming || []).slice(0, 5);
  $("#due-summary").innerHTML = upcoming.length ? upcoming.map(item => `<div class="stock-alert-row due-alert-row"><span class="product-avatar">${icon("calendar")}</span><div><strong>${esc(item.client_name)}</strong><span class="table-secondary">${esc(item.loan_number)} · Cuota ${item.installment_number} · ${formatDate(item.due_date)}</span></div><div><strong class="money">${money(item.balance_cents)}</strong><button class="text-button" data-action="new-payment" data-id="${item.loan_id}">Registrar cobro</button></div></div>`).join("") : '<div class="empty-state compact"><span class="all-good">✓</span><h3>Sin cobros por vencer</h3><p>Los avisos aparecerán según los días de anticipación que elijas.</p></div>';
  $("#portfolio-summary").innerHTML = `<div class="portfolio-line"><span>Préstamos activos</span><strong>${d.active_loans_count}</strong></div><div class="portfolio-line"><span>Clientes registrados</span><strong>${d.clients_count}</strong></div><div class="portfolio-line"><span>Desembolsado este mes</span><strong>${money(d.disbursed_month_cents)}</strong></div><div class="portfolio-line"><span>Cobros para hoy</span><strong>${money(d.due_today_cents)}</strong></div><p class="form-hint">Avisos desde ${state.settings.reminder_days ?? 3} días antes. Se actualizan mientras la página está abierta.</p>`;
  $("#recent-payments").innerHTML = (d.recent_payments || []).length ? d.recent_payments.map(p => `<tr><td><button class="text-button table-primary" data-action="view-payment" data-id="${p.id}">${esc(p.number)}</button></td><td>${esc(p.client_name)}</td><td>${formatDate(p.paid_date)}</td><td class="money">${money(p.amount_cents)}</td><td><span class="badge badge-${p.status === "reversed" ? "neutral" : "success"}">${p.status === "reversed" ? "Anulado" : "Registrado"}</span></td></tr>`).join("") : emptyRow(5, "Cada cobro, bien registrado", "Acá aparecerán los abonos de tus clientes.");
}
function renderClients() {
  const term = $("#client-search").value.toLocaleLowerCase("es");
  const clients = state.clients.filter(c => `${c.name} ${c.document} ${c.phone} ${c.email}`.toLocaleLowerCase("es").includes(term));
  $("#client-count").textContent = `${state.clients.length} clientes`;
  $("#clients-body").innerHTML = clients.length ? clients.map(c => `<tr><td><div class="product-cell"><span class="client-avatar">${esc(c.name.split(/\s+/).slice(0, 2).map(s => s[0]).join("").toUpperCase())}</span><div><strong class="table-primary">${esc(c.name)}</strong><span class="table-secondary">${esc(c.address || "Sin dirección")}</span></div></div></td><td>${esc(c.phone || "Sin teléfono")}<span class="table-secondary">${esc(c.email)}</span></td><td>${esc(c.document || "Sin documento")}</td><td><div class="row-actions"><button class="btn btn-secondary btn-sm" data-action="client-loans" data-id="${c.id}">Préstamos</button><button class="btn btn-icon" data-action="edit-client" data-id="${c.id}" aria-label="Editar ${esc(c.name)}">${icon("edit")}</button><button class="btn btn-icon danger" data-action="archive-client" data-id="${c.id}" aria-label="Archivar ${esc(c.name)}">${icon("archive")}</button></div></td></tr>`).join("") : emptyRow(4, term ? "No encontramos ese cliente" : "Agregá tu primer cliente", term ? "Buscá por nombre, documento o teléfono." : "Guardá sus datos antes de registrar un préstamo.", term ? "" : "add-client", "Agregar cliente");
}
function renderLoans() {
  const term = $("#loan-search").value.toLocaleLowerCase("es"), filter = $("#loan-status").value;
  const loans = state.loans.filter(l => `${l.number} ${l.client_name} ${l.client_document}`.toLocaleLowerCase("es").includes(term) && (filter === "all" || filter === "overdue" && statusName(l) === "Con atraso" || filter === "paid" && statusName(l) === "Saldado" || filter === "active" && l.status !== "cancelled" && l.balance_cents > 0 || filter === "cancelled" && l.status === "cancelled"));
  $("#loan-count").textContent = `${loans.length} préstamos`;
  $("#loans-body").innerHTML = loans.length ? loans.map(l => `<tr><td><button class="text-button table-primary" data-action="view-loan" data-id="${l.id}">${esc(l.number)}</button><span class="table-secondary">${esc(l.client_name)}</span></td><td class="money">${money(l.principal_cents)}</td><td>${rateLabel(l.monthly_rate_bps)}</td><td>${l.term_months} ${l.term_months === 1 ? "mes" : "meses"}</td><td>${formatDate(l.next_due_date)}</td><td class="money">${money(l.balance_cents)}</td><td>${loanBadge(l)}</td><td><button class="btn btn-secondary btn-sm" data-action="view-loan" data-id="${l.id}">Ver detalle</button></td></tr>`).join("") : emptyRow(8, term || filter !== "all" ? "Sin préstamos para esa búsqueda" : "Tu cartera empieza acá", "Registrá el capital, la tasa mensual y el plan de devolución.", "new-loan", "Nuevo préstamo");
}
function renderPayments() {
  const term = $("#payment-search").value.toLocaleLowerCase("es"), payments = state.payments.filter(p => `${p.number} ${p.loan_number} ${p.client_name}`.toLocaleLowerCase("es").includes(term));
  $("#payment-count").textContent = `${payments.length} cobros`;
  $("#payments-body").innerHTML = payments.length ? payments.map(p => `<tr><td><button class="text-button table-primary" data-action="view-payment" data-id="${p.id}">${esc(p.number)}</button></td><td>${esc(p.client_name)}<span class="table-secondary">${esc(p.loan_number)}</span></td><td>${formatDate(p.paid_date)}</td><td class="money">${money(p.principal_cents)}</td><td class="money">${money(p.interest_cents)}</td><td class="money">${money(p.amount_cents)}</td><td><span class="badge badge-${p.status === "reversed" ? "neutral" : "success"}">${p.status === "reversed" ? "Anulado" : "Registrado"}</span> <button class="btn btn-secondary btn-sm" data-action="view-payment" data-id="${p.id}">Ver</button></td></tr>`).join("") : emptyRow(7, "Todavía no hay cobros", "Registrá cada pago para actualizar el saldo y emitir su recibo.", "new-payment", "Registrar cobro");
}
function dueItems() {
  return state.loans.filter(l => l.status !== "cancelled").flatMap(l => l.installments.filter(i => i.balance_cents > 0).map(i => ({ ...i, loan_id: l.id, loan_number: l.number, client_name: l.client_name, client_phone: l.client_phone }))).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.loan_id - b.loan_id || a.number - b.number);
}
function renderDue() {
  const filter = $("#due-filter").value;
  const items = dueItems().filter(i => filter === "all" || filter === "overdue" && i.due_date < today() || filter === "today" && i.due_date === today() || filter === "upcoming" && dueDays(i.due_date) > 0 && dueDays(i.due_date) <= (state.settings.reminder_days ?? 3));
  $("#due-count").textContent = `${items.length} cuotas pendientes`;
  $("#due-body").innerHTML = items.length ? items.map(i => { const days = dueDays(i.due_date); return `<tr><td><strong class="table-primary">${esc(i.client_name)}</strong><button class="text-button table-secondary" data-action="view-loan" data-id="${i.loan_id}">${esc(i.loan_number)}</button></td><td>${i.number}</td><td>${formatDate(i.due_date)}</td><td class="money">${money(i.balance_cents)}</td><td><span class="badge badge-${days < 0 ? "danger" : days === 0 ? "warning" : "neutral"}">${days < 0 ? `${-days} días de atraso` : days === 0 ? "Vence hoy" : `En ${days} días`}</span></td><td>${esc(i.client_phone || "Sin teléfono")}</td><td><button class="btn btn-secondary btn-sm" data-action="new-payment" data-id="${i.loan_id}">Cobrar</button></td></tr>`; }).join("") : emptyRow(7, "Sin cuotas en este período", "Los cobros completos y los préstamos anulados no generan avisos.");
}
function renderLedger() {
  $("#ledger-body").innerHTML = state.entries.length ? [...state.entries].reverse().map(e => `<tr><td>${formatDate(e.date)}</td><td><strong class="table-primary">${esc(e.number)}</strong><span class="table-secondary">${esc(e.client_name)} · ${esc(e.description)}</span></td><td><span class="badge badge-${e.type === "payment" ? "success" : "neutral"}">${e.type === "payment" ? "Cobro" : "Desembolso"}</span></td><td class="money">${money(e.principal_cents)}</td><td class="money">${money(e.interest_cents)}</td><td class="money">${e.credit_cents ? "+" + money(e.credit_cents) : "−" + money(e.debit_cents)}</td><td class="money">${money(e.balance_cents)}</td></tr>`).join("") : emptyRow(7, "Sin movimientos registrados", "Los préstamos y cobros se reflejarán automáticamente.");
  const out = state.entries.reduce((s, e) => s + e.debit_cents, 0), received = state.entries.reduce((s, e) => s + e.credit_cents, 0);
  $("#ledger-summary").innerHTML = `<span>Desembolsado: <strong>${money(out)}</strong></span><span>Cobrado: <strong>${money(received)}</strong></span><span>Flujo neto: <strong>${money(received - out)}</strong></span>`;
}
function fillSettings() { if (!state.loaded || $("#settings-form").contains(document.activeElement)) return; for (const [name, value] of Object.entries(state.settings)) { const input = $(`[name="${name}"]`, $("#settings-form")); if (input) input.value = value; } }
function render() { renderDashboard(); renderClients(); renderLoans(); renderPayments(); renderDue(); renderLedger(); fillSettings(); }

function modal(title, subtitle, body, footer = "", wide = false) {
  const el = $("#modal"); if (el.open) el.close(); el.classList.toggle("modal-wide", wide);
  $("#modal-content").innerHTML = `<div class="modal-header"><div><h2 id="modal-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="btn btn-icon" type="button" data-action="close-modal" aria-label="Cerrar">${icon("close")}</button></div>${body}${footer}`;
  el.setAttribute("aria-labelledby", "modal-title"); el.showModal();
}
const formError = '<p id="form-error" class="form-error" role="alert" hidden></p>';
function footer(form, label) { return `<div class="modal-footer"><button type="button" class="btn btn-secondary" data-action="close-modal">Volver</button><button type="submit" form="${form}" class="btn btn-primary">${esc(label)}</button></div>`; }
function formFailure(error) { if ($("#form-error")) { $("#form-error").textContent = error.message; $("#form-error").hidden = false; } else toast(error.message, true); }
function bindForm(id, handler) {
  const form = $(`#${id}`); form.addEventListener("submit", async event => {
    event.preventDefault(); if (form.dataset.saving || !form.reportValidity()) return;
    const own = generation, button = $(`button[form="${id}"]`) || $('button[type="submit"]', form);
    form.dataset.saving = "true"; if (button) { button.disabled = true; button.dataset.label = button.textContent; button.textContent = "Guardando…"; } if ($("#form-error")) $("#form-error").hidden = true;
    try { await handler(new FormData(form), own); }
    catch (error) { if (own === generation) formFailure(error); }
    finally { delete form.dataset.saving; if (button?.isConnected) { button.disabled = false; button.textContent = button.dataset.label; } }
  });
}
function clientForm(id, after) {
  const c = id ? state.clients.find(c => c.id === id) : null; if (id && !c) return;
  modal(c ? "Editar cliente" : "Agregar cliente", "La información del cliente se conservará en cada préstamo.", `<form id="client-form" class="modal-body"><div class="form-grid"><label class="field field-full">Nombre o razón social<input name="name" required maxlength="250" value="${esc(c?.name || "")}" autofocus></label><label class="field">DNI / CUIT<input name="document" maxlength="250" value="${esc(c?.document || "")}"></label><label class="field">Teléfono<input name="phone" type="tel" maxlength="250" value="${esc(c?.phone || "")}"></label><label class="field field-full">Correo electrónico<input name="email" type="email" maxlength="250" value="${esc(c?.email || "")}"></label><label class="field field-full">Domicilio<input name="address" maxlength="500" value="${esc(c?.address || "")}"></label></div>${formError}</form>`, footer("client-form", c ? "Guardar cambios" : "Agregar cliente"));
  bindForm("client-form", async (data, own) => { const result = await api(c ? `/clients/${id}` : "/clients", { method: c ? "PUT" : "POST", body: Object.fromEntries(["name", "document", "email", "phone", "address"].map(key => [key, String(data.get(key)).trim()])) }); if (own !== generation) return; $("#modal").close(); toast("Cliente guardado."); await refresh(); if (after && own === generation) after(result.client.id); });
}
function confirmForm(title, explanation, actionLabel, handler, reason = false) {
  modal(title, "Revisá los datos antes de confirmar.", `<form id="confirm-form" class="modal-body"><p class="confirm-description">${esc(explanation)}</p>${reason ? '<label class="field">Motivo de la corrección<textarea name="reason" maxlength="500" required rows="2"></textarea></label>' : ""}${formError}</form>`, footer("confirm-form", actionLabel));
  bindForm("confirm-form", handler);
}
function loanInputs(data) { return { principal_cents: decimalCents(data.get("principal"), "capital"), monthly_rate_bps: decimalCents(data.get("monthly_rate"), "interés mensual"), term_months: Number(data.get("term_months")), issued_date: data.get("issued_date"), first_due_date: data.get("first_due_date") || null, interest_method: data.get("interest_method"), payment_plan: data.get("payment_plan") }; }
function loanForm(preselected) {
  if (!state.loaded) return toast("Esperá a que se carguen tus registros.", true);
  if (!state.clients.length) return clientForm(undefined, loanForm);
  let preview = null, timer, serial = 0; const requestId = uuid();
  modal("Nuevo préstamo", "Revisá el capital, los intereses y las fechas antes de confirmar.", `<form id="loan-form" class="modal-body"><div class="loan-form-grid"><div><div class="form-grid"><label class="field field-full">Cliente<select name="client_id" required><option value="">Seleccioná un cliente</option>${state.clients.map(c => `<option value="${c.id}" ${c.id === preselected ? "selected" : ""}>${esc(c.name)}${c.document ? " · " + esc(c.document) : ""}</option>`).join("")}</select></label><label class="field">Capital entregado (ARS)<input name="principal" type="number" min="0.01" max="10000000000" step="0.01" required placeholder="0,00"></label><label class="field">Tasa de interés mensual (%)<input name="monthly_rate" type="number" min="0" max="1000" step="0.01" required placeholder="Ej.: 10"></label><label class="field">Plazo (meses)<input name="term_months" type="number" min="1" max="120" step="1" required value="3"></label><label class="field">Fecha de emisión / entrega<input name="issued_date" type="date" required max="${today()}" value="${today()}"></label><label class="field field-full">Primer cobro <span class="optional">(opcional)</span><input name="first_due_date" type="date"><small>Vacío: cada mes el día de la emisión, o el último día del mes. Una fecha personalizada fija otro día de cobro.</small></label><label class="field field-full">Cómo se calcula el interés<select name="interest_method"><option value="flat">Sobre el capital inicial · interés simple</option><option value="declining">Sobre el saldo programado · capital fijo</option></select></label><label class="field field-full">Plan de devolución<select name="payment_plan"><option value="installments">Cuotas mensuales de capital e interés</option><option value="interest_only">Interés mensual y capital al finalizar</option><option value="single">Un solo pago al vencimiento</option></select></label><label class="field field-full">Notas<textarea name="notes" maxlength="2000" rows="2" placeholder="Condiciones u observaciones del préstamo"></textarea></label></div><p class="form-hint">Intereses mensuales sin capitalización ni cargos de mora automáticos. Se usa el cronograma pactado; no se prorratea por días ni se recalculan descuentos por anticipos.</p></div><aside id="loan-preview" class="loan-preview"><div class="empty-state compact"><h3>Tu cronograma, antes de guardar</h3><p>Completá capital, tasa y plazo para ver el detalle.</p></div></aside></div>${formError}</form>`, footer("loan-form", "Registrar préstamo"), true);
  const form = $("#loan-form");
  async function updatePreview() {
    const own = ++serial, activeGeneration = generation;
    try {
      const data = new FormData(form); if (!data.get("principal") || data.get("monthly_rate") === "" || !data.get("term_months") || !data.get("issued_date")) return;
      const result = await api("/loans/preview", { method: "POST", body: loanInputs(data) });
      if (own !== serial || activeGeneration !== generation || !form.isConnected) return; preview = result.preview;
      $("#loan-preview").innerHTML = `<h3>Plan de cobro</h3><div class="preview-metrics"><div><span>Capital</span><strong>${money(preview.principal_cents)}</strong></div><div><span>Interés pactado</span><strong>${money(preview.interest_cents)}</strong></div><div class="total-line"><span>Total a cobrar</span><strong>${money(preview.total_cents)}</strong></div></div><p class="form-hint">${preview.installments.length} ${preview.installments.length === 1 ? "pago" : "cuotas"} · ${esc(methods[data.get("interest_method")])}</p><div class="table-wrap"><table class="schedule-table"><thead><tr><th>Cuota</th><th>Vencimiento</th><th>Capital</th><th>Interés</th><th>Total</th></tr></thead><tbody>${preview.installments.map(i => `<tr><td>${i.number}</td><td>${formatDate(i.due_date)}</td><td>${money(i.principal_cents)}</td><td>${money(i.interest_cents)}</td><td class="money">${money(i.total_cents)}</td></tr>`).join("")}</tbody></table></div><p class="form-hint">El pagaré se genera pendiente de firma. Podés imprimirlo y adjuntar el documento firmado.</p>`;
    } catch (error) { preview = null; if (own === serial && form.isConnected) { $("#loan-preview").replaceChildren(); const el = document.createElement("p"); el.className = "form-error"; el.textContent = error.message; $("#loan-preview").append(el); } }
  }
  form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(updatePreview, 220); });
  form.addEventListener("change", () => { clearTimeout(timer); updatePreview(); });
  bindForm("loan-form", async (data, own) => {
    const body = { ...loanInputs(data), client_id: Number(data.get("client_id")), notes: data.get("notes").trim(), request_id: requestId };
    await updatePreview();
    if (!preview) throw new Error("Revisá el capital, la tasa y las fechas para generar el cronograma.");
    const result = await api("/loans", { method: "POST", body }); if (own !== generation) return;
    $("#modal").close(); toast("Préstamo registrado y cronograma generado."); await refresh(); if (own === generation) showLoan(result.loan);
  });
}
function scheduleMarkup(loan) {
  return `<div class="table-wrap"><table class="schedule-table"><thead><tr><th>Cuota</th><th>Fecha de cobro</th><th>Capital</th><th>Interés</th><th>Total</th><th>Cobrado</th><th>Pendiente</th><th>Estado</th></tr></thead><tbody>${loan.installments.map(i => `<tr><td>${i.number}</td><td>${formatDate(i.due_date)}</td><td>${money(i.principal_cents)}</td><td>${money(i.interest_cents)}</td><td>${money(i.total_cents)}</td><td>${money(i.paid_cents)}</td><td class="money">${money(i.balance_cents)}</td><td><span class="badge badge-${i.balance_cents === 0 ? "success" : i.due_date < today() ? "danger" : i.paid_cents ? "warning" : "neutral"}">${i.balance_cents === 0 ? "Pagada" : i.due_date < today() ? "Vencida" : i.paid_cents ? "Parcial" : "Pendiente"}</span></td></tr>`).join("")}</tbody></table></div>`;
}
function showLoan(loan) {
  activeLoan = loan;
  const note = loan.note || {}, hasPayments = state.payments.some(p => p.loan_id === loan.id && p.status !== "reversed");
  modal(`${loan.number} · ${loan.client_name}`, "Detalle del préstamo y cronograma de cobros.", `<div class="modal-body loan-detail"><div class="loan-summary"><div><span>Capital entregado</span><strong>${money(loan.principal_cents)}</strong></div><div><span>Interés programado</span><strong>${money(loan.interest_cents)}</strong></div><div><span>Saldo a cobrar</span><strong>${money(loan.balance_cents)}</strong></div><div>${loanBadge(loan)}</div></div><dl class="loan-facts"><div><dt>Tasa mensual</dt><dd>${rateLabel(loan.monthly_rate_bps)}</dd></div><div><dt>Plazo</dt><dd>${loan.term_months} meses</dd></div><div><dt>Emisión</dt><dd>${formatDate(loan.issued_date)}</dd></div><div><dt>Primer vencimiento</dt><dd>${formatDate(loan.first_due_date)}</dd></div><div><dt>Cálculo de interés</dt><dd>${esc(methods[loan.interest_method])}</dd></div><div><dt>Devolución</dt><dd>${esc(plans[loan.payment_plan])}</dd></div><div><dt>DNI / CUIT del cliente</dt><dd>${esc(loan.client_document || "Sin documento")}</dd></div><div><dt>Contacto</dt><dd>${esc(loan.client_phone || "Sin teléfono")} ${esc(loan.client_email || "")}</dd></div></dl><section class="attachment-box"><div><h3>Pagaré</h3><p>${note.signed ? `Firma registrada el ${formatDate(note.signed_date)}.` : "Pendiente de firma. Imprimí el documento y registrá la firma cuando lo tengas."}</p>${note.attachment ? `<p>Adjunto: ${esc(note.attachment.name)}</p>` : ""}</div><div class="row-actions"><button class="btn btn-secondary btn-sm" data-action="print-note" data-id="${loan.id}">Ver / imprimir pagaré</button><button class="btn btn-secondary btn-sm" data-action="edit-note" data-id="${loan.id}">Registrar firma</button>${note.attachment ? `<button class="btn btn-secondary btn-sm" data-action="download-note" data-id="${loan.id}">Descargar firmado</button>` : ""}</div></section><h3 class="form-section-title">Cronograma pactado</h3>${scheduleMarkup(loan)}<p class="form-hint">Los abonos se imputan a las cuotas más antiguas, primero a su interés y luego a su capital. Los adelantos no modifican automáticamente el interés pactado.</p>${loan.notes ? `<div class="receipt-notes"><strong>Notas</strong><p>${esc(loan.notes)}</p></div>` : ""}</div>`, `<div class="modal-footer receipt-actions">${loan.status !== "cancelled" && !hasPayments ? `<button class="btn btn-danger btn-outline" data-action="cancel-loan" data-id="${loan.id}">Anular error de carga</button>` : ""}<button class="btn btn-secondary" data-action="calendar-loan" data-id="${loan.id}">Calendario</button><span class="footer-spacer"></span><button class="btn btn-secondary" data-action="close-modal">Cerrar</button>${loan.status !== "cancelled" && loan.balance_cents > 0 ? `<button class="btn btn-primary" data-action="new-payment" data-id="${loan.id}">Registrar cobro</button>` : ""}</div>`, true);
}
function paymentForm(id) {
  const available = state.loans.filter(l => l.status !== "cancelled" && l.balance_cents > 0);
  if (!available.length) return toast("Primero registrá un préstamo con saldo pendiente.", true);
  const selected = available.find(l => l.id === id) || available[0], requestId = uuid();
  modal("Registrar cobro", "Un pago parcial también actualiza el saldo de las cuotas.", `<form id="payment-form" class="modal-body"><div class="form-grid"><label class="field field-full">Préstamo<select name="loan_id" id="payment-loan" required>${available.map(l => `<option value="${l.id}" ${l.id === selected.id ? "selected" : ""}>${esc(l.number)} · ${esc(l.client_name)} · ${money(l.balance_cents)}</option>`).join("")}</select></label><div id="payment-balance" class="form-notice field-full"></div><label class="field">Importe recibido (ARS)<input name="amount" type="number" min="0.01" max="10000000000" step="0.01" required autofocus></label><label class="field">Fecha del cobro<input name="paid_date" type="date" required value="${today()}" max="${today()}"></label><label class="field field-full">Medio de pago<select name="method"><option value="cash">Efectivo</option><option value="transfer">Transferencia</option><option value="card">Tarjeta</option></select></label><label class="field field-full">Notas<textarea name="notes" maxlength="2000" rows="2" placeholder="Referencia de transferencia u observación"></textarea></label></div>${formError}</form>`, footer("payment-form", "Registrar cobro"));
  function update() { const loan = available.find(l => l.id === Number($("#payment-loan").value)), next = loan.installments.find(i => i.balance_cents > 0); $("#payment-balance").textContent = `Saldo total: ${money(loan.balance_cents)}. ${next ? `Primera cuota pendiente: ${money(next.balance_cents)}, vence el ${formatDate(next.due_date)}.` : ""}`; const input = $('[name="amount"]', $("#payment-form")); input.value = ((next?.balance_cents ?? loan.balance_cents) / 100).toFixed(2); input.max = (loan.balance_cents / 100).toFixed(2); $('[name="paid_date"]', $("#payment-form")).min = loan.issued_date; }
  $("#payment-loan").addEventListener("change", update); update();
  bindForm("payment-form", async (data, own) => { const result = await api("/payments", { method: "POST", body: { loan_id: Number(data.get("loan_id")), amount_cents: decimalCents(data.get("amount")), paid_date: data.get("paid_date"), method: data.get("method"), notes: data.get("notes").trim(), request_id: requestId } }); if (own !== generation) return; $("#modal").close(); toast("Cobro registrado. El saldo se actualizó."); await refresh(); if (own === generation) showPayment(result.payment); });
}
function showPayment(payment) {
  const html = `<article class="receipt payment-receipt"><div class="receipt-heading"><div><span class="receipt-brand">Nicolás<span>.</span></span><p>Recibo interno de cobro</p></div><div><strong>${esc(payment.number)}</strong><p>${formatDate(payment.paid_date)}</p><span class="badge badge-${payment.status === "reversed" ? "neutral" : "success"}">${payment.status === "reversed" ? "Anulado" : "Registrado"}</span></div></div><div class="receipt-customer"><div><span class="receipt-label">RECIBIDO DE</span><strong>${esc(payment.client_name)}</strong><p>Préstamo ${esc(payment.loan_number)}</p></div><div><span class="receipt-label">MEDIO DE PAGO</span><strong>${esc(paymentMethods[payment.method] || payment.method)}</strong></div></div><div class="preview-metrics"><div><span>Capital imputado</span><strong>${money(payment.principal_cents)}</strong></div><div><span>Interés imputado</span><strong>${money(payment.interest_cents)}</strong></div><div class="total-line"><span>Total recibido</span><strong>${money(payment.amount_cents)}</strong></div></div>${payment.allocations?.length ? `<div class="table-wrap"><table><thead><tr><th>Cuota</th><th>Capital</th><th>Interés</th></tr></thead><tbody>${payment.allocations.map(a => `<tr><td>${a.installment_number}</td><td>${money(a.principal_cents)}</td><td>${money(a.interest_cents)}</td></tr>`).join("")}</tbody></table></div>` : ""}${payment.notes ? `<p class="receipt-notes">${esc(payment.notes)}</p>` : ""}<p class="receipt-footnote">Imputaciones actuales de los cobros activos, en orden de registro. Una corrección puede reasignar cobros posteriores.</p></article>`;
  printedDocument = { title: payment.number, html };
  modal("Comprobante de cobro", `${payment.number} · ${payment.client_name}`, `<div class="modal-body">${html}</div>`, `<div class="modal-footer receipt-actions">${payment.status !== "reversed" ? `<button class="btn btn-danger btn-outline" data-action="reverse-payment" data-id="${payment.id}">Anular error de cobro</button>` : ""}<span class="footer-spacer"></span><button class="btn btn-secondary" data-action="close-modal">Cerrar</button><button class="btn btn-primary" data-action="print-document">Imprimir / PDF</button></div>`, true);
}

function numberWords(value) {
  const units = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
  function words(n) { if (n < 30) return units[n]; if (n < 100) return ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"][Math.floor(n / 10)] + (n % 10 ? " y " + words(n % 10) : ""); if (n === 100) return "cien"; if (n < 1000) return ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"][Math.floor(n / 100)] + (n % 100 ? " " + words(n % 100) : ""); if (n < 1000000) return (Math.floor(n / 1000) === 1 ? "mil" : words(Math.floor(n / 1000)).replace(/uno$/, "un") + " mil") + (n % 1000 ? " " + words(n % 1000) : ""); return (Math.floor(n / 1000000) === 1 ? "un millón" : words(Math.floor(n / 1000000)).replace(/uno$/, "un") + " millones") + (n % 1000000 ? " " + words(n % 1000000) : ""); }
  return `${words(Math.floor(value / 100)).replace(/uno$/, "un")} pesos con ${String(value % 100).padStart(2, "0")}/100`;
}
function showPromissory(loan) {
  activeLoan = loan;
  const lender = loan.lender || {}, line = "________________________________", finalDue = loan.installments.at(-1).due_date;
  const html = `<article class="receipt promissory-note"><header class="receipt-heading"><div><span class="receipt-brand">Nicolás<span>.</span></span><p>Documento del préstamo ${esc(loan.number)}</p></div><div><h2>PAGARÉ</h2><p>Emisión: ${formatDate(loan.issued_date)}</p><p>Vencimiento final: ${formatDate(finalDue)}</p></div></header><p><strong>Lugar de emisión:</strong> ${esc(lender.city || line)}</p><p>En la fecha de vencimiento indicada, <strong>${esc(loan.client_name)}</strong>, documento <strong>${esc(loan.client_document || line)}</strong>, con domicilio en ${esc(loan.client_address || line)}, pagaré a la orden de <strong>${esc(lender.name || line)}</strong>, documento ${esc(lender.document || line)}, la suma total programada de <strong>${money(loan.total_cents)}</strong> (${esc(numberWords(loan.total_cents))}), correspondiente al préstamo recibido y al interés pactado que se detalla a continuación.</p><div class="loan-facts"><div><dt>Capital recibido</dt><dd>${money(loan.principal_cents)}</dd></div><div><dt>Interés mensual</dt><dd>${rateLabel(loan.monthly_rate_bps)}</dd></div><div><dt>Plazo</dt><dd>${loan.term_months} meses</dd></div><div><dt>Cálculo</dt><dd>${esc(methods[loan.interest_method])}</dd></div><div><dt>Interés programado</dt><dd>${money(loan.interest_cents)}</dd></div><div><dt>Total programado</dt><dd>${money(loan.total_cents)}</dd></div></div><p>Forma de devolución: ${esc(plans[loan.payment_plan])}. Los pagos parciales se documentarán con recibos y reducirán el saldo correspondiente. El cronograma pactado se adjunta debajo. No se capitalizan intereses ni se agregan cargos de mora automáticamente.</p><h3>Cronograma de vencimientos</h3><div class="table-wrap"><table><thead><tr><th>Cuota</th><th>Fecha</th><th>Capital</th><th>Interés</th><th>Total</th></tr></thead><tbody>${loan.installments.map(i => `<tr><td>${i.number}</td><td>${formatDate(i.due_date)}</td><td>${money(i.principal_cents)}</td><td>${money(i.interest_cents)}</td><td>${money(i.total_cents)}</td></tr>`).join("")}</tbody></table></div><div class="signature-line"><span>Firma del deudor: ${line}</span><span>Aclaración: ${line}</span><span>DNI / CUIT: ${line}</span><span>Lugar y fecha de firma: ${line}</span></div><div class="signature-line"><span>Firma del acreedor: ${line}</span><span>Aclaración / documento: ${line}</span></div><footer class="receipt-footnote">Plantilla para completar, imprimir y firmar. Los campos vacíos deben completarse antes de la firma. Registrar la firma en la aplicación no reemplaza la firma del documento.</footer></article>`;
  printedDocument = { title: `Pagare-${loan.number}`, html };
  modal(`Pagaré · ${loan.number}`, "Completá tus datos en Mis datos y los del cliente antes de imprimir.", `<div class="modal-body">${html}</div>`, `<div class="modal-footer"><button class="btn btn-secondary" data-action="view-loan" data-id="${loan.id}">Volver al préstamo</button><button class="btn btn-primary" data-action="print-document">Imprimir / PDF</button></div>`, true);
}
function printDocument() {
  if (!printedDocument) return;
  const frame = document.createElement("iframe"); frame.title = "Imprimir documento"; frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.srcdoc = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(printedDocument.title)}</title><style>${$('style[data-nicolas-main]')?.textContent || ""}</style><style>body{background:white;color:#222;padding:24px}.receipt{max-width:900px;margin:auto}.promissory-note p{font-size:13px;line-height:1.8;margin:14px 0}.signature-line{display:grid;gap:24px;margin-top:40px}.loan-facts{display:grid;grid-template-columns:1fr 1fr}.receipt table{white-space:normal;width:100%}.receipt th,.receipt td{font-size:11px;padding:9px}@page{margin:15mm}@media print{body{padding:0}.receipt *{color:#111!important}.signature-line{break-inside:avoid}}</style></head><body>${printedDocument.html}</body></html>`;
  frame.addEventListener("load", () => { frame.contentWindow.focus(); frame.contentWindow.print(); }); document.body.append(frame); setTimeout(() => frame.remove(), 60000);
}
async function fileBase64(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error("El archivo firmado no puede superar 5 MB.");
  if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) throw new Error("Adjuntá un PDF, una foto JPEG o una imagen PNG.");
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { name: file.name, type: file.type, data: btoa(binary) };
}
function noteForm(loan) {
  const note = loan.note || {};
  modal(`Firma del pagaré · ${loan.number}`, "Registrá la firma solo cuando tengas el documento efectivamente firmado.", `<form id="note-form" class="modal-body"><label class="field"><span><input name="signed" type="checkbox" ${note.signed ? "checked" : ""}> Tengo el pagaré firmado</span></label><div class="form-grid"><label class="field">Fecha de firma<input name="signed_date" type="date" min="${loan.issued_date}" max="${today()}" value="${note.signed_date || today()}"></label><label class="field field-full">Foto o PDF del pagaré firmado <span class="optional">(opcional, máximo 5 MB)</span><input name="attachment" type="file" accept="application/pdf,image/png,image/jpeg"></label></div>${note.attachment ? `<p class="form-hint">Adjunto actual: ${esc(note.attachment.name)}</p><label class="field"><span><input name="remove_attachment" type="checkbox"> Quitar el adjunto actual</span></label>` : ""}<p class="form-hint">El archivo se guarda cifrado y se incluye en las copias de seguridad.</p>${formError}</form>`, footer("note-form", "Guardar firma"));
  bindForm("note-form", async (data, own) => {
    const signed = data.has("signed"), file = data.get("attachment"); let attachment = note.attachment || null;
    if (data.has("remove_attachment")) attachment = null; if (file?.size) attachment = await fileBase64(file);
    if (!signed && attachment) throw new Error("Marcá que tenés el pagaré firmado o quitá el adjunto.");
    const result = await api(`/loans/${loan.id}/note`, { method: "POST", body: { signed, signed_date: signed ? data.get("signed_date") : "", attachment } });
    if (own !== generation) return; toast("Registro del pagaré actualizado."); await refresh(); if (own === generation) showLoan(result.loan);
  });
}
function download(content, filename, type) { const url = URL.createObjectURL(new Blob([content], { type })), anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
function downloadAttachment(loan) { const file = loan.note?.attachment; if (!file) return; const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0)); download(bytes, file.name, file.type); }
function calendar(id) {
  const items = dueItems().filter(i => !id || i.loan_id === id);
  if (!items.length) return toast("No hay vencimientos pendientes para exportar.");
  const calText = text => String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nicolas//Prestamos privados//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VTIMEZONE", "TZID:America/Argentina/Buenos_Aires", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:-0300", "TZOFFSETTO:-0300", "TZNAME:ART", "END:STANDARD", "END:VTIMEZONE"];
  const reminderDays = Number(state.settings.reminder_days ?? 3);
  for (const item of items) { const day = item.due_date.replace(/-/g, ""); lines.push("BEGIN:VEVENT", `UID:nicolas-${item.loan_id}-cuota-${item.number}@local`, `DTSTAMP:${stamp}`, `DTSTART;TZID=America/Argentina/Buenos_Aires:${day}T090000`, `DTEND;TZID=America/Argentina/Buenos_Aires:${day}T093000`, `SUMMARY:${calText(`Cobro ${item.loan_number} · ${item.client_name}`)}`, `DESCRIPTION:${calText(`Cuota ${item.number}. Pendiente: ${money(item.balance_cents)}. Actualizá el cobro en Nicolás después de recibirlo.`)}`, "BEGIN:VALARM", reminderDays ? `TRIGGER:-P${reminderDays}D` : "TRIGGER:PT0S", "ACTION:DISPLAY", `DESCRIPTION:${calText(`Aviso de cobro: ${item.client_name} · ${item.loan_number}`)}`, "END:VALARM", "END:VEVENT"); }
  lines.push("END:VCALENDAR");
  // RFC 5545 folds lines at 75 UTF-8 octets, without splitting characters.
  const encoder = new TextEncoder(), folded = lines.map(line => { let result = "", part = "", length = 0; for (const char of line) { const size = encoder.encode(char).length; if (length + size > 74) { result += part + "\r\n "; part = ""; length = 1; } part += char; length += size; } return result + part; });
  download(folded.join("\r\n") + "\r\n", id ? `vencimientos-${id}.ics` : "vencimientos-nicolas.ics", "text/calendar;charset=utf-8");
  toast("Calendario descargado. Importalo para activar los avisos; los cambios posteriores se actualizan manualmente.");
}
async function handle(action, id) {
  switch (action) {
    case "retry": await load(); break;
    case "close-modal": $("#modal").close(); break;
    case "add-client": clientForm(); break;
    case "edit-client": clientForm(id); break;
    case "archive-client": { const c = state.clients.find(c => c.id === id); if (!c) break; confirmForm("Archivar cliente", `Se archivará ${c.name}. Los préstamos y sus datos históricos se conservarán.`, "Archivar", async () => { await api(`/clients/${id}`, { method: "DELETE" }); $("#modal").close(); await refresh(); toast("Cliente archivado."); }); break; }
    case "client-loans": { const c = state.clients.find(c => c.id === id); $("#loan-search").value = c?.name || ""; $("#loan-status").value = "all"; location.hash = "loans"; navigate("loans"); renderLoans(); break; }
    case "new-loan": loanForm(); break;
    case "view-loan": showLoan((await api(`/loans/${id}`)).loan); break;
    case "new-payment": paymentForm(id); break;
    case "view-payment": { const p = state.payments.find(p => p.id === id); if (p) showPayment(p); break; }
    case "print-note": showPromissory((await api(`/loans/${id}`)).loan); break;
    case "edit-note": noteForm((await api(`/loans/${id}`)).loan); break;
    case "download-note": downloadAttachment((await api(`/loans/${id}`)).loan); break;
    case "print-document": printDocument(); break;
    case "calendar-loan": calendar(id); break;
    case "download-calendar": calendar(); break;
    case "show-overdue": $("#due-filter").value = "overdue"; navigate("due"); location.hash = "due"; renderDue(); break;
    case "show-due": $("#due-filter").value = "today"; navigate("due"); location.hash = "due"; renderDue(); break;
    case "cancel-loan": confirmForm("Anular error de carga", "Usá esta opción solo para un préstamo registrado por error y sin cobros activos. No registra una devolución real de dinero.", "Anular registro", async data => { const result = await api(`/loans/${id}/cancel`, { method: "POST", body: { reason: data.get("reason").trim() } }); await refresh(); showLoan(result.loan); toast("Préstamo anulado por corrección."); }, true); break;
    case "reverse-payment": confirmForm("Anular error de cobro", "Se conserva el registro como anulado y vuelve a calcularse el saldo. No registra una devolución real de efectivo. La imputación de cobros posteriores puede cambiar.", "Anular cobro", async data => { const result = await api(`/payments/${id}/reverse`, { method: "POST", body: { reason: data.get("reason").trim() } }); await refresh(); showPayment(result.payment); toast("Cobro anulado por corrección."); }, true); break;
  }
}

document.addEventListener("click", event => {
  const exportLink = event.target.closest('a[href^="/api/export/"]');
  if (exportLink) { event.preventDefault(); api(exportLink.getAttribute("href").replace(/^\/api/, "")).then(r => download(r.csv, r.filename, "text/csv;charset=utf-8")).catch(error => toast(error.message, true)); return; }
  const nav = event.target.closest("[data-view]"); if (nav) { event.preventDefault(); location.hash = nav.dataset.view; navigate(nav.dataset.view); }
  const button = event.target.closest("[data-action]"); if (button && !button.disabled) { event.preventDefault(); Promise.resolve(handle(button.dataset.action, Number(button.dataset.id))).catch(error => toast(error.message, true)); }
});
$("#add-client").addEventListener("click", () => clientForm());
$("#client-search").addEventListener("input", renderClients); $("#loan-search").addEventListener("input", renderLoans); $("#loan-status").addEventListener("change", renderLoans); $("#payment-search").addEventListener("input", renderPayments); $("#due-filter").addEventListener("change", renderDue);
$("#nav-toggle").addEventListener("click", () => { const open = $("#sidebar").classList.toggle("open"); $("#overlay").hidden = !open; $("#nav-toggle").setAttribute("aria-expanded", String(open)); });
$("#overlay").addEventListener("click", () => { $("#sidebar").classList.remove("open"); $("#overlay").hidden = true; $("#nav-toggle").setAttribute("aria-expanded", "false"); });
window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
$("#current-date").textContent = formatDate(today());
$("#settings-form").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity() || form.dataset.saving) return;
  form.dataset.saving = "true"; const button = $('button[type="submit"]', form); button.disabled = true;
  try { const data = new FormData(form), body = Object.fromEntries(["lender_name", "lender_document", "lender_phone", "lender_address", "city"].map(key => [key, data.get(key).trim()])); body.reminder_days = Number(data.get("reminder_days")); await api("/settings", { method: "PUT", body }); await refresh(); toast("Datos y anticipación de avisos guardados."); }
  catch (error) { toast(error.message, true); } finally { delete form.dataset.saving; button.disabled = false; }
});
function clearPrivateState() {
  generation++; Object.assign(state, { clients: [], loans: [], payments: [], dashboard: null, entries: [], settings: {}, loaded: false }); activeLoan = null; printedDocument = null;
  $("#modal").close(); $("#modal-content").replaceChildren();
  $$("#dashboard-stats,#due-alerts,#due-summary,#portfolio-summary,#recent-payments,#clients-body,#loans-body,#payments-body,#due-body,#ledger-body,#ledger-summary,#toast-region").forEach(el => el.replaceChildren());
  $$("#client-search,#loan-search,#payment-search").forEach(el => { el.value = ""; }); $("#settings-form").reset();
  $$("#client-count,#loan-count,#payment-count,#due-count").forEach(el => { el.textContent = ""; });
  $$('iframe[title="Imprimir documento"]').forEach(el => el.remove()); $("#connection-error")?.remove();
}
window.addEventListener("nicolas:locked", clearPrivateState);
window.addEventListener("nicolas:unlocked", () => { generation++; load(); });
window.addEventListener("focus", () => { if (state.loaded) load(); });
setInterval(() => { if (state.loaded && !document.hidden) { $("#current-date").textContent = formatDate(today()); load(); } }, 60000);
navigate(location.hash.slice(1));
window.NicolasStore?.status().then(s => { if (s.unlocked) load(); }).catch(() => {});
