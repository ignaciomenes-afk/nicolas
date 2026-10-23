#!/usr/bin/env node
"use strict";
// Developer setup only. The generated pages need just a browser.
const fs = require("node:fs");
const path = require("node:path");
const { connection } = require("./requests-build.cjs");
const filename = path.resolve(__dirname, "../integration/requests-config.json");
const previous = fs.readFileSync(filename, "utf8");
const disable = process.argv.includes("--disable");
if (!disable && (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY)) {
  console.error("Faltan SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY. Cargá únicamente la URL y la clave pública del proyecto en la configuración del entorno.");
  process.exit(1);
}
try {
  fs.writeFileSync(filename, JSON.stringify(disable ? { enabled: false, supabase_url: "", publishable_key: "" } : {
    enabled: true, supabase_url: process.env.SUPABASE_URL, publishable_key: process.env.SUPABASE_PUBLISHABLE_KEY,
  }, null, 2) + "\n");
  connection();
  console.log(disable ? "Conexión de solicitudes desactivada." : "Conexión pública configurada. Verificá la migración y el propietario antes de generar y publicar las páginas.");
} catch (error) {
  fs.writeFileSync(filename, previous);
  console.error(error.message);
  process.exitCode = 1;
}
