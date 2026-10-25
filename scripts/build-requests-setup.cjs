#!/usr/bin/env node
"use strict";
// The owner needs only a browser. This build includes public connection details,
// an installation script and instructions; no password or administrator key.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { connection } = require("./requests-build.cjs");
const root = path.resolve(__dirname, "..");
const read = filename => fs.readFileSync(path.join(root, filename), "utf8");
const { config } = connection();
if (!config.supabase_url || !config.publishable_key) throw new Error("Configurá primero la URL y la clave pública reales del proyecto.");
const setup = { supabase_url: config.supabase_url, publishable_key: config.publishable_key,
  application_enabled: config.enabled,
  migration_sql: read("supabase/migrations/202610230001_private_requests.sql") };
const source = `window.NicolasSetupConfig = Object.freeze(${JSON.stringify(setup).replace(/</g, "\\u003c")});\n${read("integration/setup/app.js")}`;
new vm.Script(source, { filename: "requests-setup.inline.js" });
let html = read("integration/setup/index.html");
let styles = 0, scripts = 0;
html = html.replace(/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["'](?:\.\/)?styles\.css["'])[^>]*>/gi, () => {
  styles++; return `<style>\n${read("integration/setup/styles.css").replace(/<\/style/gi, "<\\/style")}\n</style>`;
});
html = html.replace(/<script\b(?=[^>]*\bsrc=["'](?:\.\/)?app\.js["'])[^>]*>\s*<\/script>/gi, () => { scripts++; return ""; });
if (styles !== 1 || scripts !== 1) throw new Error("Faltan las referencias de estilos o del asistente.");
html = html.replace(/<meta\b(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])[^>]*>/gi, "");
const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src ${config.supabase_url}; base-uri 'none'; form-action 'none'`;
html = html.replace(/<\/head\s*>/i, `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="no-referrer">\n</head>`);
html = html.replace(/<\/body\s*>/i, () => `<script>\n${source.replace(/<\/script/gi, "<\\/script")}\n</script>\n</body>`);
if (/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\brel=["']stylesheet["']/i.test(html)) throw new Error("El asistente todavía depende de recursos externos.");
const embedded = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
if (embedded.length !== 1) throw new Error("El asistente debe tener un solo script incorporado.");
new vm.Script(embedded[0][1]);
html = html.replace(/^[\t ]+$/gm, "");
for (const filename of ["entrega/ACTIVAR-SOLICITUDES.html", "docs/activar/index.html"]) {
  fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true }); fs.writeFileSync(path.join(root, filename), html);
}
console.log("Asistente preparado: entrega/ACTIVAR-SOLICITUDES.html y docs/activar/index.html (sin contraseñas ni claves privadas).");
