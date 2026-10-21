#!/usr/bin/env node
"use strict";

// Generates the downloadable customer page and its identical /docs publication copy.
// Node built-ins only; no package installation, network, or external ZIP utility.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "client-request");
const deliveryRoot = path.join(root, "entrega");
const htmlName = "SOLICITAR-PRESTAMO.html";
const guideName = "LEEME-SOLICITUD.txt";
const zipName = "Nicolas-solicitud-prestamo.zip";
const readSource = name => fs.readFileSync(path.join(sourceRoot, name), "utf8");
const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

function inlineScript(name, source) {
  new vm.Script(source, { filename: name });
  return `<script data-loan-source="${name}">\n${source.replace(/<\/script/gi, "<\\/script")}\n</script>`;
}

function buildHtml() {
  let html = readSource("index.html");
  const css = readSource("styles.css");
  const scripts = ["loan-core.js", "app.js"].map(name => inlineScript(name, readSource(name)));
  let stylesheetCount = 0;
  html = html.replace(/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["'](?:\.\/)?styles\.css["'])[^>]*>/gi, () => {
    stylesheetCount += 1;
    return `<style data-loan-styles>\n${css.replace(/<\/style/gi, "<\\/style")}\n</style>`;
  });
  if (stylesheetCount !== 1) throw new Error("La fuente debe incluir una hoja de estilos styles.css.");
  for (const name of ["loan-core.js", "app.js"]) {
    const escaped = name.replace(/\./g, "\\.");
    const pattern = new RegExp(`<script\\b(?=[^>]*\\bsrc=["'](?:\\./)?${escaped}["'])[^>]*>\\s*<\\/script>`, "gi");
    let count = 0;
    html = html.replace(pattern, () => { count += 1; return ""; });
    if (count !== 1) throw new Error(`La fuente debe incluir una sola referencia a ${name}.`);
  }
  html = html.replace(/<meta\b(?=[^>]*\bhttp-equiv=["']Content-Security-Policy["'])[^>]*>\s*/gi, "");
  if (!/<\/head\s*>/i.test(html) || !/<\/body\s*>/i.test(html)) throw new Error("La página fuente no contiene head y body completos.");
  html = html.replace(/<\/head\s*>/i, () => `  <meta http-equiv="Content-Security-Policy" content="${csp}">\n</head>`);
  html = html.replace(/<\/body\s*>/i, () => `${scripts.join("\n")}\n</body>`);
  if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /<link\b[^>]*\brel=["']stylesheet["']/i.test(html)) throw new Error("La página todavía depende de scripts o estilos externos.");
  const embedded = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  if (embedded.length !== 2) throw new Error("La página debe incorporar exactamente los dos scripts de la solicitud.");
  for (const [index, match] of embedded.entries()) new vm.Script(match[1], { filename: `${htmlName}.inline-${index + 1}.js` });
  if (!html.includes("https://wa.me/5493544617342")) throw new Error("La página no incluye el contacto de Nicolás acordado.");
  return html.replace(/^[\t ]+$/gm, "");
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let index = 0; index < 8; index++) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const locals = [], directory = [];
  let offset = 0;
  // Stable timestamps make rebuilding identical source files reproducible.
  const dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const { name, data } of files) {
    const filename = Buffer.from(name, "utf8"), contents = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const checksum = crc32(contents), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(filename.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, filename, contents);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(contents.length, 20); central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + contents.length;
  }
  const centralDirectory = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

const html = buildHtml();
const guide = fs.readFileSync(path.join(deliveryRoot, guideName), "utf8");
const zip = createZip([{ name: htmlName, data: html }, { name: guideName, data: guide }]);
fs.mkdirSync(deliveryRoot, { recursive: true });
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(deliveryRoot, htmlName), html, "utf8");
fs.writeFileSync(path.join(root, "docs", "index.html"), html, "utf8");
fs.writeFileSync(path.join(deliveryRoot, zipName), zip);
console.log(`Solicitud lista: entrega/${htmlName} (${Buffer.byteLength(html)} bytes)`);
console.log("Copia idéntica para publicación: docs/index.html");
console.log(`Descarga: entrega/${zipName} (${zip.length} bytes, HTML y guía)`);
