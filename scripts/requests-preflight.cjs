"use strict";
const { execFileSync } = require("node:child_process");
const { connection } = require("./requests-build.cjs");

function environmentConfiguration(environment = process.env) {
  const url = (environment.SUPABASE_URL || "").trim();
  const key = (environment.SUPABASE_PUBLISHABLE_KEY || "").trim();
  const problems = [];
  if (!url) problems.push("SUPABASE_URL: falta la URL real de tu proyecto.");
  else {
    try { connection({ enabled: false, supabase_url: url, publishable_key: "" }); }
    catch (error) { problems.push(`SUPABASE_URL: ${error.message}`); }
  }
  if (!key) problems.push("SUPABASE_PUBLISHABLE_KEY: falta la clave pública del proyecto.");
  else {
    try { connection({ enabled: false, supabase_url: "", publishable_key: key }); }
    catch (error) { problems.push(`SUPABASE_PUBLISHABLE_KEY: ${error.message}`); }
  }
  if (problems.length) throw new Error(problems.join("\n") + "\nCorregí estos campos en la configuración del entorno. Los valores no se muestran ni se envían al chat.");
  return connection({ enabled: true, supabase_url: url, publishable_key: key }).config;
}

function probeWithCurl(config) {
  // Use stdin rather than process arguments for headers. curl honors the environment's
  // HTTPS proxy and verifies TLS. No redirects, customer records or owner tokens.
  const lines = [
    `url = ${JSON.stringify(config.supabase_url + "/rest/v1/rpc/nicolas_submit_request")}`,
    `header = ${JSON.stringify("apikey: " + config.publishable_key)}`,
    'header = "Content-Type: application/json"',
    'header = "Accept: application/json"',
    `data = ${JSON.stringify(JSON.stringify({ p_payload: {} }))}`,
  ];
  if (!config.publishable_key.startsWith("sb_publishable_")) lines.push(`header = ${JSON.stringify("Authorization: Bearer " + config.publishable_key)}`);
  let raw;
  try {
    raw = execFileSync("curl", ["--disable", "--silent", "--show-error", "--proto", "=https", "--connect-timeout", "8", "--max-time", "20", "--max-filesize", "65536", "--request", "POST", "--write-out", "\n%{http_code}", "--config", "-"], {
      input: lines.join("\n") + "\n", encoding: "utf8", timeout: 25000,
      maxBuffer: 128 * 1024, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (_) { throw new Error("No se pudo comprobar el proyecto por HTTPS. Revisá la URL, la conexión y el acceso al dominio del proyecto en el entorno."); }
  const index = raw.lastIndexOf("\n");
  let body = null;
  try { body = JSON.parse(raw.slice(0, index)); } catch (_) {}
  return { status: Number(raw.slice(index + 1)), body };
}

async function verifyBackend(value, probe = probeWithCurl) {
  const { config } = connection(value);
  if (!config.enabled) throw new Error("La comprobación requiere una configuración de solicitudes activa.");
  let response;
  try { response = await probe(config); }
  catch (_) { throw new Error("No se pudo comprobar el proyecto por HTTPS. Revisá la URL, la conexión y el acceso al dominio del proyecto en el entorno."); }
  if (response?.status === 400 && response.body?.code === "PT400" && response.body?.message === "Invalid request fields.") {
    return { reachable: true, submission_rpc: true, owner_verified: false };
  }
  if ([401, 403].includes(response?.status)) throw new Error("El proyecto rechazó la clave pública. Copiá la clave publishable o anon del mismo proyecto que la URL.");
  if (response?.status === 404 || response?.body?.code === "PGRST202") throw new Error("Falta instalar o exponer la función de solicitudes. Ejecutá la migración SQL indicada en integration/README.md antes de activar la conexión.");
  throw new Error("El proyecto no confirmó la función de recepción esperada. La conexión se conserva sin cambios; revisá la migración SQL del proyecto.");
}

module.exports = { environmentConfiguration, verifyBackend };
