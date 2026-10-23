/* Página del cliente. Los datos del formulario solo viven en esta pestaña. */
(function () {
  "use strict";
  const OWNER_WHATSAPP = "5493544617342";
  const core = window.LoanRequestCore;
  const form = document.getElementById("request-form");
  const field = name => form.elements.namedItem(name);
  const result = document.getElementById("calculator-result");
  const schedule = document.getElementById("installments-body");
  const status = document.getElementById("send-status");
  const errorSummary = document.getElementById("form-error");
  const whatsappActions = document.getElementById("whatsapp-actions");
  const reopenWhatsApp = document.getElementById("reopen-whatsapp");
  const currency = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateFormatter = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
  const todayFormatter = new Intl.DateTimeFormat("en", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" });
  const amountButtons = form.querySelectorAll("[data-loan-amount]");
  const loanFields = new Set(["principal", "term_months", "first_due_date"]);
  let automaticFirstDate = true;
  let calendarKey = "", calendarId = "";

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function money(cents) { return currency.format(cents / 100); }
  function displayDate(iso) { return dateFormatter.format(new Date(iso + "T12:00:00Z")); }
  function todayArgentina() {
    const parts = todayFormatter.formatToParts(new Date());
    const part = name => parts.find(item => item.type === name).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  function nextDay(iso) {
    const date = new Date(iso + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }
  const initialToday = todayArgentina();
  const originalDay = Number(initialToday.slice(8));
  field("first_due_date").value = core.addMonths(initialToday, 1);
  field("first_due_date").min = nextDay(initialToday);

  function cleanText(value) { return value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " "); }
  function phoneFromForm(value) {
    const trimmed = value.trim();
    if (/^[\d\s().-]+$/.test(trimmed)) {
      const digits = trimmed.replace(/\D/g, "");
      if (/^[1-9]\d{9}$/.test(digits)) return core.normalizePhone("+549" + digits);
    }
    return core.normalizePhone(trimmed);
  }
  function clearFieldError(name) {
    const input = field(name);
    if (!input) return;
    input.removeAttribute("aria-invalid");
    input.closest(".field")?.classList.remove("invalid");
    const note = document.getElementById("error-" + name);
    if (note) note.textContent = "";
  }
  function showErrors(errors) {
    form.querySelectorAll("[name]").forEach(input => clearFieldError(input.name));
    for (const [name, message] of Object.entries(errors)) {
      const input = field(name);
      input.setAttribute("aria-invalid", "true");
      input.closest(".field")?.classList.add("invalid");
      const note = document.getElementById("error-" + name);
      if (note) note.textContent = message;
    }
    const names = Object.keys(errors);
    errorSummary.hidden = names.length === 0;
    errorSummary.textContent = names.length ? "Revisá los campos marcados para continuar." : "";
    if (names.length) field(names[0]).focus();
  }
  function clearFeedback() {
    status.replaceChildren(); status.hidden = true;
    document.getElementById("copy-fallback")?.remove();
    whatsappActions.hidden = true;
    reopenWhatsApp.removeAttribute("href");
    errorSummary.hidden = true;
  }
  function feedback(text) { status.textContent = text; status.hidden = false; }

  function readLoan() {
    const errors = {};
    let principal = 0;
    try {
      principal = core.parseMoney(field("principal").value);
      if (principal < 1) errors.principal = "Ingresá un importe mayor que cero.";
      else if (principal > core.MAX_PRINCIPAL_CENTS) errors.principal = "El importe supera el máximo que admite la calculadora ($1.000.000.000).";
    } catch (_) { errors.principal = "Ingresá el importe en pesos, sin separadores de miles y con hasta 2 decimales."; }
    const months = Number(field("term_months").value);
    if (!Number.isInteger(months) || months < 1 || months > core.MAX_TERM_MONTHS) errors.term_months = "Elegí un plazo entre 1 y 24 meses.";
    const date = field("first_due_date").value;
    const today = todayArgentina();
    field("first_due_date").min = nextDay(today);
    try {
      core.addMonths(date, 0);
      if (date <= today) errors.first_due_date = "Elegí una fecha de primera cuota posterior a hoy.";
    } catch (_) { errors.first_due_date = "Elegí una fecha válida para la primera cuota."; }
    if (Object.keys(errors).length) return { errors, quote: null };
    try {
      return { errors, quote: core.calculate({ principal_cents: principal, term_months: months, first_due_date: date,
        ...(automaticFirstDate ? { due_anchor_day: originalDay } : {}) }) };
    } catch (error) { return { errors: { first_due_date: error.message }, quote: null }; }
  }
  function renderCalculator() {
    const { quote, errors } = readLoan();
    amountButtons.forEach(button => button.setAttribute("aria-pressed", String(Number(field("principal").value) === Number(button.dataset.loanAmount))));
    result.replaceChildren(); schedule.replaceChildren();
    if (!quote) {
      result.append(element("p", field("principal").value ? Object.values(errors)[0] : "Elegí el importe y los meses para ver tu cuota.", "empty-result"));
      const row = element("tr"), cell = element("td", "Las cuotas aparecerán al completar la simulación.", "empty-schedule");
      cell.colSpan = 3; row.append(cell); schedule.append(row); return;
    }
    const summary = element("div", undefined, "summary-grid");
    const items = [["Monto solicitado", quote.principal_cents], ["Costo del préstamo", quote.total_cents - quote.principal_cents]];
    for (const [label, value] of items) {
      const item = element("div", undefined, "summary-item");
      item.append(element("span", label), element("strong", money(value))); summary.append(item);
    }
    const total = element("div", undefined, "summary-total");
    total.append(element("span", "Monto a devolver"), element("strong", money(quote.total_cents)));
    const highlight = element("div", undefined, "installment-highlight");
    highlight.append(element("span", quote.term_months === 1 ? "Una única cuota de" : `${quote.term_months} cuotas mensuales de`),
      element("strong", money(quote.regular_installment_cents)));
    result.append(highlight, summary, total);
    for (const item of quote.installments) {
      const row = element("tr");
      row.append(element("td", `${item.number} de ${quote.term_months}`), element("td", displayDate(item.due_date)), element("td", money(item.amount_cents), "text-right")); schedule.append(row);
    }
  }
  function application() {
    const { quote, errors } = readLoan();
    const values = {};
    for (const name of ["full_name", "address_street", "address_number", "locality"]) values[name] = cleanText(field(name).value);
    if (values.full_name.length < 3 || values.full_name.split(" ").length < 2) errors.full_name = "Ingresá tu nombre y apellido completos.";
    for (const [name, label] of [["address_street", "la calle de tu domicilio"], ["address_number", "el número de tu domicilio (o S/N)"], ["locality", "tu localidad o ciudad"]]) {
      if (!values[name]) errors[name] = `Ingresá ${label}.`;
    }
    const cuil = core.validateCuil(field("cuil").value);
    if (!cuil.valid) errors.cuil = cuil.message;
    const phone = phoneFromForm(field("client_whatsapp").value);
    if (!phone.valid) errors.client_whatsapp = "Revisá tu WhatsApp: código de área y número sin 0 ni 15, o el número internacional con +.";
    if (!field("contact_consent").checked) errors.contact_consent = "Marcá la casilla si aceptás que te contacten por esta solicitud y sus pagos.";
    showErrors(errors);
    if (Object.keys(errors).length) return null;
    return { ...values, cuil: cuil.normalized, client_whatsapp: phone.international, quote, remind_me: field("remind_me").checked };
  }
  function installmentSummary(quote) {
    if (quote.term_months === 1) return `1 cuota de ${money(quote.total_cents)}`;
    return `${quote.term_months} cuotas mensuales de ${money(quote.regular_installment_cents)}`;
  }
  function messageFor(data) {
    return ["Solicitud de préstamo", "",
      `Nombre y apellido: ${data.full_name}`, `CUIL: ${data.cuil}`,
      `Domicilio: ${data.address_street} ${data.address_number}`, `Localidad / Ciudad: ${data.locality}`,
      `WhatsApp: +${data.client_whatsapp}`, "",
      `Monto solicitado: ${money(data.quote.principal_cents)}`,
      `Monto a devolver: ${money(data.quote.total_cents)}`,
      `Cuotas: ${installmentSummary(data.quote)}`,
      `Primera cuota estimada: ${displayDate(data.quote.installments[0].due_date)}`].join("\n");
  }
  function prepareWhatsApp(data) {
    const url = `https://wa.me/${OWNER_WHATSAPP}?text=${encodeURIComponent(messageFor(data))}`;
    reopenWhatsApp.href = url;
    whatsappActions.hidden = false;
    return url;
  }

  form.addEventListener("submit", event => {
    event.preventDefault(); clearFeedback();
    const data = application(); if (!data) return;
    const url = prepareWhatsApp(data);
    try {
      window.open(url, "_blank", "noopener,noreferrer");
      feedback("Tu solicitud está preparada. En WhatsApp, revisá el mensaje y tocá Enviar. Si el chat no se abrió, tocá “Abrir mi solicitud en WhatsApp” o copiá la solicitud y pegala en el chat con +54 9 3544 617342.");
    } catch (_) {
      feedback("El navegador no pudo abrir el chat. Tocá “Abrir mi solicitud en WhatsApp” para continuar. También podés copiar la solicitud y pegarla en WhatsApp.");
    }
  });
  document.getElementById("copy-request").addEventListener("click", async () => {
    clearFeedback();
    const data = application(); if (!data) return;
    const text = messageFor(data);
    prepareWhatsApp(data);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("No clipboard");
      await navigator.clipboard.writeText(text);
      feedback("Solicitud copiada. Pegala en el chat de WhatsApp con +54 9 3544 617342, revisala y tocá Enviar.");
    } catch (_) {
      const panel = element("div"); panel.id = "copy-fallback";
      const label = element("label", "Copiá este texto y pegalo en WhatsApp:"); label.htmlFor = "copy-fallback-text";
      const area = element("textarea"); area.id = "copy-fallback-text"; area.readOnly = true; area.value = text;
      panel.append(label, area); status.after(panel); area.focus(); area.select();
      feedback("El navegador no permitió copiar automáticamente. Seleccioná y copiá el texto que aparece debajo.");
    }
  });

  // RFC 5545: fold lines at 75 UTF-8 octets without splitting a Unicode character.
  function calendarLine(value) {
    const encoder = new TextEncoder(); let line = "", bytes = 0; const lines = [];
    for (const character of value) {
      const size = encoder.encode(character).length;
      if (bytes + size > 75) { lines.push(line); line = " "; bytes = 1; }
      line += character; bytes += size;
    }
    lines.push(line); return lines.join("\r\n");
  }
  function calendarText(value) { return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,"); }
  function calendarFor(quote) {
    const key = JSON.stringify(quote);
    if (key !== calendarKey) {
      calendarKey = key;
      calendarId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Prestamos//Solicitud de prestamo//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:Cuotas estimadas - Préstamos"];
    for (const item of quote.installments) {
      const title = `Cuota ${item.number}/${quote.term_months} estimada · ${money(item.amount_cents)} · Préstamos`;
      const description = `Vencimiento propuesto, sujeto a aprobación. Importe: ${money(item.amount_cents)}. Confirmá las fechas por WhatsApp con +${OWNER_WHATSAPP} antes de pagar. Si cambian, eliminá estos eventos e importá el calendario actualizado. Los avisos dependen de la configuración y los permisos de tu calendario.`;
      lines.push("BEGIN:VEVENT", `UID:${calendarId}-${item.number}@prestamos-solicitud`, `DTSTAMP:${stamp}`,
        `DTSTART:${item.due_date.replace(/-/g, "")}T120000Z`, "DURATION:PT15M", "STATUS:TENTATIVE", "TRANSP:TRANSPARENT",
        "SUMMARY:" + calendarText(title), "DESCRIPTION:" + calendarText(description));
      for (const trigger of ["-P1D", "PT0M"]) lines.push("BEGIN:VALARM", `TRIGGER:${trigger}`, "ACTION:DISPLAY", "DESCRIPTION:" + calendarText(title), "END:VALARM");
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR"); return lines.map(calendarLine).join("\r\n") + "\r\n";
  }
  document.getElementById("download-reminders").addEventListener("click", () => {
    clearFeedback();
    const { quote, errors } = readLoan(); showErrors(errors); if (!quote) return;
    if (!field("remind_me").checked) { feedback("Marcá “Quiero guardar las fechas de pago en mi calendario” para descargar los recordatorios."); field("remind_me").focus(); return; }
    const blob = new Blob([calendarFor(quote)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = element("a"); link.href = url; link.download = "fechas-de-pago.ics";
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    feedback("Calendario descargado. Abrí el archivo fechas-de-pago.ics e importalo en tu calendario. Incluye avisos un día antes y el día de cada cuota, a las 09:00 de Argentina. Activá las notificaciones en tu calendario. Las fechas son estimadas hasta confirmar el préstamo; si cambian, eliminá estos eventos y descargalos de nuevo.");
  });
  function onEdit(event) {
    const name = event.target.name;
    if (!name) return;
    clearFeedback(); clearFieldError(name);
    if (name === "first_due_date") automaticFirstDate = false;
    if (loanFields.has(name)) renderCalculator();
  }
  form.addEventListener("input", onEdit);
  form.addEventListener("change", onEdit);
  amountButtons.forEach(button => button.addEventListener("click", () => {
    field("principal").value = button.dataset.loanAmount;
    field("principal").dispatchEvent(new Event("input", { bubbles: true }));
  }));

  const shareStatus = document.getElementById("share-status");
  function shareFeedback(text) { shareStatus.textContent = text; shareStatus.hidden = false; }
  document.getElementById("share-page").addEventListener("click", async () => {
    shareStatus.hidden = true;
    document.getElementById("share-fallback")?.remove();
    const url = new URL(window.location.href);
    if (!/^https?:$/.test(url.protocol)) {
      shareFeedback("Podés compartir el archivo PRESTAMOS.html. Para compartir un enlace, abrí la página publicada y usá este botón desde allí.");
      return;
    }
    // Share only the public page, never form data, query parameters, or fragments.
    url.search = ""; url.hash = "";
    const publicUrl = url.href;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Préstamos", text: "Calculá tu cuota y enviá tu solicitud por WhatsApp.", url: publicUrl });
        shareFeedback("Terminaste de compartir la página."); return;
      } catch (error) {
        if (error.name === "AbortError") { shareFeedback("Se canceló la acción de compartir."); return; }
      }
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("No clipboard");
      await navigator.clipboard.writeText(publicUrl);
      shareFeedback("Enlace copiado. Pegalo en WhatsApp para compartir la página.");
    } catch (_) {
      const panel = element("div"); panel.id = "share-fallback";
      const label = element("label", "Copiá este enlace para compartir la página:"); label.htmlFor = "share-url-fallback";
      const input = element("input"); input.id = "share-url-fallback"; input.type = "url"; input.readOnly = true; input.value = publicUrl;
      panel.append(label, input); shareStatus.after(panel); input.focus(); input.select();
      shareFeedback("Seleccioná y copiá el enlace que aparece debajo.");
    }
  });
  renderCalculator();
})();
