/* Private inbox. Load after app.js and the NicolasCloud adapter. This script
 * never reads the vault password, persists credentials, or enters the client page. */
(() => {
  "use strict";
  const cloud = () => window.NicolasCloud;
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const currency = (value) => typeof money === "function" ? money(Number(value) || 0) : new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format((Number(value) || 0) / 100);
  const dateLabel = (value) => { try { return value && typeof formatDate === "function" ? formatDate(String(value)) : value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "medium" }).format(new Date(value)) : "—"; } catch { return "—"; } };
  const envelopeIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
  const syncIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/></svg>';
  let unlocked = false, authenticated = false, activationRequired = false, codeSent = false, authMode = "email", epoch = 0, rows = [], imported = new Map(), importErrors = new Map();
  let poll = null, syncPromise = null, syncing = false, actionWorking = false, lastSync = null, currentRequestId = null, previousFocus = null;
  const section = document.createElement("section");
  section.id = "view-requests"; section.className = "view requests-view"; section.hidden = true; section.setAttribute("aria-label", "Solicitudes de préstamos recibidas");
  section.innerHTML = `<div class="section-intro requests-intro"><div><h2>Tu próxima operación empieza acá</h2><p>Revisá las solicitudes antes de incorporarlas a tu cartera.</p></div><span class="requests-connection" id="requests-connection"><i></i>Sin conectar</span></div>
    <div id="requests-unconfigured" class="requests-unconfigured panel"><span class="requests-large-icon">${envelopeIcon}</span><span class="requests-eyebrow">RECEPCIÓN POR INTERNET</span><h3>La bandeja todavía no está conectada.</h3><p>Cuando la conexión esté publicada, vas a recibir acá las solicitudes enviadas desde la página de clientes.</p><p class="requests-muted">Mientras tanto, podés seguir registrando préstamos y cobros en tu cartera privada.</p><button type="button" class="btn btn-secondary" disabled>Conexión pendiente</button></div>
    <article class="panel requests-login" id="requests-login-panel" hidden><div class="requests-login-copy"><span class="requests-large-icon">${envelopeIcon}</span><span class="requests-eyebrow">ACCESO A SOLICITUDES</span><h3>Entrá con tu correo.</h3><p>Recibí un enlace de acceso en tu correo para abrir tu bandeja. La primera vez, vas a poder activar tu cuenta desde acá.</p><p class="requests-auth-note">La contraseña de tu espacio privado protege tus registros en este equipo. Para la bandeja en línea, usá el enlace de tu correo.</p></div><div class="requests-auth-controls"><div class="requests-auth-tabs" role="tablist" aria-label="Forma de entrar a solicitudes"><button id="requests-auth-email" type="button" role="tab" aria-selected="true" aria-controls="requests-email-access" data-requests-action="auth-email">Con tu correo</button><button id="requests-auth-password" type="button" role="tab" aria-selected="false" aria-controls="requests-password-access" tabindex="-1" data-requests-action="auth-password">Con contraseña</button></div><div id="requests-email-access" role="tabpanel" aria-labelledby="requests-auth-email"><form id="requests-code-form" class="requests-login-form"><label class="field" for="requests-code-email">Tu correo<input id="requests-code-email" name="email" type="email" required autocomplete="email" maxlength="254" disabled></label><div id="requests-code-entry" hidden><label class="field" for="requests-email-code">Enlace o código del correo<input id="requests-email-code" name="code" type="text" inputmode="text" autocomplete="off" maxlength="8192" disabled aria-describedby="requests-code-help"></label><p id="requests-code-help" class="requests-code-help">Pegá el enlace completo del correo o ingresá su código de 6 a 10 números.</p></div><p id="requests-code-status" class="requests-code-status" role="status" aria-live="polite"></p><p id="requests-code-error" class="requests-error" role="alert" tabindex="-1" hidden></p><div class="requests-code-actions"><button id="requests-send-code" class="btn btn-primary" type="button" data-requests-action="send-code" disabled>Enviar acceso a mi correo</button><button id="requests-verify-code" class="btn btn-primary" type="submit" disabled hidden>Entrar a mi bandeja</button></div><p class="requests-login-help">El acceso y la sesión se borran al bloquear tu espacio.</p></form></div><div id="requests-password-access" role="tabpanel" aria-labelledby="requests-auth-password" hidden><form id="requests-login-form" class="requests-login-form"><label class="field" for="requests-email">Correo de tu cuenta<input id="requests-email" name="email" type="email" required autocomplete="username" maxlength="254" disabled></label><label class="field" for="requests-password">Contraseña de tu cuenta de solicitudes<input id="requests-password" name="password" type="password" required autocomplete="current-password" maxlength="512" disabled></label><p id="requests-login-error" class="requests-error" role="alert" tabindex="-1" hidden></p><button id="requests-login-submit" class="btn btn-primary" type="submit" disabled>Entrar a la bandeja</button><p class="requests-login-help">Usá esta opción si ya tenés una contraseña para tu cuenta de solicitudes.</p></form></div></div></article>
    <article id="requests-activation-panel" class="panel requests-activation" hidden><div class="requests-activation-copy"><span class="requests-large-icon">${envelopeIcon}</span><span class="requests-eyebrow">SOLO LA PRIMERA VEZ</span><h3>Activá tu cuenta.</h3><p>Correo verificado: <strong id="requests-activation-account"></strong></p><p>Para autorizar esta cuenta en tu proyecto, usá el token personal de acceso que obtuviste en Supabase.</p></div><form id="requests-activation-form" class="requests-login-form" autocomplete="off"><label class="field" for="requests-access-token">Token personal de Supabase<input id="requests-access-token" name="access-token" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" maxlength="512" required disabled aria-describedby="requests-activation-help"></label><p id="requests-activation-help" class="requests-activation-help">Este campo es para el token de Supabase, no para la contraseña de tu espacio privado. El token se usa para esta autorización y no se guarda.</p><p id="requests-activation-error" class="requests-error" role="alert" tabindex="-1" hidden></p><button id="requests-activate-owner" class="btn btn-primary" type="submit" disabled>Activar mi cuenta</button><button class="requests-text-button" data-requests-action="change-account" type="button">Usar otro correo</button></form></article>
    <div id="requests-connected" hidden><div class="requests-toolbar"><div><strong>Solicitudes recibidas</strong><span id="requests-sync-state" role="status" aria-live="polite">Listas para actualizar.</span></div><div class="requests-tools"><button class="btn btn-secondary btn-sm" id="requests-sync" data-requests-action="sync" type="button">${syncIcon}Actualizar</button><button class="requests-text-button" id="requests-signout" data-requests-action="signout" type="button">Desconectar</button></div></div><p id="requests-error" class="requests-error" role="alert" tabindex="-1" hidden></p><div id="requests-summary" class="requests-summary" aria-label="Resumen de solicitudes"></div><article class="panel requests-list-panel"><div class="requests-list-header"><label for="requests-filter">Mostrar<select id="requests-filter"><option value="pending">Pendientes de revisión</option><option value="import">Aprobadas por incorporar</option><option value="approved">Aprobadas</option><option value="rejected">Rechazadas</option><option value="all">Todas las solicitudes</option></select></label><span id="requests-result-count"></span></div><div id="requests-list" class="requests-list" aria-live="polite"></div></article><p class="requests-footnote">La bandeja se actualiza cada 45 segundos mientras tu sesión está abierta. Revisá el cronograma y completá la entrega de dinero y la firma del pagaré por separado.</p></div>`;
  const main = document.getElementById("main");
  if (!main) return;
  const footer = main.querySelector(".main-footer"); if (footer) footer.before(section); else main.append(section);
  if (typeof pages !== "undefined") pages.requests = ["Solicitudes", "Los pedidos de tus clientes, pendientes de tu decisión."];
  const navigation = document.querySelector(".main-nav");
  if (navigation && !navigation.querySelector('[data-view="requests"]')) {
    const link = document.createElement("a"); link.href = "#requests"; link.dataset.view = "requests"; link.className = "nav-item";
    link.innerHTML = `${envelopeIcon}<span>Solicitudes</span><span id="requests-nav-count" class="requests-nav-count" hidden></span>`;
    const divider = navigation.querySelector(".nav-divider"); if (divider) divider.before(link); else navigation.append(link);
  }
  const dialog = document.createElement("dialog"); dialog.id = "requests-modal"; dialog.className = "requests-modal"; dialog.setAttribute("aria-labelledby", "requests-modal-title"); document.body.append(dialog);
  const get = (id) => document.getElementById(id);
  const active = (ticket) => ticket === epoch && unlocked && authenticated;
  const configured = () => Boolean(cloud()?.configured);
  const requestById = (id) => rows.find((item) => String(item.id) === String(id));
  const errorMessage = (error) => error?.message || "No pudimos completar la operación. Volvé a intentar.";
  function showError(id, message) { const node = get(id); node.textContent = message; node.hidden = false; }
  function clearError(id) { const node = get(id); node.textContent = ""; node.hidden = true; }
  function notify(message, failed = false) { if (unlocked && typeof toast === "function") toast(message, failed); }
  function stopPolling() { if (poll !== null) clearInterval(poll); poll = null; }
  function startPolling() { stopPolling(); if (unlocked && authenticated) poll = setInterval(() => { if (unlocked && authenticated && !actionWorking) syncRequests(); }, 45000); }
  function closeDialog(force = false) {
    if (actionWorking && !force) return;
    if (dialog.open) dialog.close(); dialog.replaceChildren(); currentRequestId = null;
    if (previousFocus?.isConnected && !previousFocus.closest("[hidden]")) previousFocus.focus({ preventScroll: true }); previousFocus = null;
  }
  function resetSession({ preserveIncomingLink = false } = {}) {
    epoch++; stopPolling(); authenticated = false; activationRequired = false; codeSent = false; authMode = "email"; rows = []; imported = new Map(); importErrors = new Map(); syncPromise = null; syncing = false; actionWorking = false; lastSync = null;
    closeDialog(true);
    ["requests-code-form", "requests-activation-form"].forEach((id) => { get(id).reset(); delete get(id).dataset.working; });
    get("requests-email-code").value = ""; get("requests-access-token").value = ""; get("requests-code-status").textContent = ""; get("requests-activation-account").textContent = "";
    get("requests-send-code").textContent = "Enviar acceso a mi correo"; get("requests-verify-code").textContent = "Entrar a mi bandeja"; get("requests-activate-owner").textContent = "Activar mi cuenta";
    clearError("requests-code-error"); clearError("requests-activation-error");
    get("requests-login-form").reset(); delete get("requests-login-form").dataset.working; get("requests-login-submit").textContent = "Entrar a la bandeja"; get("requests-password").value = ""; get("requests-email").value = ""; get("requests-filter").value = "pending";
    ["requests-list", "requests-summary"].forEach((id) => get(id).replaceChildren()); clearError("requests-error"); clearError("requests-login-error");
    const badge = get("requests-nav-count"); if (badge) { badge.hidden = true; badge.textContent = ""; }
    // Adapter signOut clears its RAM token synchronously; late requests are invalidated there.
    try { Promise.resolve(cloud()?.signOut({ preserveIncomingLink })).catch(() => {}); } catch {}
    render();
  }
  function sessionFailure(error, ticket) {
    if (ticket !== epoch || !unlocked) return true;
    if (error?.status === 401 || error?.status === 403) {
      resetSession(); showError("requests-login-error", error.status === 403 ? "Tu cuenta no tiene acceso a esta bandeja." : "La sesión venció. Volvé a iniciar sesión."); return true;
    }
    return false;
  }
  function render() {
    const enabled = configured();
    get("requests-unconfigured").hidden = enabled;
    get("requests-login-panel").hidden = !enabled || authenticated || activationRequired;
    get("requests-activation-panel").hidden = !enabled || authenticated || !activationRequired;
    get("requests-connected").hidden = !enabled || !authenticated;
    const authBusy = ["requests-login-form", "requests-code-form", "requests-activation-form"].some((id) => get(id).dataset.working === "true");
    ["requests-login-form", "requests-code-form", "requests-activation-form"].forEach((id) => get(id).querySelectorAll("input,button").forEach((node) => { node.disabled = !enabled || !unlocked || authBusy; }));
    get("requests-code-entry").hidden = !codeSent; get("requests-email-code").required = codeSent;
    get("requests-email-code").disabled = !enabled || !unlocked || authBusy || !codeSent;
    get("requests-verify-code").hidden = !codeSent; get("requests-verify-code").disabled = !enabled || !unlocked || authBusy || !codeSent;
    get("requests-email-access").hidden = authMode !== "email"; get("requests-password-access").hidden = authMode !== "password";
    ["email", "password"].forEach((mode) => { const button = get(`requests-auth-${mode}`); button.setAttribute("aria-selected", String(authMode === mode)); button.tabIndex = authMode === mode ? 0 : -1; button.disabled = !enabled || !unlocked || authBusy; });
    const connection = get("requests-connection"); connection.classList.toggle("is-connected", authenticated); connection.lastChild.textContent = authenticated ? "Bandeja conectada" : activationRequired ? "Correo verificado" : enabled ? "Sesión cerrada" : "Conexión pendiente";
    get("requests-sync").disabled = syncing || actionWorking || !authenticated;
    get("requests-signout").disabled = false;
    if (!authenticated) return;
    get("requests-sync-state").textContent = syncing ? "Actualizando solicitudes…" : lastSync ? `Última actualización: ${new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit" }).format(lastSync)}.` : "Todavía no se actualizó la bandeja.";
    const counts = { pending: rows.filter((item) => item.status === "pending").length, approved: rows.filter((item) => item.status === "approved").length, import: rows.filter((item) => item.status === "approved" && !imported.has(String(item.id))).length };
    get("requests-summary").innerHTML = `<div><span>Pendientes de revisión</span><strong>${counts.pending}</strong></div><div><span>Aprobadas</span><strong>${counts.approved}</strong></div><div><span>Por incorporar en este equipo</span><strong>${counts.import}</strong></div>`;
    const badge = get("requests-nav-count"); if (badge) { badge.hidden = counts.pending === 0; badge.textContent = String(counts.pending); }
    const filter = get("requests-filter").value;
    const filtered = rows.filter((item) => filter === "all" || (filter === "import" ? item.status === "approved" && !imported.has(String(item.id)) : item.status === filter));
    get("requests-result-count").textContent = `${filtered.length} ${filtered.length === 1 ? "solicitud" : "solicitudes"}`;
    get("requests-list").innerHTML = filtered.length ? filtered.map(renderCard).join("") : `<div class="requests-empty"><span class="requests-large-icon">${envelopeIcon}</span><h3>${syncing ? "Consultando tu bandeja…" : "No hay solicitudes en esta vista."}</h3><p>${syncing ? "Esperá un momento." : "Las solicitudes que recibas aparecerán acá para que puedas revisarlas."}</p></div>`;
  }
  function statusInfo(row) {
    if (row.status === "approved") return imported.has(String(row.id)) ? ["Incorporada a tu cartera", "success"] : ["Aprobada · por incorporar", "purple"];
    return row.status === "rejected" ? ["Rechazada", "neutral"] : ["Pendiente de revisión", "warning"];
  }
  function renderCard(row) {
    const customer = row.customer || {}, quote = row.quote || row.approved_payload?.quote || {}, [label, style] = statusInfo(row), identifier = escape(row.id);
    const retry = row.status === "approved" && !imported.has(String(row.id));
    return `<article class="requests-card" data-request-id="${identifier}"><div class="requests-card-main"><div class="requests-card-title"><h3>${escape(customer.full_name || "Cliente sin nombre")}</h3><span class="badge badge-${style}">${label}</span></div><p class="requests-card-meta">Recibida el ${escape(dateLabel(row.created_at))} · CUIL ${escape(customer.cuil || "—")}</p><dl class="requests-card-figures"><div><dt>Solicita</dt><dd>${escape(currency(quote.principal_cents))}</dd></div><div><dt>Plazo</dt><dd>${escape(quote.term_months ?? "—")} cuotas</dd></div><div><dt>Total a devolver</dt><dd>${escape(currency(quote.total_cents))}</dd></div></dl>${importErrors.has(String(row.id)) ? '<p class="requests-import-error">La aprobación está guardada. Falta incorporar el préstamo en este equipo; podés reintentarlo.</p>' : ""}</div><div class="requests-card-actions"><button class="btn btn-secondary btn-sm" data-requests-action="review" data-request-id="${identifier}" type="button" ${syncing || actionWorking ? "disabled" : ""}>${row.status === "pending" ? "Revisar solicitud" : "Ver resumen"}</button>${retry ? `<button class="btn btn-primary btn-sm" data-requests-action="retry-import" data-request-id="${identifier}" type="button" ${syncing || actionWorking ? "disabled" : ""}>Incorporar préstamo</button>` : ""}</div></article>`;
  }
  async function importRequest(row, ticket, payload) {
    if (!active(ticket)) return null;
    const identifier = String(row.id);
    if (imported.has(identifier)) return null;
    const approved = payload || row.approved_payload || await cloud().approveRequest(row.id);
    if (!active(ticket)) return null;
    // The cloud payload is canonical. Local import validates it and deduplicates request_id.
    const result = await api("/loan-requests/import", { method: "POST", body: approved });
    if (!active(ticket)) return null;
    imported.set(identifier, result.loan?.id ?? true); importErrors.delete(identifier); return result;
  }
  function syncRequests() {
    if (!unlocked || !authenticated || !configured() || actionWorking) return Promise.resolve();
    if (syncPromise) return syncPromise;
    const ticket = epoch; syncing = true; clearError("requests-error"); render();
    const work = (async () => {
      try {
        const list = await cloud().listRequests(); if (!active(ticket)) return;
        if (!Array.isArray(list)) throw new Error("La bandeja no devolvió una lista válida. Volvé a actualizar.");
        rows = list.filter((item) => item && typeof item.id === "string" && ["pending", "approved", "rejected"].includes(item.status)).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
        let localChanged = false;
        for (const row of rows) {
          if (!active(ticket)) return;
          if (row.status !== "approved" || imported.has(String(row.id))) continue;
          try { if (await importRequest(row, ticket)) localChanged = true; }
          catch (error) { if (!active(ticket)) return; importErrors.set(String(row.id), errorMessage(error)); }
        }
        if (!active(ticket)) return;
        if (localChanged) await refresh();
        if (!active(ticket)) return; lastSync = new Date();
        if (importErrors.size) showError("requests-error", "Hay solicitudes aprobadas pendientes de incorporar en este equipo. Usá Incorporar préstamo para reintentar sin duplicarlas.");
      } catch (error) { if (!sessionFailure(error, ticket)) showError("requests-error", errorMessage(error)); }
      finally { if (ticket === epoch) { syncing = false; syncPromise = null; render(); } }
    })();
    syncPromise = work; return work;
  }
  function reviewRequest(row, trigger) {
    if (!row || !unlocked || !authenticated || syncing || actionWorking) return;
    const customer = row.customer || {}, quote = row.quote || row.approved_payload?.quote || {}, [label, style] = statusInfo(row);
    currentRequestId = String(row.id); previousFocus = trigger;
    const address = [customer.address_street, customer.address_number, customer.locality].filter(Boolean).join(" ");
    const installments = Array.isArray(quote.installments) ? quote.installments : [];
    const pending = row.status === "pending", retry = row.status === "approved" && !imported.has(String(row.id));
    dialog.innerHTML = `<div class="modal-header"><div><span class="requests-eyebrow">REVISIÓN DE SOLICITUD</span><h2 id="requests-modal-title">${escape(customer.full_name || "Solicitud de préstamo")}</h2><p>Recibida el ${escape(dateLabel(row.created_at))}</p></div><button class="btn btn-icon" data-requests-action="close-dialog" type="button" aria-label="Cerrar revisión">×</button></div><div class="modal-body requests-detail"><span class="badge badge-${style}">${label}</span><dl class="requests-customer"><div><dt>Nombre completo</dt><dd>${escape(customer.full_name || "—")}</dd></div><div><dt>CUIL</dt><dd>${escape(customer.cuil || "—")}</dd></div><div><dt>Domicilio</dt><dd>${escape(address || "—")}</dd></div><div><dt>WhatsApp</dt><dd>${escape(customer.client_whatsapp || "—")}</dd></div></dl><div class="requests-quote"><div><span>Capital solicitado</span><strong>${escape(currency(quote.principal_cents))}</strong></div><div><span>Interés aplicado · ${escape(quote.interest_percent ?? "—")}%</span><strong>${escape(currency(quote.interest_cents))}</strong></div><div><span>Ajuste de cuotas</span><strong>${escape(currency(quote.rounding_adjustment_cents))}</strong></div><div class="requests-quote-total"><span>Total a devolver</span><strong>${escape(currency(quote.total_cents))}</strong></div></div><div class="requests-schedule-header"><h3>Cronograma de cuotas</h3><p>${escape(quote.term_months ?? installments.length)} cuotas · Primer vencimiento ${escape(dateLabel(quote.first_due_date))}</p></div><div class="table-wrap requests-schedule"><table><thead><tr><th>Cuota</th><th>Vencimiento</th><th>Importe</th></tr></thead><tbody>${installments.map((item) => `<tr><td>${escape(item.number)}</td><td>${escape(dateLabel(item.due_date))}</td><td>${escape(currency(item.amount_cents))}</td></tr>`).join("") || '<tr><td colspan="3">No se recibió un cronograma válido.</td></tr>'}</tbody></table></div><p class="requests-decision-note">Después de aprobar, completá la entrega del dinero y la firma del pagaré por separado. El pagaré del registro queda pendiente de firma.</p><p class="requests-error" id="requests-modal-error" role="alert" tabindex="-1" hidden></p>${pending ? '<label class="requests-approve-check"><input type="checkbox" id="requests-approve-check"><span>Revisé los datos del cliente y el cronograma de cuotas.</span></label>' : ""}</div><div class="modal-footer requests-modal-footer"><button class="btn btn-secondary" data-requests-action="close-dialog" type="button">Volver</button>${pending ? '<button class="requests-reject-button" data-requests-action="confirm-reject" type="button">Rechazar solicitud</button><button class="btn btn-primary" id="requests-approve" data-requests-action="approve" type="button" disabled>Aprobar e incorporar</button>' : retry ? '<button class="btn btn-primary" data-requests-action="retry-current" type="button">Incorporar préstamo</button>' : ""}</div>`;
    if (!dialog.open) dialog.showModal();
  }
  function confirmRejection() {
    const row = requestById(currentRequestId); if (!row || row.status !== "pending" || actionWorking) return;
    dialog.innerHTML = `<div class="modal-header"><div><span class="requests-eyebrow">CONFIRMAR DECISIÓN</span><h2 id="requests-modal-title">¿Rechazar esta solicitud?</h2><p>${escape(row.customer?.full_name || "Cliente")}</p></div><button class="btn btn-icon" data-requests-action="close-dialog" type="button" aria-label="Cerrar">×</button></div><div class="modal-body"><p class="requests-confirm-copy">La solicitud quedará marcada como rechazada. No se incorporará un préstamo a tu cartera.</p><p class="requests-error" id="requests-modal-error" role="alert" tabindex="-1" hidden></p></div><div class="modal-footer requests-modal-footer"><button class="btn btn-secondary" data-requests-action="back-review" type="button">Volver a revisar</button><button class="btn requests-danger-button" id="requests-reject-confirm" data-requests-action="reject" type="button">Sí, rechazar solicitud</button></div>`;
  }
  function modalBusy(value) { dialog.querySelectorAll("button,input").forEach((node) => { node.disabled = value; }); if (!value && get("requests-approve")) get("requests-approve").disabled = !get("requests-approve-check")?.checked; }
  async function approveOrImport(id, approve) {
    if (!unlocked || !authenticated || actionWorking) return;
    const ticket = epoch; actionWorking = true; modalBusy(true); render();
    if (syncPromise) await syncPromise;
    if (!active(ticket)) return;
    const row = requestById(id);
    if (!row || (approve && row.status !== "pending") || (!approve && row.status !== "approved")) { actionWorking = false; modalBusy(false); render(); return; }
    clearError("requests-error"); if (get("requests-modal-error")) clearError("requests-modal-error");
    try {
      let payload = row.approved_payload;
      if (approve) { payload = await cloud().approveRequest(row.id); if (!active(ticket)) return; row.status = "approved"; row.approved_payload = payload; }
      try {
        const result = await importRequest(row, ticket, payload); if (!active(ticket)) return;
        if (result) await refresh(); if (!active(ticket)) return;
        actionWorking = false; closeDialog(); notify(approve ? "Solicitud aprobada y préstamo incorporado a tu cartera. Pagaré pendiente de firma." : "Préstamo incorporado a tu cartera.");
      } catch (error) {
        if (!active(ticket)) return;
        if (imported.has(String(row.id))) { showError("requests-error", "El préstamo ya quedó guardado en tu cartera. No pudimos actualizar la vista; volvé a actualizar."); }
        else { importErrors.set(String(row.id), errorMessage(error)); get("requests-filter").value = "import"; showError("requests-error", "La solicitud está aprobada, pero falta incorporar el préstamo en este equipo. Podés reintentar sin duplicarlo."); }
        actionWorking = false; closeDialog();
      }
    } catch (error) { if (!sessionFailure(error, ticket)) { const target = get("requests-modal-error") ? "requests-modal-error" : "requests-error"; showError(target, errorMessage(error)); } }
    finally { if (ticket === epoch) { actionWorking = false; modalBusy(false); render(); } }
  }
  async function rejectRequest() {
    if (!unlocked || !authenticated || actionWorking) return;
    const ticket = epoch, identifier = currentRequestId; actionWorking = true; modalBusy(true); render();
    if (syncPromise) await syncPromise;
    if (!active(ticket)) return;
    const row = requestById(identifier);
    if (!row || row.status !== "pending") { actionWorking = false; modalBusy(false); render(); return; }
    try { await cloud().rejectRequest(row.id); if (!active(ticket)) return; row.status = "rejected"; actionWorking = false; closeDialog(); notify("Solicitud rechazada. La decisión quedó guardada."); }
    catch (error) { if (!sessionFailure(error, ticket)) showError("requests-modal-error", errorMessage(error)); }
    finally { if (ticket === epoch) { actionWorking = false; modalBusy(false); render(); } }
  }
  function authWorking() { return ["requests-login-form", "requests-code-form", "requests-activation-form"].some((id) => get(id).dataset.working === "true"); }
  function setAuthMode(mode) {
    if (authWorking() || activationRequired) return;
    authMode = mode; get("requests-password").value = ""; get("requests-email-code").value = ""; clearError("requests-login-error"); clearError("requests-code-error"); render();
  }
  async function enterInbox(ticket) {
    if (ticket !== epoch || !unlocked) return;
    authenticated = true; activationRequired = false; codeSent = false;
    ["requests-login-form", "requests-code-form", "requests-activation-form"].forEach((id) => get(id).reset());
    get("requests-email-code").value = ""; get("requests-access-token").value = ""; get("requests-activation-account").textContent = ""; get("requests-code-status").textContent = "";
    render(); startPolling(); await syncRequests();
  }
  async function sendEmailCode() {
    const form = get("requests-code-form");
    if (!unlocked || !configured() || authWorking() || !get("requests-code-email").reportValidity()) return;
    const ticket = epoch, email = get("requests-code-email").value.trim();
    get("requests-email-code").value = ""; clearError("requests-code-error"); form.dataset.working = "true"; get("requests-send-code").textContent = "Enviando…"; get("requests-code-status").textContent = "Enviando el acceso a tu correo…"; render();
    try { await cloud().requestEmailCode(email); if (ticket !== epoch || !unlocked) return; codeSent = true; get("requests-code-status").textContent = "Revisá tu correo y tocá el enlace para volver a esta página. También podés pegarlo acá. Si el mensaje incluye un código, podés ingresarlo. Revisá correo no deseado si no lo ves."; }
    catch (error) { if (ticket === epoch && unlocked) { get("requests-code-status").textContent = ""; showError("requests-code-error", errorMessage(error)); } }
    finally { if (ticket === epoch) { delete form.dataset.working; get("requests-send-code").textContent = codeSent ? "Reenviar correo de acceso" : "Enviar acceso a mi correo"; render(); if (codeSent) get("requests-email-code").focus(); } }
  }
  async function resumeIncomingLink() {
    if (!unlocked || !configured() || typeof cloud()?.resumeEmailSignIn !== "function") return;
    const ticket = epoch, form = get("requests-code-form"); form.dataset.working = "true"; render();
    try {
      const result = await cloud().resumeEmailSignIn(); if (ticket !== epoch || !unlocked || result === null) return;
      if (result?.requiresActivation === true && result.authenticated === false) { activationRequired = true; codeSent = false; get("requests-activation-account").textContent = result.email || "Tu cuenta verificada"; render(); get("requests-access-token").focus(); }
      else if (result?.authenticated === true) await enterInbox(ticket);
      else throw new Error("No se pudo confirmar el acceso del enlace. Pedí uno nuevo con tu correo.");
    } catch (error) { if (ticket === epoch && unlocked) showError("requests-code-error", errorMessage(error)); }
    finally { if (ticket === epoch) { delete form.dataset.working; render(); if (activationRequired) get("requests-access-token").focus(); } }
  }
  get("requests-code-email").addEventListener("input", () => { codeSent = false; get("requests-email-code").value = ""; get("requests-code-status").textContent = ""; clearError("requests-code-error"); get("requests-send-code").textContent = "Enviar acceso a mi correo"; render(); });
  get("requests-code-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    if (!codeSent) { await sendEmailCode(); return; }
    if (!unlocked || !configured() || authWorking() || !form.reportValidity()) return;
    const ticket = epoch, email = get("requests-code-email").value.trim(), code = get("requests-email-code").value.trim();
    get("requests-email-code").value = ""; clearError("requests-code-error"); form.dataset.working = "true"; get("requests-verify-code").textContent = "Verificando…"; render();
    try {
      const result = await cloud().signInWithCode(email, code); if (ticket !== epoch || !unlocked) return;
      if (result?.requiresActivation === true && result.authenticated === false) { activationRequired = true; codeSent = false; form.reset(); get("requests-activation-account").textContent = email; get("requests-code-status").textContent = ""; render(); get("requests-access-token").focus(); }
      else if (result?.authenticated === true) await enterInbox(ticket);
      else throw new Error("No se pudo confirmar tu acceso. Volvé a pedir un código.");
    } catch (error) { if (ticket === epoch && unlocked) showError("requests-code-error", errorMessage(error)); }
    finally { if (ticket === epoch) { delete form.dataset.working; get("requests-verify-code").textContent = "Entrar a mi bandeja"; render(); if (activationRequired) get("requests-access-token").focus(); } }
  });
  get("requests-activation-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    if (!unlocked || !configured() || !activationRequired || authWorking() || !form.reportValidity()) return;
    const ticket = epoch, accessToken = get("requests-access-token").value.trim();
    get("requests-access-token").value = ""; clearError("requests-activation-error"); form.dataset.working = "true"; get("requests-activate-owner").textContent = "Activando…"; render();
    try { const result = await cloud().activateOwner(accessToken); if (ticket !== epoch || !unlocked) return; if (result?.authenticated !== true) throw new Error("No se pudo confirmar el acceso a tu bandeja. Volvé a intentar."); await enterInbox(ticket); }
    catch (error) {
      if (ticket !== epoch || !unlocked) return;
      if (error?.status === 401) { resetSession(); showError("requests-code-error", "La verificación venció. Pedí un nuevo enlace a tu correo para entrar."); }
      else showError("requests-activation-error", errorMessage(error));
    } finally { if (ticket === epoch) { delete form.dataset.working; get("requests-activate-owner").textContent = "Activar mi cuenta"; render(); } }
  });
  get("requests-login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    if (!unlocked || !configured() || authWorking() || !form.reportValidity()) return;
    const ticket = epoch, email = get("requests-email").value.trim(), password = get("requests-password").value;
    get("requests-password").value = ""; clearError("requests-login-error"); form.dataset.working = "true"; get("requests-login-submit").textContent = "Conectando…"; render();
    try { const result = await cloud().signIn(email, password); if (ticket !== epoch || !unlocked) return; if (result?.authenticated !== true) throw new Error("No se pudo confirmar tu acceso a la bandeja."); await enterInbox(ticket); }
    catch (error) { if (ticket === epoch && unlocked) showError("requests-login-error", error?.status === 403 ? "Tu cuenta no tiene acceso a esta bandeja." : errorMessage(error)); }
    finally { if (ticket === epoch) { delete form.dataset.working; get("requests-login-submit").textContent = "Entrar a la bandeja"; render(); } }
  });
  get("requests-filter").addEventListener("change", render);
  document.addEventListener("change", (event) => { if (event.target.id === "requests-approve-check" && get("requests-approve")) get("requests-approve").disabled = !event.target.checked || actionWorking; });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-requests-action]"); if (!button || button.disabled) return;
    const action = button.dataset.requestsAction;
    if (action === "auth-email") setAuthMode("email");
    else if (action === "auth-password") setAuthMode("password");
    else if (action === "send-code") sendEmailCode();
    else if (action === "change-account") resetSession();
    else if (action === "sync") syncRequests();
    else if (action === "signout") resetSession();
    else if (action === "review") reviewRequest(requestById(button.dataset.requestId), button);
    else if (action === "retry-import") approveOrImport(button.dataset.requestId, false);
    else if (action === "close-dialog") closeDialog();
    else if (action === "confirm-reject") confirmRejection();
    else if (action === "back-review") reviewRequest(requestById(currentRequestId), previousFocus);
    else if (action === "approve") { if (get("requests-approve-check")?.checked) approveOrImport(currentRequestId, true); }
    else if (action === "retry-current") approveOrImport(currentRequestId, false);
    else if (action === "reject") rejectRequest();
  });
  section.addEventListener("keydown", (event) => {
    if (!event.target.closest(".requests-auth-tabs") || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const mode = event.key === "Home" ? "email" : event.key === "End" ? "password" : authMode === "email" ? "password" : "email";
    setAuthMode(mode); get(`requests-auth-${authMode}`).focus();
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
  window.addEventListener("nicolas:locked", () => { unlocked = false; resetSession(); });
  window.addEventListener("nicolas:unlocked", () => { resetSession({ preserveIncomingLink: true }); unlocked = true; render(); resumeIncomingLink(); });
  window.addEventListener("hashchange", () => { if (location.hash === "#requests") render(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && unlocked && authenticated) syncRequests(); });
  render();
  const bootEpoch = epoch;
  window.NicolasStore?.status().then((status) => { if (epoch !== bootEpoch) return; unlocked = Boolean(status.unlocked); render(); if (unlocked) resumeIncomingLink(); }).catch(() => {});
  if (location.hash === "#requests" && typeof navigate === "function") navigate("requests");
})();
