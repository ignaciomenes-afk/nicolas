#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const requests = require("./requests-build.cjs");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, "static", name), "utf8");
const output = path.resolve(process.argv[2] || path.join(root, "entrega", "ABRIR-NICOLAS.html"));
const style = (name, attribute) => `<style ${attribute}>\n${read(name).replace(/<\/style/gi, "<\\/style")}\n</style>`;
const script = (name) => `<script>\n${read(name).replace(/<\/script/gi, "<\\/script")}\n</script>`;

let html = read("index.html")
  .replace(/<link\s+rel="stylesheet"\s+href="\/?styles\.css"\s*\/?\s*>/, () => `${style("styles.css", "data-nicolas-main")}\n${style("private.css", "data-nicolas-private")}\n${style("requests.css", "data-nicolas-requests")}`)
  .replace(/\s*<script\s+src="\/?app\.js"\s+defer><\/script>/, "")
  .replace(/<body(?:\s[^>]*)?>/, '<body class="vault-locked">')
  .replace(/<title>[^<]*<\/title>/, '<title>Nicolás · Préstamos privados</title>')
  .replace('</head>', `  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src ${requests.connection().connectSource}; frame-src 'self' blob: data:; base-uri 'none'; form-action 'none'">\n</head>`)
  .replace('</body>', () => `${script("local-store.js")}\n<script>\n${requests.browserSource().replace(/<\/script/gi, "<\\/script")}\n</script>\n${script("app.js")}\n${script("requests-ui.js")}\n${script("private-ui.js")}\n</body>`);
if (/<(?:script|link)[^>]+(?:src|href)="\//.test(html)) throw new Error("El archivo aún requiere recursos externos.");
if (!html.includes("data-nicolas-main")) throw new Error("No se incorporaron los estilos de la aplicación.");
const embedded = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (embedded.length !== 5) throw new Error("Faltan componentes de la aplicación.");
for (const [index, match] of embedded.entries()) new vm.Script(match[1], { filename: `Nicolas.inline-${index + 1}.js` });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html, "utf8");
console.log(`Página sin instalación: ${output} (${Buffer.byteLength(html)} bytes)`);
