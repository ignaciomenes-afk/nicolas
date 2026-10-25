/* Initial owner activation. Auth JWT + Management database-write PAT are both required.
 * No SDK, imports, persistent credentials, response token echoes, or logging.
 */
type Runtime = { env?: { get(name: string): string | undefined }; serve?: (handler: (request: Request) => Promise<Response>) => unknown };
type Options = { fetch?: typeof globalThis.fetch; env?: (name: string) => string | undefined; timeoutMs?: number };
const runtime = (globalThis as typeof globalThis & { Deno?: Runtime }).Deno;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGIN = "https://ignaciomenes-afk.github.io";
const LIMIT = 8192;
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function error(status: number, message: string): never { throw new HttpError(status, message); }
function isPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(value)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const part = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))).role === "anon";
  } catch (_) { return false; }
}
function configuration(env: (name: string) => string | undefined) {
  let url: URL;
  try { url = new URL(env("SUPABASE_URL") || ""); } catch (_) { return error(503, "El acceso inicial todavía no está configurado."); }
  const match = /^([a-z]{20})\.supabase\.co$/.exec(url.hostname);
  if (url.protocol !== "https:" || !match || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") error(503, "El acceso inicial todavía no está configurado.");
  let key = env("SUPABASE_ANON_KEY") || "";
  if (!key) {
    try { key = JSON.parse(env("SUPABASE_PUBLISHABLE_KEYS") || "{}").default || ""; } catch (_) { key = ""; }
  }
  if (!isPublicKey(key)) error(503, "El acceso inicial todavía no está configurado.");
  return { origin: url.origin, ref: match![1], key };
}
async function limitedText(source: Request | Response, maximum: number, signal: AbortSignal, tooLargeStatus: number): Promise<string> {
  const declared = source.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await source.body?.cancel().catch(() => {});
    error(tooLargeStatus, tooLargeStatus === 413 ? "La petición supera el tamaño permitido." : "El servicio devolvió una respuesta no válida.");
  }
  if (!source.body) return "";
  const reader = source.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) error(503, "La operación tardó demasiado. Volvé a intentar.");
      const result = await reader.read();
      if (signal.aborted) error(503, "La operación tardó demasiado. Volvé a intentar.");
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) { await reader.cancel().catch(() => {}); error(tooLargeStatus, tooLargeStatus === 413 ? "La petición supera el tamaño permitido." : "El servicio devolvió una respuesta no válida."); }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (_) { return error(tooLargeStatus === 413 ? 400 : 503, "El contenido recibido no es válido."); }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const raw = await limitedText(response, 131072, signal, 503);
  try { return raw ? JSON.parse(raw) : null; } catch (_) { return error(503, "El servicio devolvió una respuesta no válida."); }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function createHandler(options: Options = {}) {
  const fetcher = options.fetch || globalThis.fetch;
  const env = options.env || ((name: string) => runtime?.env?.get(name));
  return async function handler(request: Request): Promise<Response> {
    const suppliedOrigin = request.headers.get("Origin");
    const allowed = suppliedOrigin === null || suppliedOrigin === ORIGIN || suppliedOrigin === "null";
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin", "X-Content-Type-Options": "nosniff" });
    if (allowed && suppliedOrigin !== null) headers.set("Access-Control-Allow-Origin", suppliedOrigin);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    if (!allowed) return json(403, { error: "Este origen no está permitido." });
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
      headers.set("Access-Control-Max-Age", "600");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") { headers.set("Allow", "POST, OPTIONS"); return json(405, { error: "Usá POST para activar el acceso." }); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
    const cancel = () => controller.abort(); request.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (request.signal.aborted) error(503, "La operación se interrumpió. Volvé a intentar.");
      if ((request.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") error(415, "La petición debe contener JSON.");
      const auth = request.headers.get("Authorization") || "";
      if (auth.length > 16384 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(auth)) error(401, "Confirmá tu correo e ingresá nuevamente.");
      let body: unknown;
      try { body = JSON.parse(await limitedText(request, LIMIT, controller.signal, 413)); }
      catch (cause) { if (cause instanceof HttpError) throw cause; error(400, "El cuerpo debe contener JSON válido."); }
      if (!object(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "access_token") || typeof body.access_token !== "string") error(400, "Ingresá el token de administración para activar el acceso.");
      const pat = (body as { access_token: string }).access_token.trim();
      if (!/^sbp_[A-Za-z0-9_-]{8,4096}$/.test(pat)) error(400, "El token de administración debe comenzar con sbp_.");
      const config = configuration(env);
      const userResponse = await fetcher(config.origin + "/auth/v1/user", { method: "GET", headers: { apikey: config.key, Authorization: auth }, credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
      const user = await responseJson(userResponse, controller.signal);
      if (!userResponse.ok) error(userResponse.status === 400 || userResponse.status === 401 || userResponse.status === 403 ? 401 : 503, "No se pudo verificar la sesión. Confirmá tu correo e ingresá nuevamente.");
      if (!object(user) || typeof user.id !== "string" || !UUID.test(user.id) || typeof user.email !== "string" || !user.email || typeof user.email_confirmed_at !== "string" || !Number.isFinite(Date.parse(user.email_confirmed_at))) error(403, "Verificá tu correo antes de activar el acceso.");
      const uid = (user.id as string).toLowerCase();
      const claimResponse = await fetcher(`https://api.supabase.com/v1/projects/${config.ref}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query: "select nicolas_private.claim_first_owner($1::uuid) as user_id", parameters: [uid], read_only: false }), credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
      const claim = await responseJson(claimResponse, controller.signal);
      if (!claimResponse.ok) {
        const detail = object(claim) ? String(claim.code || "") + " " + String(claim.message || "") : "";
        if (claimResponse.status === 409 || /PT409/.test(detail)) error(409, "El acceso inicial ya fue activado por otra cuenta.");
        if (claimResponse.status === 401 || claimResponse.status === 403 || /PT403|42501|permission denied|insufficient privilege/i.test(detail)) error(403, "El token no permite administrar la base de este proyecto.");
        error(503, "No se pudo activar el acceso. Revisá el token y volvé a intentar.");
      }
      if (!Array.isArray(claim) || claim.length !== 1 || !object(claim[0]) || claim[0].user_id !== uid) error(503, "No se pudo confirmar la activación. Volvé a intentar con la misma cuenta.");
      return json(200, { activated: true, user_id: uid });
    } catch (cause) {
      if (cause instanceof HttpError) return json(cause.status, { error: cause.message });
      return json(503, { error: "No se pudo activar el acceso. Comprobá la conexión y volvé a intentar." });
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", cancel); }
  };
}
export const handler = createHandler();
if (import.meta.main && runtime?.serve) runtime.serve(handler);
