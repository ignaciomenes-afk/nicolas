#!/usr/bin/env node
"use strict";
// Developer setup only. The generated pages need just a browser.
const fs = require("node:fs");
const path = require("node:path");
const { environmentConfiguration, verifyBackend } = require("./requests-preflight.cjs");
const { connection } = require("./requests-build.cjs");

async function configureRequests({ filename = path.resolve(__dirname, "../integration/requests-config.json"), environment = process.env, disable = false, checkOnly = false, fromConfig = false, verify = verifyBackend } = {}) {
  if (disable && checkOnly) throw new Error("Elegí --disable o --check; no se usan juntos.");
  if (disable && fromConfig) throw new Error("Elegí --disable o --from-config; no se usan juntos.");
  let source = environment;
  if (fromConfig) {
    const saved = connection(JSON.parse(fs.readFileSync(filename, "utf8"))).config;
    source = { SUPABASE_URL: saved.supabase_url, SUPABASE_PUBLISHABLE_KEY: saved.publishable_key };
  }
  const config = disable ? { enabled: false, supabase_url: "", publishable_key: "" } : environmentConfiguration(source);
  if (!disable) await verify(config);
  if (!checkOnly) {
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
      fs.renameSync(temporary, filename);
    } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
  }
  return { disabled: disable, checked: !disable, changed: !checkOnly, owner_verified: false };
}

if (require.main === module) {
  const unknown = process.argv.slice(2).some(arg => !["--disable", "--check", "--from-config"].includes(arg));
  if (unknown) { console.error("Uso: node scripts/configure-requests.cjs [--check] [--from-config] | --disable"); process.exitCode = 1; }
  else configureRequests({ disable: process.argv.includes("--disable"), checkOnly: process.argv.includes("--check"), fromConfig: process.argv.includes("--from-config") }).then(result => {
    console.log(result.disabled ? "Conexión de solicitudes desactivada." : result.changed
      ? "Recepción comprobada y configuración pública guardada. Falta verificar el acceso del propietario en Nicolás y generar/publicar ambas páginas."
      : "Recepción comprobada sin crear solicitudes ni cambiar la configuración. El acceso del propietario se verifica al iniciar sesión en Nicolás.");
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { configureRequests };
