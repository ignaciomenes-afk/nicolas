# Nicolás · Web privada de ventas

## Descargar y abrir

[**Descargar el sistema listo para usar (.zip)**](https://github.com/ignaciomenes-afk/nicolas/raw/refs/heads/codex/web-privada-descargable/entrega/Nicolas-web-privada.zip)

1. Descargá el ZIP y **extraé todos los archivos**.
2. Dentro de la carpeta extraída, abrí **ABRIR-NICOLAS.html** con Chrome o Edge de computadora.
3. Creá tu contraseña de al menos ocho caracteres y confirmala.
4. Cargá productos, clientes y ventas.

No requiere Python, instalaciones, servidor ni Internet después de descargarlo. Si abriste el ZIP en el navegador, primero guardalo y extraelo; la aplicación es el archivo HTML que contiene.

## Datos privados

Los registros se guardan automáticamente **cifrados en ese navegador y equipo**, protegidos con tu contraseña. No se envían a GitHub ni a otros servicios. El repositorio público contiene solo el programa, sin información de uso.

Abrí siempre el mismo HTML desde la misma ubicación y con el mismo navegador y perfil. No uses una ventana de incógnito para guardar información habitual. El programa no sincroniza datos entre equipos.

Usá **Copia de seguridad** para descargar un respaldo cifrado (.json). Conservá esa copia y tu contraseña: borrar los datos del navegador puede eliminar los registros locales, y no existe recuperación de contraseña. Para pasar a otro equipo, copiá el HTML y el respaldo e importalo con su contraseña.

**Restaurar** permite revisar cuántos registros contiene una copia antes de reemplazar el contenido. Si ya hay datos, debés desbloquear primero el espacio y descargar un respaldo actual antes de confirmar el reemplazo.

## Funciones

- Clientes y productos con búsqueda, edición y archivo.
- Stock inicial, ajustes con motivo, alertas e historial de movimientos.
- Ventas en pesos argentinos, efectivo/tarjeta/transferencia e IVA de 0%, 10,5% o 21%.
- Comprobantes internos numerados, impresión/PDF y exportación CSV.
- Anulación de ventas con devolución de stock una sola vez.
- Resumen mensual y de los últimos siete días.
- Contraseña, bloqueo, almacenamiento cifrado y copias de seguridad.

Los comprobantes son internos; no se integra facturación fiscal ARCA. La página es una aplicación local; no es un servicio alojado con sincronización entre usuarios.

## Desarrollo

La descarga funciona directamente; estas herramientas solo son para desarrollo.

```bash
node scripts/build-standalone.cjs
```

Genera `entrega/ABRIR-NICOLAS.html`, incorporando todos los recursos. La compilación comprueba la sintaxis de los scripts generados y no usa paquetes externos.

Las pruebas abren el archivo real, también desde un ZIP extraído, en perfiles temporales. Requieren Playwright y un Chrome de pruebas en la máquina de desarrollo:

```bash
CHROMIUM_PATH=/ruta/a/chrome node tests/offline_smoke.cjs entrega/Nicolas-web-privada.zip
```

Los archivos de `entrega/` forman parte del repositorio para evitar depender de rutas temporales del entorno de trabajo. Cada tarea en la nube ya está aislada; usá el checkout existente y no crees un worktree salvo petición explícita.
