/* Owner-only activation helper. Email and prepared SQL stay in memory. The only
 * network operation is an empty, deliberately invalid submission to test the RPC. */
(() => {
  "use strict";
  const get = (id) => document.getElementById(id);
  const form = get("setup-email-form"), emailInput = get("setup-owner-email"), output = get("setup-sql-output");
  let projectUrl = "", publicKey = "", migration = "", ready = false, working = false, controller = null, probeGeneration = 0;
  const config = window.NicolasSetupConfig;
  function feedback(message, state) { const node = get("setup-probe-status"); node.textContent = message; node.dataset.state = state; node.hidden = false; }
  function clearPreparedSql() { output.value = ""; get("setup-sql-panel").hidden = true; get("setup-copy-status").textContent = ""; get("setup-email-error").textContent = ""; get("setup-email-error").hidden = true; }
  function enableLink(id, href) { const link = get(id); link.href = href; link.removeAttribute("aria-disabled"); }
  function configure() {
    try {
      if (!config || typeof config.supabase_url !== "string" || typeof config.publishable_key !== "string" || typeof config.migration_sql !== "string") throw new Error();
      const url = new URL(config.supabase_url);
      if (url.protocol !== "https:" || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.port || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error();
      if (!config.publishable_key.trim() || /[\r\n]/.test(config.publishable_key)) throw new Error();
      migration = config.migration_sql.trimEnd();
      if (!/\bbegin\s*;/i.test(migration) || !/\bcommit\s*;\s*$/i.test(migration)) throw new Error();
      projectUrl = url.origin; publicKey = config.publishable_key.trim();
      const projectRef = url.hostname.split(".")[0];
      enableLink("setup-users-link", `https://supabase.com/dashboard/project/${projectRef}/auth/users`);
      enableLink("setup-sql-link", `https://supabase.com/dashboard/project/${projectRef}/sql/new`);
      emailInput.disabled = false; get("setup-generate-sql").disabled = false; get("setup-check").disabled = false; ready = true;
      if (config.application_enabled === true) {
        document.querySelector(".setup-heading").innerHTML = '<span class="setup-eyebrow">SOLICITUDES CONECTADAS</span><h1>Entrá a tu bandeja<span>.</span></h1><p>La recepción ya está configurada. No necesitás volver a instalar el código SQL.</p>';
        document.querySelector(".setup-steps").hidden = true;
        const section = document.createElement("section");
        section.className = "setup-step";
        section.innerHTML = '<section><h2>Tu acceso a Nicolás</h2><p>Usá el correo de tu cuenta de Supabase. Abrí el enlace que recibas para verificar tu correo. La primera vez, autorizá tu cuenta con el token personal de acceso que creaste en Supabase.</p><p class="setup-help">La cartera y los adjuntos se guardan en tu navegador. Si venías usando el archivo descargado, guardá una copia cifrada e importala para usar tus registros en la versión web.</p><div class="setup-sql-actions"><a class="setup-button setup-button-primary" href="https://ignaciomenes-afk.github.io/nicolas/privado/#requests">Abrir Nicolás</a><a class="setup-button setup-button-secondary" href="https://github.com/ignaciomenes-afk/nicolas/raw/refs/heads/codex/web-privada-descargable/entrega/Nicolas-prestamos.zip" rel="noopener noreferrer">Actualizar mi archivo de Nicolás</a></div></section>';
        document.querySelector(".setup-steps").after(section);
      }
    } catch {
      get("setup-config-error").textContent = "Esta página todavía no tiene todos los datos de instalación. Volvé al chat para recibir el enlace de activación completo.";
      get("setup-config-error").hidden = false;
    }
  }
  function buildSql(email) {
    const literal = `'${email.replace(/'/g, "''")}'`;
    // Dollar delimiters can occur in valid email local parts. Pick a tag absent
    // from the address so an address cannot terminate the DO body prematurely.
    let tag = "$nicolas_setup_owner$", suffix = 0;
    while (email.includes(tag)) tag = `$nicolas_setup_owner_${++suffix}$`;
    const installation = migration.replace(/\bcommit\s*;\s*$/i, "").trimEnd();
    return `${installation}\n\n-- Autorizar la cuenta de administración creada en Supabase.\ndo ${tag}\ndeclare\n  v_matching_users bigint;\n  v_owner_id uuid;\nbegin\n  select count(*) into v_matching_users\n  from auth.users\n  where lower(email) = lower(${literal});\n\n  if v_matching_users <> 1 then\n    raise exception 'Debe existir exactamente una cuenta de administración con ese correo. Revisá el paso 1 y el correo ingresado.';\n  end if;\n\n  select id into strict v_owner_id\n  from auth.users\n  where lower(email) = lower(${literal});\n\n  insert into nicolas_private.owner_users (user_id)\n  values (v_owner_id)\n  on conflict (user_id) do nothing;\nend;\n${tag};\n\ncommit;\n`;
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault(); clearPreparedSql();
    if (!ready) return;
    const email = emailInput.value.trim();
    emailInput.value = email;
    if (!email || email.length > 254 || !form.reportValidity()) {
      get("setup-email-error").textContent = "Revisá el correo de tu cuenta de administración."; get("setup-email-error").hidden = false; return;
    }
    // Native email validation excludes newlines and backslashes. Check again for
    // controls before embedding a literal in a user-owned SQL console.
    if (/[\u0000-\u0020\u007f\\]/.test(email)) { get("setup-email-error").textContent = "Ingresá un correo válido, sin espacios."; get("setup-email-error").hidden = false; return; }
    output.value = buildSql(email); get("setup-sql-panel").hidden = false;
    get("setup-copy-status").textContent = "Instalación lista. Copiá el texto completo y ejecutalo en tu proyecto.";
  });
  emailInput.addEventListener("input", clearPreparedSql);
  get("setup-copy-sql").addEventListener("click", async () => {
    if (!ready || !output.value || get("setup-sql-panel").hidden) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(output.value);
      get("setup-copy-status").textContent = "Instalación copiada. Abrí el editor SQL, pegá todo el texto y tocá Run.";
    } catch {
      output.focus(); output.select(); output.setSelectionRange(0, output.value.length);
      get("setup-copy-status").textContent = "El texto quedó seleccionado. Copialo con Ctrl+C o Cmd+C. En el celular, mantené presionado el texto y elegí Copiar.";
    }
  });
  get("setup-check").addEventListener("click", async () => {
    if (!ready || working) return;
    working = true; const ownGeneration = ++probeGeneration;
    get("setup-check").disabled = true; get("setup-check").textContent = "Comprobando…"; get("setup-check").setAttribute("aria-busy", "true");
    feedback("Comprobando la recepción de tu proyecto. Puede tardar hasta 20 segundos…", "working");
    controller = new AbortController(); const timeout = setTimeout(() => controller?.abort(), 20000);
    try {
      const headers = { apikey: publicKey, "Content-Type": "application/json" };
      if (!publicKey.startsWith("sb_publishable_")) headers.Authorization = `Bearer ${publicKey}`;
      const response = await fetch(`${projectUrl}/rest/v1/rpc/nicolas_submit_request`, {
        method: "POST", headers, body: JSON.stringify({ p_payload: {} }),
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (ownGeneration !== probeGeneration) return;
      if (response.status === 400 && data?.code === "PT400" && data.message === "Invalid request fields.") {
        feedback("La recepción de solicitudes está instalada.\n\nVolvé al chat y escribí «Instalado». Falta verificar el acceso de tu cuenta de administración y habilitar las páginas para terminar la conexión.", "success");
      } else if (response.status === 404 || data?.code === "PGRST202") {
        feedback("Todavía falta instalar la recepción. Copiá el texto completo del paso 2, pegalo en el editor SQL y ejecutalo con Run. Después volvé a comprobar; la actualización puede tardar unos segundos.", "error");
      } else if (response.status === 401) {
        feedback("El proyecto rechazó la clave pública de conexión. Volvé al chat para revisar la conexión configurada e indicá que la comprobación devolvió 401.", "error");
      } else if (response.status === 403) {
        feedback("El proyecto no permitió realizar la comprobación. Volvé al chat e indicá que la comprobación devolvió 403.", "error");
      } else if (response.status === 429) {
        feedback("El proyecto recibió demasiados intentos. Esperá un momento y volvé a comprobar.", "error");
      } else if (response.status >= 500) {
        feedback("El proyecto no pudo responder correctamente. Esperá un momento y volvé a comprobar. Si continúa, contalo en el chat.", "error");
      } else {
        feedback("La respuesta no permite confirmar esta instalación. Ejecutá el SQL completo del paso 2 y volvé a comprobar. Si continúa, volvé al chat para revisar la conexión.", "error");
      }
    } catch (error) {
      if (ownGeneration !== probeGeneration) return;
      feedback(error?.name === "AbortError" ? "La comprobación superó los 20 segundos. Revisá tu conexión y volvé a intentar." : "El navegador no pudo conectar con tu proyecto. Revisá la conexión a internet y cualquier bloqueo de red del navegador. Volvé a intentar; si continúa, contalo en el chat.", "error");
    } finally {
      clearTimeout(timeout);
      if (ownGeneration === probeGeneration) { controller = null; working = false; get("setup-check").disabled = !ready; get("setup-check").textContent = "Comprobar instalación"; get("setup-check").setAttribute("aria-busy", "false"); }
    }
  });
  window.addEventListener("pagehide", () => { probeGeneration++; controller?.abort(); controller = null; working = false; emailInput.value = ""; clearPreparedSql(); get("setup-check").disabled = !ready; get("setup-check").textContent = "Comprobar instalación"; get("setup-check").setAttribute("aria-busy", "false"); });
  configure();
})();
