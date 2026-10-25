/* Shared Supabase transport. Public configuration only; owner sessions live in RAM. */
(function () {
  "use strict";
  // Consume provider fragments synchronously, before any asynchronous work or
  // application navigation. Only the access token is retained, never refresh tokens.
  function captureIncomingLink() {
    try {
      const fragment = window.location?.hash;
      if (!fragment) return null;
      if (fragment.length > 32768) {
        if (/(?:^#|&)(?:access_token|error|error_code|error_description)=/.test(fragment)) {
          const cleanPath = String(window.location.pathname || "/") + "#requests";
          try { window.history.replaceState(null, "", cleanPath); } catch (_) { try { window.location.replace(cleanPath); } catch (_) {} }
          return { invalid: true };
        }
        return null;
      }
      const values = new URL("https://callback.invalid/?" + fragment.replace(/^#/, "")).searchParams;
      if (!values.has("access_token") && !values.has("error") && !values.has("error_code") && !values.has("error_description")) return null;
      const cleanPath = String(window.location.pathname || "/") + "#requests";
      try { window.history.replaceState(null, "", cleanPath); }
      catch (_) { try { window.location.replace(cleanPath); } catch (_) {} }
      if (values.has("error") || values.has("error_code") || values.has("error_description")) return { invalid: true };
      const accessToken = values.get("access_token"), seconds = Number(values.get("expires_in"));
      if (typeof accessToken !== "string" || accessToken.length < 16 || accessToken.length > 16384 || /[\r\n\s]/.test(accessToken) || !Number.isFinite(seconds) || seconds <= 0 || (values.get("token_type") || "bearer").toLowerCase() !== "bearer") return { invalid: true };
      const expiresAt = Date.now() + Math.min(seconds, 86400) * 1000;
      const providerExpiry = Number(values.get("expires_at"));
      return { accessToken, expiresAt: providerExpiry > 0 && Number.isFinite(providerExpiry) ? Math.min(expiresAt, providerExpiry * 1000) : expiresAt };
    } catch (_) { return null; }
  }
  let incomingLink = captureIncomingLink();
  const ownerRedirect = "https://ignaciomenes-afk.github.io/nicolas/privado/";
  const supplied = window.NicolasCloudConfig || {};
  let origin = "", key = "", legacyKey = false;
  try {
    const endpoint = new URL(supplied.supabase_url);
    if (endpoint.protocol === "https:" && !endpoint.username && !endpoint.password &&
        !endpoint.port && !endpoint.search && !endpoint.hash && endpoint.pathname === "/") origin = endpoint.origin;
    if (typeof supplied.publishable_key === "string") {
      if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(supplied.publishable_key)) key = supplied.publishable_key;
      else if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(supplied.publishable_key)) {
        const part = supplied.publishable_key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
        if (claims.role === "anon") { key = supplied.publishable_key; legacyKey = true; }
      }
    }
  } catch (_) { origin = ""; key = ""; }
  const configured = supplied.enabled === true && Boolean(origin && key);
  const config = Object.freeze({ enabled: configured, supabase_url: origin, publishable_key: key });
  let session = null, generation = 0;

  function failure(status, message) { const error = new Error(message); error.status = status; return error; }
  function clearSession(options = {}) { generation += 1; session = null; if (options?.preserveIncomingLink !== true) incomingLink = null; }
  function requireConfiguration() {
    if (!configured) throw failure(503, "La bandeja en línea todavía no está configurada.");
  }
  function requireSession() {
    if (!session || Date.now() >= session.expiresAt) {
      clearSession(); throw failure(401, "Ingresá nuevamente para acceder a las solicitudes.");
    }
    return session;
  }
  function safeError(status, body) {
    if (status === 409 && body?.details === "stale_first_due_date") return failure(409, "La primera cuota ya no es futura. Pedí al cliente una nueva solicitud con fechas actualizadas.");
    const messages = {
      400: "Revisá los datos de la solicitud e intentá nuevamente.",
      401: "Ingresá nuevamente para acceder a las solicitudes.",
      403: "Esta cuenta no tiene permiso para administrar las solicitudes.",
      404: "No se encontró la solicitud.",
      409: "La solicitud cambió o ese identificador ya se usó. Actualizá la bandeja antes de continuar.",
      413: "La solicitud supera el tamaño permitido.",
      429: "Se alcanzó el límite de solicitudes. Esperá e intentá nuevamente."
    };
    return failure(messages[status] ? status : 503, messages[status] || "No se pudo conectar con la bandeja. Tus datos locales siguen disponibles.");
  }
  async function request(path, body, authenticated = false, options = {}) {
    requireConfiguration();
    const ticket = generation, current = authenticated ? requireSession() : null;
    const headers = { apikey: key, "Content-Type": "application/json", Accept: "application/json" };
    if (current) headers.Authorization = `Bearer ${current.accessToken}`;
    else if (legacyKey) headers.Authorization = `Bearer ${key}`;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
    let response, value;
    try {
      response = await fetch(origin + path, { method: options.method || "POST", headers, ...(options.method === "GET" ? {} : { body: JSON.stringify(body) }),
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
        ...(controller ? { signal: controller.signal } : {}) });
      const raw = await response.text();
      if (raw.length > 12 * 1024 * 1024) throw failure(503, "La respuesta de la bandeja supera el tamaño permitido.");
      try { value = raw ? JSON.parse(raw) : null; } catch (_) { throw failure(503, "La bandeja devolvió una respuesta no válida."); }
    } catch (error) {
      if (authenticated && ticket !== generation) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
      if (error && Number.isInteger(error.status)) throw error;
      throw failure(503, "No se pudo conectar con la bandeja. Comprobá tu conexión e intentá nuevamente.");
    } finally { if (timer !== null) clearTimeout(timer); }
    if (authenticated && ticket !== generation) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
    if (!response.ok) {
      if (authenticated && (response.status === 401 || (response.status === 403 && !options.preserveForbidden))) clearSession();
      if (options.activation && response.status === 403) throw failure(403, "El token no pudo autorizar tu cuenta en este proyecto. Revisá el token personal de Supabase y volvé a intentar.");
      if (options.activation && response.status === 409) throw failure(409, "Este proyecto ya tiene otra cuenta de administración. Ingresá con el correo de esa cuenta.");
      throw safeError(response.status, value);
    }
    return value;
  }
  function validID(value) {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw failure(400, "El identificador de la solicitud no es válido.");
    return value.toLowerCase();
  }
  function requireOwner() {
    const current = requireSession();
    if (current.ownerAuthorized !== true) throw failure(403, "Primero activá tu cuenta para acceder a las solicitudes.");
    return current;
  }
  async function ownerCheck(ticket, allowActivation) {
    try {
      const rows = await request("/rest/v1/rpc/nicolas_list_requests", {}, true, { preserveForbidden: allowActivation });
      if (ticket !== generation || !session) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
      if (!Array.isArray(rows)) throw failure(503, "La bandeja devolvió una respuesta no válida.");
      session.ownerAuthorized = true;
      return { authenticated: true };
    } catch (error) {
      if (allowActivation && error?.status === 403 && ticket === generation && session) {
        session.ownerAuthorized = false;
        return { authenticated: false, requiresActivation: true };
      }
      throw error;
    }
  }
  async function listRequests() {
    requireOwner();
    const rows = await request("/rest/v1/rpc/nicolas_list_requests", {}, true);
    if (!Array.isArray(rows)) throw failure(503, "La bandeja devolvió una respuesta no válida.");
    return rows;
  }
  function validEmail(email) {
    if (typeof email !== "string" || !email.trim() || email.length > 254 || /[\r\n\s]/.test(email.trim()) || !/^[^@]+@[^@]+\.[^@]+$/.test(email.trim())) throw failure(400, "Ingresá un correo válido para recibir tu código.");
    return email.trim();
  }
  function installSession(result) {
    if (!result || typeof result.access_token !== "string" || result.access_token.length < 16 ||
        typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0 ||
        (result.token_type !== undefined && (typeof result.token_type !== "string" || result.token_type.toLowerCase() !== "bearer"))) throw failure(401, "No se pudo iniciar la sesión de la bandeja.");
    session = { accessToken: result.access_token, expiresAt: Date.now() + Math.min(result.expires_in, 86400) * 1000, ownerAuthorized: false };
  }
  async function requestEmailCode(email) {
    requireConfiguration(); const address = validEmail(email); clearSession(); const ticket = generation;
    await request("/auth/v1/otp?redirect_to=" + encodeURIComponent(ownerRedirect), { email: address, create_user: true });
    if (ticket !== generation) throw failure(401, "La sesión se cerró. Volvé a pedir tu código.");
    return { sent: true };
  }
  async function signInWithCode(email, code) {
    requireConfiguration(); const address = validEmail(email);
    if (typeof code !== "string" || code.length > 8192) throw failure(400, "Pegá el enlace del correo o ingresá el código que recibiste.");
    let verification;
    if (/^\d{6,10}$/.test(code.trim())) verification = { email: address, token: code.trim(), type: "email" };
    else {
      let link;
      try { link = new URL(code.trim()); } catch (_) { throw failure(400, "Pegá el enlace completo del correo o ingresá su código."); }
      const tokenHash = link.searchParams.get("token_hash") || link.searchParams.get("token");
      if (link.origin !== origin || link.protocol !== "https:" || link.username || link.password || link.port || link.pathname !== "/auth/v1/verify" || link.hash || typeof tokenHash !== "string" || tokenHash.length < 16 || tokenHash.length > 4096 || /[\r\n\s]/.test(tokenHash)) throw failure(400, "Usá el enlace de acceso de este proyecto que recibiste por correo.");
      verification = { token_hash: tokenHash, type: "email" };
    }
    clearSession(); const ticket = generation;
    try {
      const result = await request("/auth/v1/verify", verification);
      if (ticket !== generation) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
      installSession(result);
      return await ownerCheck(ticket, true);
    } catch (error) { if (ticket === generation) clearSession(); throw error; }
  }
  async function resumeEmailSignIn() {
    if (!incomingLink) return null;
    const pending = incomingLink; incomingLink = null; clearSession(); requireConfiguration(); const ticket = generation;
    if (pending.invalid || !pending.accessToken || Date.now() >= pending.expiresAt) throw failure(401, "El enlace de acceso venció o no es válido. Pedí uno nuevo con tu correo.");
    session = { accessToken: pending.accessToken, expiresAt: pending.expiresAt, ownerAuthorized: false };
    try {
      const user = await request("/auth/v1/user", null, true, { method: "GET" });
      if (ticket !== generation || !session) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
      if (!user || typeof user.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id) || typeof user.email !== "string" || !user.email.trim()) throw failure(401, "No se pudo verificar tu cuenta. Pedí un nuevo enlace de acceso.");
      const authorization = await ownerCheck(ticket, true);
      return { ...authorization, email: user.email };
    } catch (error) { if (ticket === generation) clearSession(); throw error; }
  }
  async function activateOwner(accessToken) {
    requireConfiguration(); requireSession(); const ticket = generation;
    if (typeof accessToken !== "string" || !/^sbp_[A-Za-z0-9_-]{20,508}$/.test(accessToken.trim())) throw failure(400, "Pegá el token personal de acceso de tu cuenta de Supabase.");
    const result = await request("/functions/v1/nicolas-owner-access", { access_token: accessToken.trim() }, true, { preserveForbidden: true, activation: true });
    if (ticket !== generation || !session) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
    if (result?.activated !== true) throw failure(503, "No se pudo confirmar la activación. Volvé a intentar.");
    const authorization = await ownerCheck(ticket, true);
    if (!authorization.authenticated) throw failure(403, "La cuenta todavía no tiene acceso a la bandeja. Revisá el token de tu proyecto y volvé a intentar.");
    return { authenticated: true };
  }
  async function signIn(email, password) {
    requireConfiguration(); clearSession();
    const ticket = generation;
    if (typeof email !== "string" || !email.trim() || email.length > 320 || typeof password !== "string" || !password || password.length > 1024) throw failure(400, "Ingresá el correo y la contraseña de la bandeja.");
    try {
      const result = await request("/auth/v1/token?grant_type=password", { email: email.trim(), password });
      if (ticket !== generation) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
      installSession(result);
      await ownerCheck(ticket, false); // The database authorizes the owner, never the first local email.
      if (ticket !== generation) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
      return { authenticated: true };
    } catch (error) {
      if (ticket === generation) clearSession();
      throw error;
    }
  }
  async function signOut(options) { clearSession({ preserveIncomingLink: options?.preserveIncomingLink === true }); return { authenticated: false }; }
  async function submit(payload) {
    const expectedID = validID(payload?.request_id);
    const receipt = await request("/rest/v1/rpc/nicolas_submit_request", { p_payload: payload });
    try {
      if (validID(receipt?.request_id) !== expectedID || receipt.status !== "pending") throw new Error("invalid receipt");
    } catch (_) { throw failure(503, "No se pudo confirmar que la solicitud quedó guardada. Reintentá con el mismo identificador."); }
    return { request_id: expectedID, status: "pending" };
  }
  async function approveRequest(id) {
    requireOwner();
    return request("/rest/v1/rpc/nicolas_approve_request", { p_request_id: validID(id) }, true);
  }
  async function rejectRequest(id) {
    requireOwner();
    return request("/rest/v1/rpc/nicolas_reject_request", { p_request_id: validID(id) }, true);
  }
  window.addEventListener("nicolas:locked", () => clearSession());
  window.NicolasCloud = Object.freeze({ configured, config, submit, signIn, requestEmailCode, signInWithCode, resumeEmailSignIn, activateOwner, signOut, listRequests, approveRequest, rejectRequest });
})();
