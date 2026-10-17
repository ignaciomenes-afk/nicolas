/* Privacy UI. Load after NicolasStore and app.js with body.vault-locked.
 * Store owns encryption and dispatches nicolas:unlocked / nicolas:locked on window.
 * Controls use data-private-action so they never collide with business actions.
 */
(() => {
  "use strict";
  const store = window.NicolasStore;
  const el = (id) => document.getElementById(id);
  const lockIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
  const downloadIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg>';
  const arrowIcon = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>';
  let exists = false, accessWorking = false, restoreWorking = false;
  let sequence = 0, activeInspection = 0, inspected = null, encryptedBackup = "", currentBackedUp = false, returnFocus = null;
  const appNodes = [document.querySelector(".app-shell"), el("sidebar"), document.querySelector(".skip-link")].filter(Boolean);
  const gate = document.createElement("section");
  gate.id = "privacy-gate";
  gate.setAttribute("aria-label", "Acceso privado a Nicolás");
  gate.innerHTML = `<div class="privacy-layout"><div class="privacy-story">
    <div class="privacy-brand"><span class="privacy-brand-mark">N<span></span></span><span>nicolás<span>GESTIÓN DE NEGOCIOS</span></span></div>
    <div class="privacy-story-main"><span class="privacy-kicker">TU ESPACIO PRIVADO</span><h1>Tu negocio.<br> Solo para vos<span>.</span></h1><p>Ventas, productos y clientes en un solo lugar. Abrí tu archivo y seguí donde lo dejaste.</p><div class="privacy-illustration" aria-hidden="true"><div class="privacy-orbit"></div><div class="privacy-mini-card"><div><span class="privacy-mini-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 17 6-6 4 4 8-10m-6 0h6v6"/></svg></span><span class="privacy-mini-label">Tu negocio, en orden</span><span class="privacy-mini-dot"></span></div><strong>Cada día, más simple.</strong><div class="privacy-bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div><span class="privacy-lock-badge">${lockIcon}</span></div></div><p class="privacy-story-footer">Sin instalaciones. Sin conexión. A tu ritmo.</p></div>
    <div class="privacy-access"><div class="privacy-form-card"><span class="privacy-access-icon">${lockIcon}</span><p class="privacy-kicker" id="privacy-access-kicker">BIENVENIDO A NICOLÁS</p><h2 id="privacy-access-title">Preparando tu espacio…</h2><p class="privacy-access-description" id="privacy-access-description">Comprobando el almacenamiento de este navegador.</p>
    <form id="privacy-access-form" hidden><label class="privacy-field" for="privacy-password"><span>Contraseña</span><span class="privacy-password-wrap"><input id="privacy-password" type="password" autocomplete="new-password" required minlength="8" aria-describedby="privacy-password-help"><button class="privacy-reveal" data-private-action="reveal-password" type="button" aria-label="Mostrar contraseña" aria-pressed="false">Mostrar</button></span><small id="privacy-password-help">Al menos 8 caracteres.</small></label><label class="privacy-field" id="privacy-repeat-field" for="privacy-password-repeat"><span>Repetí la contraseña</span><input id="privacy-password-repeat" type="password" autocomplete="new-password" minlength="8"></label><div class="privacy-error" id="privacy-access-error" role="alert" tabindex="-1" hidden></div><button class="privacy-primary" id="privacy-submit" type="submit">Crear mi espacio privado</button></form>
    <div class="privacy-local-note"><span class="privacy-note-icon">${lockIcon}</span><p>Tus registros se guardan <strong>cifrados en este navegador y equipo</strong>. No se sincronizan con la nube.</p></div><p class="privacy-password-note" id="privacy-password-note">Conservá tu contraseña: no podemos recuperarla.</p><div class="privacy-restore-entry" id="privacy-restore-entry" hidden><span>¿Ya tenés una copia?</span><button type="button" class="privacy-text-button" data-private-action="restore">Importar mi copia de seguridad ${arrowIcon}</button></div><p class="privacy-browser-note">Usá siempre este navegador. Guardá copias; borrar sus datos borra los registros locales.</p></div><span class="privacy-access-footer">nicolás · Tu negocio, en orden.</span></div></div>`;
  document.body.append(gate);
  const dialog = document.createElement("dialog");
  dialog.id = "privacy-modal";
  dialog.setAttribute("aria-labelledby", "privacy-restore-title");
  dialog.innerHTML = `<div class="privacy-dialog-header"><div><span class="privacy-kicker">COPIA DE SEGURIDAD</span><h2 id="privacy-restore-title">Restaurar tus registros</h2><p>Elegí una copia de Nicolás y revisá su contenido antes de continuar.</p></div><button class="privacy-close" data-private-action="close-restore" type="button" aria-label="Cerrar restauración">×</button></div><form id="privacy-restore-form"><div class="privacy-dialog-body"><label class="privacy-field" for="privacy-backup-file"><span>Archivo de copia (.json)</span><input type="file" id="privacy-backup-file" accept=".json,application/json" required><small>Elegí una copia cifrada descargada desde Nicolás. Máximo: 96 MB.</small></label><label class="privacy-field" for="privacy-backup-password"><span>Contraseña de esa copia</span><input type="password" id="privacy-backup-password" autocomplete="off" required><small>La contraseña que usabas cuando descargaste la copia.</small></label><div class="privacy-error" id="privacy-restore-error" role="alert" tabindex="-1" hidden></div><button class="privacy-secondary" id="privacy-inspect" type="submit">Revisar copia</button><section class="privacy-preview" id="privacy-backup-preview" aria-live="polite" hidden><h3>Copia lista para restaurar</h3><p id="privacy-backup-date"></p><dl class="privacy-counts"><div><dt>Productos</dt><dd id="privacy-products-count">0</dd></div><div><dt>Clientes</dt><dd id="privacy-clients-count">0</dd></div><div><dt>Ventas</dt><dd id="privacy-invoices-count">0</dd></div></dl><p class="privacy-replace-note" id="privacy-replace-note"></p><div class="privacy-before-restore" id="privacy-before-restore" hidden><button class="privacy-secondary" data-private-action="save-before-restore" id="privacy-save-before-restore" type="button">${downloadIcon} Descargar copia de mis datos actuales</button><p id="privacy-save-before-note">Primero guardá una copia actual para poder volver atrás.</p></div><label class="privacy-confirm-check" for="privacy-confirm-replace"><input type="checkbox" id="privacy-confirm-replace"><span id="privacy-confirm-label">Confirmo que quiero restaurar esta copia.</span></label><button class="privacy-primary" id="privacy-confirm-restore" data-private-action="confirm-restore" type="button" disabled>Restaurar esta copia</button></section></div><div class="privacy-dialog-footer"><button class="privacy-text-button" data-private-action="close-restore" type="button">Cancelar</button><span>Las copias conservan el cifrado de tus datos.</span></div></form>`;
  document.body.append(dialog);
  const notice = document.createElement("div");
  notice.id = "privacy-notice"; notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite");
  document.body.append(notice);
  const toolbar = document.createElement("div");
  toolbar.className = "privacy-toolbar";
  toolbar.innerHTML = `<span class="privacy-save-status"><i></i>Guardado en este navegador</span><button class="privacy-tool" type="button" data-private-action="backup" title="Descargar una copia cifrada de todos tus registros">${downloadIcon}<span>Copia de seguridad</span></button><button class="privacy-tool" type="button" data-private-action="restore">Restaurar</button><button class="privacy-tool privacy-tool-lock" type="button" data-private-action="lock">${lockIcon}<span>Bloquear</span></button>`;
  const toolbarHost = document.querySelector(".topbar-end");
  if (toolbarHost) { toolbarHost.replaceChildren(toolbar); toolbarHost.classList.add("privacy-topbar-end"); toolbarHost.closest(".topbar")?.classList.add("privacy-topbar"); }

  function setLocked(locked) {
    document.body.classList.toggle("vault-locked", locked); gate.hidden = !locked;
    appNodes.forEach((node) => { node.inert = locked; node.hidden = locked; });
    if (locked) { if (el("overlay")) el("overlay").hidden = true; if (el("modal")?.open) el("modal").close(); }
  }
  setLocked(true);
  function errorAt(id, error) { const node = el(id); node.textContent = error instanceof Error ? error.message : String(error || "No se pudo completar la operación."); node.hidden = false; node.focus(); }
  function clearError(id) { el(id).textContent = ""; el(id).hidden = true; }
  function tell(message) { notice.textContent = message; notice.classList.add("visible"); clearTimeout(tell.timer); tell.timer = setTimeout(() => notice.classList.remove("visible"), 6000); }
  function clearPasswords() {
    el("privacy-password").value = ""; el("privacy-password-repeat").value = "";
    el("privacy-password").type = "password"; el("privacy-password-repeat").type = "password";
    const button = gate.querySelector("[data-private-action='reveal-password']"); button.textContent = "Mostrar"; button.setAttribute("aria-label", "Mostrar contraseña"); button.setAttribute("aria-pressed", "false");
  }
  function workingAccess(value) {
    accessWorking = value;
    el("privacy-access-form").querySelectorAll("input,button").forEach((node) => { node.disabled = value; });
    gate.querySelector("[data-private-action='restore']").disabled = value;
    el("privacy-submit").setAttribute("aria-busy", String(value));
    el("privacy-submit").textContent = value ? "Un momento…" : exists ? "Desbloquear mi espacio" : "Crear mi espacio privado";
  }
  async function updateAccess(focus = false) {
    try {
      if (!store) throw new Error("Abrí este archivo en una versión actual de Chrome, Edge, Firefox o Safari para usar Nicolás.");
      const status = await store.status(); exists = Boolean(status.exists);
      if (status.unlocked) { setLocked(false); return; }
      setLocked(true); el("privacy-access-form").hidden = false;
      el("privacy-access-kicker").textContent = exists ? "QUÉ BUENO VERTE DE NUEVO" : "BIENVENIDO A NICOLÁS";
      el("privacy-access-title").textContent = exists ? "Volvé a tu negocio." : "Empezá por tu contraseña.";
      el("privacy-access-description").textContent = exists ? "Tus registros están acá. Ingresá tu contraseña para continuar." : "Creá tu espacio privado en este navegador. Solo vas a necesitar esta contraseña para entrar.";
      el("privacy-password").autocomplete = exists ? "current-password" : "new-password";
      el("privacy-password").minLength = exists ? 1 : 8;
      el("privacy-password-help").textContent = exists ? "La contraseña que elegiste al crear tu espacio." : "Al menos 8 caracteres. Elegí una contraseña que puedas recordar.";
      el("privacy-repeat-field").hidden = exists; el("privacy-password-repeat").required = !exists;
      el("privacy-restore-entry").hidden = exists;
      el("privacy-password-note").textContent = exists ? "Para restaurar una copia, primero desbloqueá este espacio. La contraseña no tiene recuperación." : "Conservá tu contraseña: no podemos recuperarla.";
      workingAccess(false); if (focus) el("privacy-password").focus();
    } catch (error) {
      setLocked(true); el("privacy-access-title").textContent = "No se pudo abrir el espacio.";
      el("privacy-access-description").textContent = error.message || "No se pudo acceder al almacenamiento del navegador. Abrí el archivo en un navegador actual, fuera de la vista previa del gestor de archivos.";
      el("privacy-access-form").hidden = true; el("privacy-restore-entry").hidden = true;
    }
  }
  el("privacy-access-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (accessWorking) return; clearError("privacy-access-error");
    const password = el("privacy-password").value;
    if (!exists && password.length < 8) return errorAt("privacy-access-error", "Elegí una contraseña de al menos 8 caracteres.");
    if (!exists && password !== el("privacy-password-repeat").value) return errorAt("privacy-access-error", "Las contraseñas no coinciden. Revisalas e intentá de nuevo.");
    workingAccess(true);
    try { if (exists) await store.unlock(password); else await store.create(password); clearPasswords(); exists = true; setLocked(false); const main = el("main"); if (main) { main.setAttribute("tabindex", "-1"); main.focus({ preventScroll: true }); } }
    catch (error) { errorAt("privacy-access-error", error); }
    finally { workingAccess(false); }
  });
  async function downloadBackup() {
    const json = await store.exportBackup();
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url;
    const now = new Date(), pad = (n) => String(n).padStart(2, "0");
    link.download = `nicolas-copia-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    tell("Copia descargada. Guardala en un lugar seguro junto con su contraseña.");
  }
  function invalidatePreview() {
    inspected = null; currentBackedUp = false; el("privacy-backup-preview").hidden = true;
    el("privacy-confirm-replace").checked = false; el("privacy-confirm-restore").disabled = true;
    el("privacy-save-before-restore").disabled = false;
    el("privacy-save-before-restore").innerHTML = `${downloadIcon} Descargar copia de mis datos actuales`;
    el("privacy-save-before-note").textContent = "Primero guardá una copia actual para poder volver atrás.";
    ["products", "clients", "invoices"].forEach((name) => { el(`privacy-${name}-count`).textContent = "0"; });
    el("privacy-backup-date").textContent = "";
  }
  function updateRestoreReady() { el("privacy-confirm-restore").disabled = !inspected || !el("privacy-confirm-replace").checked || (exists && !currentBackedUp) || restoreWorking; }
  function closeRestore() {
    if (restoreWorking) return;
    sequence++; if (dialog.open) dialog.close(); el("privacy-restore-form").reset(); encryptedBackup = "";
    invalidatePreview(); clearError("privacy-restore-error");
    el("privacy-restore-form").querySelectorAll("input,button").forEach((node) => { node.disabled = false; });
    el("privacy-confirm-restore").disabled = true; el("privacy-inspect").textContent = "Revisar copia"; el("privacy-confirm-restore").textContent = "Restaurar esta copia";
    if (returnFocus?.isConnected && !returnFocus.closest("[hidden]")) returnFocus.focus({ preventScroll: true }); returnFocus = null;
  }
  async function openRestore(trigger) {
    if (accessWorking || restoreWorking) return;
    const status = await store.status(); exists = Boolean(status.exists);
    if (exists && !status.unlocked) return tell("Primero desbloqueá tu espacio con su contraseña para restaurar una copia.");
    if (typeof dialog.showModal !== "function") return tell("Actualizá tu navegador para importar una copia de seguridad.");
    closeRestore(); returnFocus = trigger;
    el("privacy-replace-note").textContent = exists ? "Al restaurar se reemplazarán todos los registros actuales por los de esta copia. Tu contraseña de acceso actual se conserva." : "Esta copia se guardará cifrada en este navegador. Vas a usar la contraseña de la copia para entrar.";
    el("privacy-confirm-label").textContent = exists ? "Confirmo que quiero reemplazar mis registros actuales por esta copia." : "Confirmo que quiero importar estos registros a este navegador.";
    el("privacy-before-restore").hidden = !exists; dialog.showModal(); el("privacy-backup-file").focus();
  }
  el("privacy-backup-file").addEventListener("change", () => { sequence++; encryptedBackup = ""; invalidatePreview(); clearError("privacy-restore-error"); });
  el("privacy-backup-password").addEventListener("input", () => { sequence++; invalidatePreview(); clearError("privacy-restore-error"); });
  el("privacy-confirm-replace").addEventListener("change", updateRestoreReady);
  el("privacy-restore-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (restoreWorking) return; clearError("privacy-restore-error"); invalidatePreview();
    const selected = el("privacy-backup-file").files[0];
    if (!selected) return errorAt("privacy-restore-error", "Elegí el archivo de copia que querés revisar.");
    if (selected.size > 96 * 1024 * 1024) return errorAt("privacy-restore-error", "El archivo supera los 96 MB. Elegí una copia de Nicolás de menor tamaño.");
    const password = el("privacy-backup-password").value, ownSequence = ++sequence;
    activeInspection = ownSequence;
    el("privacy-inspect").disabled = true; el("privacy-inspect").textContent = "Revisando…";
    try {
      const text = await selected.text(), preview = await store.inspectBackup(text, password);
      if (ownSequence !== sequence || !dialog.open) return;
      encryptedBackup = text; inspected = preview;
      ["products", "clients", "invoices"].forEach((name) => { el(`privacy-${name}-count`).textContent = String(preview[`${name}_count`] ?? 0); });
      const saved = new Date(preview.updated_at || preview.created_at);
      el("privacy-backup-date").textContent = Number.isNaN(saved.getTime()) ? "Contenido verificado correctamente." : `Datos guardados el ${new Intl.DateTimeFormat("es-AR", { dateStyle: "long", timeStyle: "short" }).format(saved)}.`;
      el("privacy-backup-preview").hidden = false; updateRestoreReady();
    } catch (error) { if (ownSequence === sequence && dialog.open) errorAt("privacy-restore-error", error); }
    finally { if (ownSequence === activeInspection) { el("privacy-inspect").disabled = false; el("privacy-inspect").textContent = "Revisar copia"; } }
  });
  async function confirmRestore() {
    if (!inspected || el("privacy-confirm-restore").disabled || restoreWorking) return;
    clearError("privacy-restore-error"); restoreWorking = true;
    const backup = encryptedBackup, password = el("privacy-backup-password").value;
    el("privacy-restore-form").querySelectorAll("input,button").forEach((node) => { node.disabled = true; });
    dialog.querySelector(".privacy-close").disabled = true; el("privacy-confirm-restore").textContent = "Restaurando…";
    try { await store.restoreBackup(backup, password); exists = true; restoreWorking = false; closeRestore(); setLocked(false); clearPasswords(); tell("Copia restaurada. Tus registros ya están guardados en este navegador."); }
    catch (error) { restoreWorking = false; errorAt("privacy-restore-error", error); el("privacy-restore-form").querySelectorAll("input,button").forEach((node) => { node.disabled = false; }); el("privacy-confirm-restore").textContent = "Restaurar esta copia"; updateRestoreReady(); }
    finally { restoreWorking = false; dialog.querySelector(".privacy-close").disabled = false; }
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-private-action]"); if (!button || button.disabled) return;
    try {
      switch (button.dataset.privateAction) {
        case "reveal-password": { const show = el("privacy-password").type === "password"; el("privacy-password").type = show ? "text" : "password"; el("privacy-password-repeat").type = show ? "text" : "password"; button.textContent = show ? "Ocultar" : "Mostrar"; button.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña"); button.setAttribute("aria-pressed", String(show)); break; }
        case "lock": store.lock(); break;
        case "backup": button.disabled = true; try { await downloadBackup(); } finally { button.disabled = false; } break;
        case "restore": await openRestore(button); break;
        case "close-restore": closeRestore(); break;
        case "save-before-restore": button.disabled = true; try { await downloadBackup(); currentBackedUp = true; button.textContent = "✓ Copia actual descargada"; el("privacy-save-before-note").textContent = "Conservá ese archivo para recuperar tus registros actuales si lo necesitás."; updateRestoreReady(); } catch (error) { button.disabled = false; throw error; } break;
        case "confirm-restore": await confirmRestore(); break;
      }
    } catch (error) { if (dialog.open) errorAt("privacy-restore-error", error); else tell(error.message || "No se pudo completar la operación."); }
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!restoreWorking) closeRestore(); });
  window.addEventListener("nicolas:unlocked", () => { exists = true; clearPasswords(); clearError("privacy-access-error"); setLocked(false); });
  window.addEventListener("nicolas:locked", () => { restoreWorking = false; closeRestore(); clearPasswords(); clearError("privacy-access-error"); notice.textContent = ""; notice.classList.remove("visible"); setLocked(true); updateAccess(true); });
  updateAccess();
})();
