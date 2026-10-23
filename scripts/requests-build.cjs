"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

// Only the project's public browser key belongs here. Owner credentials stay in Auth.
function connection(value = JSON.parse(fs.readFileSync(path.join(root, "integration", "requests-config.json"), "utf8"))) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuración de solicitudes incompleta.");
  if (typeof value.enabled !== "boolean" || typeof value.supabase_url !== "string" || typeof value.publishable_key !== "string") throw new Error("Configuración de solicitudes incompleta.");
  if (Object.keys(value).some(key => !["enabled", "supabase_url", "publishable_key"].includes(key))) throw new Error("La configuración solo admite URL y clave pública del proyecto.");
  let origin = "";
  if (value.supabase_url) {
    let url;
    try { url = new URL(value.supabase_url); }
    catch (_) { throw new Error("Usá la URL HTTPS real del proyecto Supabase, copiada desde su configuración."); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)) throw new Error("Usá la URL HTTPS oficial del proyecto Supabase.");
    origin = url.origin;
  }
  const key = value.publishable_key;
  if (key.startsWith("sb_secret_")) throw new Error("Una clave privada no puede incorporarse al navegador.");
  if (key && !/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) {
    let claims;
    try {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) throw new Error("format");
      claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
    } catch (_) { throw new Error("La clave pública del proyecto no tiene un formato válido."); }
    if (claims.role !== "anon") throw new Error("Solo se admite una clave pública anon o publishable; nunca service_role.");
  }
  if (value.enabled && (!origin || !key)) throw new Error("Faltan URL o clave pública para activar las solicitudes.");
  return { config: { enabled: value.enabled, supabase_url: origin, publishable_key: key }, connectSource: value.enabled ? origin : "'none'" };
}
function browserSource() {
  const { config } = connection();
  return `window.NicolasCloudConfig = Object.freeze(${JSON.stringify(config).replace(/</g, "\\u003c")});\n${fs.readFileSync(path.join(root, "shared", "requests-cloud.js"), "utf8")}`;
}
module.exports = { connection, browserSource };
