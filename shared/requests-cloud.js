/* Shared Supabase transport. Public configuration only; owner sessions live in RAM. */
(function () {
  "use strict";
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
  function clearSession() { generation += 1; session = null; }
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
  async function request(path, body, authenticated = false) {
    requireConfiguration();
    const ticket = generation, current = authenticated ? requireSession() : null;
    const headers = { apikey: key, "Content-Type": "application/json", Accept: "application/json" };
    if (current) headers.Authorization = `Bearer ${current.accessToken}`;
    else if (legacyKey) headers.Authorization = `Bearer ${key}`;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
    let response, value;
    try {
      response = await fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body),
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
      if (authenticated && (response.status === 401 || response.status === 403)) clearSession();
      throw safeError(response.status, value);
    }
    return value;
  }
  function validID(value) {
    if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw failure(400, "El identificador de la solicitud no es válido.");
    return value.toLowerCase();
  }
  async function listRequests() {
    const rows = await request("/rest/v1/rpc/nicolas_list_requests", {}, true);
    if (!Array.isArray(rows)) throw failure(503, "La bandeja devolvió una respuesta no válida.");
    return rows;
  }
  async function signIn(email, password) {
    requireConfiguration(); clearSession();
    const ticket = generation;
    if (typeof email !== "string" || !email.trim() || email.length > 320 || typeof password !== "string" || !password || password.length > 1024) throw failure(400, "Ingresá el correo y la contraseña de la bandeja.");
    try {
      const result = await request("/auth/v1/token?grant_type=password", { email: email.trim(), password });
      if (ticket !== generation) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
      if (!result || typeof result.access_token !== "string" || result.access_token.length < 16 ||
          typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0 ||
          (result.token_type !== undefined && (typeof result.token_type !== "string" || result.token_type.toLowerCase() !== "bearer"))) throw failure(401, "No se pudo iniciar la sesión de la bandeja.");
      session = { accessToken: result.access_token, expiresAt: Date.now() + Math.min(result.expires_in, 86400) * 1000 };
      await listRequests(); // The database, rather than a client-side email check, authorizes the owner.
      if (ticket !== generation) throw failure(401, "La sesión se cerró. Ingresá nuevamente.");
      return { authenticated: true };
    } catch (error) {
      if (ticket === generation) clearSession();
      throw error;
    }
  }
  async function signOut() { clearSession(); return { authenticated: false }; }
  async function submit(payload) {
    const expectedID = validID(payload?.request_id);
    const receipt = await request("/rest/v1/rpc/nicolas_submit_request", { p_payload: payload });
    try {
      if (validID(receipt?.request_id) !== expectedID || receipt.status !== "pending") throw new Error("invalid receipt");
    } catch (_) { throw failure(503, "No se pudo confirmar que la solicitud quedó guardada. Reintentá con el mismo identificador."); }
    return { request_id: expectedID, status: "pending" };
  }
  async function approveRequest(id) {
    return request("/rest/v1/rpc/nicolas_approve_request", { p_request_id: validID(id) }, true);
  }
  async function rejectRequest(id) {
    return request("/rest/v1/rpc/nicolas_reject_request", { p_request_id: validID(id) }, true);
  }
  window.addEventListener("nicolas:locked", clearSession);
  window.NicolasCloud = Object.freeze({ configured, config, submit, signIn, signOut, listRequests, approveRequest, rejectRequest });
})();
