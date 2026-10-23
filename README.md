# Nicolás · Sistema de préstamos y cobros

[**Descargar la página privada actualizada (.zip)**](https://github.com/ignaciomenes-afk/nicolas/raw/refs/heads/codex/web-privada-descargable/entrega/Nicolas-prestamos.zip)

## Abrir y empezar

1. Descargá y extraé todos los archivos del ZIP.
2. Abrí **ABRIR-NICOLAS.html** en Chrome o Edge de computadora y creá tu contraseña.
3. En **Mis datos**, completá tus datos de prestamista y los días de anticipación de los avisos.
4. Agregá los datos del cliente: nombre, DNI/CUIT, teléfono, correo y domicilio.
5. En **Nuevo préstamo**, ingresá el capital entregado, tasa mensual, plazo en meses, fecha de emisión y plan de devolución. Revisá el cronograma antes de guardar.
6. Abrí el detalle para imprimir el pagaré, registrar la firma, adjuntar el documento firmado y registrar los cobros.

No necesita Python, instalaciones, servidor ni conexión a Internet para funcionar después de descargarlo.

## Qué registra

- **Clientes:** datos de contacto y documento; cada préstamo conserva una copia de los datos de la fecha de emisión.
- **Préstamos:** capital entregado, interés mensual, plazo, fecha de emisión, primer vencimiento y cuotas programadas.
- **Pagarés:** plantilla para completar, imprimir y firmar; fecha de firma y foto o PDF firmado de hasta 5 MB, guardado cifrado.
- **Cobros:** abonos completos o parciales, fecha, medio de pago, notas y recibo imprimible. El saldo se actualiza automáticamente.
- **Vencimientos:** cuotas vencidas, las que vencen hoy y próximas a vencer, con importe pendiente y contacto del cliente.
- **Movimientos:** entregas de capital, entradas de dinero y flujo neto de caja; separación de capital e interés en los cobros.
- **Resumen:** capital pendiente, saldo contractual, cobros e intereses cobrados del mes.
- **Exportaciones:** clientes, préstamos, cobros y movimientos en CSV, y vencimientos en calendario .ics.

Es un registro interno de préstamos y cobros. El saldo de caja refleja únicamente los movimientos de préstamos cargados en esta aplicación.

## Intereses y planes

La tasa se ingresa como **porcentaje mensual**, con hasta dos decimales. Antes de guardar se muestra el capital, interés total, importe total a cobrar y cada fecha de cobro.

Podés elegir:

- **Interés simple sobre capital inicial:** cada período mensual calcula interés sobre el capital entregado originalmente.
- **Interés sobre saldo programado, con capital fijo:** cada cuota amortiza una parte del capital; el interés mensual se calcula sobre el capital programado pendiente al comenzar ese período. Las cuotas disminuyen. No es el sistema francés.

Planes de devolución:

- Cuotas mensuales de capital e interés.
- Interés cada mes y todo el capital en el último vencimiento.
- Un único pago al vencimiento final, con el capital y el interés mensual acumulado sin capitalización.

Ejemplo: $100.000 al 10% mensual durante 3 meses, con interés simple sobre capital inicial, genera $30.000 de interés y $130.000 de total programado.

Los importes se calculan en centavos, con redondeo al centavo. El cronograma es fijo: no hay capitalización, cargos de mora, prorrateo diario ni descuentos por anticipos automáticos. Un adelanto se aplica al cronograma pactado; no reduce sus intereses de forma automática.

## Fechas y avisos

Si dejás **Primer cobro** vacío, el vencimiento se calcula cada mes en el día de la emisión o el último día de ese mes. Ejemplo: emisión 31 de enero → 28 de febrero → 31 de marzo. Una fecha de primer cobro personalizada fija ese nuevo día para los períodos siguientes. En el plan de un solo pago, se usa el último vencimiento del plazo.

Los avisos visibles se actualizan al abrir la página y mientras permanece abierta. Los préstamos saldados o anulados dejan de generar avisos de cobro.

**Calendario:** el archivo .ics exportado incluye los pendientes a las 09:00 de Argentina y un aviso con la anticipación configurada en Mis datos. Importalo en un calendario que admita alertas. Los cambios posteriores y los pagos registrados no se sincronizan con ese calendario: actualizá o eliminá sus eventos manualmente. La página cerrada no envía notificaciones por sí sola.

## Pagaré y firma

La plantilla incluye cliente, prestamista, capital, tasa mensual, plazo, emisión, vencimiento final, total pactado, cronograma y espacios de firma. Completá los campos que falten antes de firmar.

El préstamo se crea con el pagaré **pendiente de firma**. Después de firmarlo físicamente, marcá **Tengo el pagaré firmado**, indicá la fecha y, si querés, adjuntá una foto JPEG/PNG o un PDF. Registrar la marca en el sistema no firma el documento ni reemplaza la firma. Los adjuntos se incluyen en las copias de seguridad cifradas.

## Cobros y correcciones

Los cobros se imputan por orden de registro a la cuota pendiente más antigua, primero a su interés y luego a su capital. Se aceptan pagos parciales; se rechazan importes superiores al saldo y cobros con fecha futura.

**Anular error de cobro** conserva el registro como anulado y vuelve a calcular la imputación de los cobros posteriores. **Anular error de carga** de un préstamo solo está disponible cuando no tiene cobros activos. Son correcciones de registros: estas acciones no documentan una devolución real de efectivo.

## Datos privados y copias

Los datos se guardan automáticamente cifrados en ese navegador, equipo y perfil. No se envían a GitHub ni se escriben dentro del HTML del programa. No hay sincronización automática entre equipos ni recuperación de contraseña.

Guardá una **Copia de seguridad** al finalizar la jornada o tras cambios importantes. Conservá el archivo y su contraseña. Borrar los datos del navegador o usar otro perfil puede dejarte sin acceso a los registros locales; el respaldo permite restaurarlos.

Para actualizar desde la versión anterior, descargá primero una copia desde ella. Podés reemplazar el HTML manteniendo la misma ubicación, nombre y navegador. Si la página nueva no encuentra tus registros locales, usá **Importar mi copia de seguridad** y su contraseña. La actualización mantiene los clientes y conserva los registros históricos anteriores en el respaldo, aunque la nueva interfaz se centra en préstamos.

Restaurar en una sesión existente reemplaza sus datos: la página exige revisar la copia, respaldar el contenido actual y confirmar. Los CSV son consultas sin cifrar y no reemplazan el respaldo completo.

## Desarrollo

Solo quienes desarrollan necesitan Node y, para pruebas, Playwright y un Chrome autorizado. El usuario final únicamente necesita el navegador.

```bash
node scripts/build-standalone.cjs
CHROMIUM_PATH=/ruta/a/chrome node tests/loans_smoke.cjs entrega/ABRIR-NICOLAS.html
```

El generador incorpora todos los recursos y valida la sintaxis de los scripts del HTML resultante. La suite abre archivos reales, en perfiles temporales, comprueba cálculos, cobros, avisos, pagarés, cifrado y migración de copias anteriores. También acepta un ZIP y prueba el HTML extraído.

Los archivos descargables están en `entrega/`. La rama publicada es `codex/web-privada-descargable`; el enlace anterior `Nicolas-web-privada.zip` se conserva con la misma versión actualizada. Cada tarea de Codex ya está aislada: usá el checkout existente, sin crear un worktree salvo petición explícita.

## Página para clientes: Préstamos

**Préstamos** está disponible en **[https://ignaciomenes-afk.github.io/nicolas/](https://ignaciomenes-afk.github.io/nicolas/)** para simular y solicitar un préstamo por WhatsApp. Ese es el enlace para compartir con los clientes y se conserva al actualizar la página. El botón **Compartir esta página** permite distribuirlo; si el navegador no ofrece un menú para compartir, copia el enlace o permite copiarlo manualmente.

La copia local [PRESTAMOS.html](entrega/PRESTAMOS.html) es un único archivo para conservar y abrir sin instalaciones. El archivo no tiene fecha de vencimiento; la disponibilidad de un enlace web depende del alojamiento que lo publique. [Prestamos.zip](entrega/Prestamos.zip) reúne ese HTML y la guía de uso. Los nombres anteriores `SOLICITAR-PRESTAMO.html` y `Nicolas-solicitud-prestamo.zip` se mantienen como copias actualizadas para conservar los enlaces existentes.

El cliente elige primero el **monto y los meses** y ve sus cuotas al instante. Puede usar los importes rápidos de **$100.000, $200.000 o $500.000**, o escribir otro importe; esos botones solo actualizan la simulación. Después completa sus datos personales y toca **Continuar en WhatsApp** para preparar la solicitud.

La simulación calcula **35% de interés base para plazos de 1 a 3 meses** y **40% de interés base para plazos de 4 a 24 meses**. El porcentaje se aplica una sola vez sobre el capital, sin multiplicarlo por la cantidad de meses. El capital más ese interés forma el total base. Para obtener cuotas iguales, cada cuota se redondea **hacia arriba al múltiplo de $1.000**. Todas las cuotas, incluida la última, tienen el mismo importe. El **monto final a devolver** es la cuota redondeada multiplicada por los meses; el **ajuste adicional por redondeo** se muestra por separado del interés base en el formulario.

Por ejemplo, $1.000.000 en 6 meses generan $400.000 de interés base y $1.400.000 de total base. Las 6 cuotas iguales son de $234.000: el monto final a devolver es $1.404.000, con $4.000 de ajuste por redondeo. $500.000 en 5 meses generan 5 cuotas de $140.000 y $700.000 de monto final, sin ajuste. Los costos, condiciones y cuotas se muestran antes de solicitar. Estas condiciones corresponden a la página de solicitud; la aplicación de administración conserva sus planes y tasas mensuales.

**Continuar en WhatsApp** prepara un mensaje breve con **los datos del cliente, el importe solicitado, el monto final a devolver, el resumen de todas las cuotas iguales y el primer vencimiento estimado**, dirigido al contacto **5493544617342**. El monto a devolver aparece inmediatamente después del monto solicitado. El cliente ve el texto, lo revisa y debe **enviarlo manualmente en WhatsApp** como último paso. Si WhatsApp no se abre, puede usar el enlace de reintento o **Copiar solicitud** y pegar el mismo mensaje en la conversación con ese contacto. La consulta directa también está disponible desde el encabezado y el pie de página.

La simulación, la solicitud y las fechas propuestas quedan pendientes de aprobación; completar el formulario no otorga el préstamo ni confirma sus vencimientos. Se puede descargar un calendario de las fechas propuestas e importarlo en una aplicación de calendario. Los avisos dependen de esa aplicación, su configuración y sus permisos; descargar el archivo no activa alarmas por sí solo.

Los datos personales del formulario no se guardan por la página ni se envían a un backend propio. Se utilizan para preparar la solicitud que el cliente decide enviar por WhatsApp.

### Desarrollo y validación de la solicitud

Los fuentes están en `client-request/`. Para generar el HTML, sus alias, ambos ZIP y la copia idéntica `docs/index.html`:

```bash
node scripts/build-client-request.cjs
CHROMIUM_PATH=/ruta/a/chrome node tests/client_request_smoke.cjs entrega/Prestamos.zip
```

El ZIP contiene únicamente `PRESTAMOS.html` y `LEEME-SOLICITUD.txt`. El generador usa herramientas incluidas en Node, incorpora estilos y scripts, valida su sintaxis y prepara el archivo vacío `docs/.nojekyll` para servir el sitio estático.

### Actualizar la página conservando el mismo enlace

El sitio ya está publicado con GitHub Pages mediante el workflow oficial `.github/workflows/publish-prestamos.yml`, desde la rama **main**. El workflow publica únicamente la página cliente de `docs/`. El enlace público continúa siendo **https://ignaciomenes-afk.github.io/nicolas/**.

1. Actualizá los fuentes de `client-request/` y ejecutá el generador anterior.
2. Subí `docs/index.html` y `docs/.nojekyll` a **main**, preservando `.github/workflows/publish-prestamos.yml`.
3. En **Actions**, esperá a que termine correctamente el workflow de publicación y su despliegue en GitHub Pages.
4. Abrí **https://ignaciomenes-afk.github.io/nicolas/** y verificá los cambios y el botón de WhatsApp.
5. Seguí compartiendo ese mismo enlace mediante **Compartir esta página** o desde el navegador.

La configuración actual de **Settings → Pages → Build and deployment → Source** utiliza **GitHub Actions**. Solo es necesario revisar esa opción si se cambia o se restaura la configuración del repositorio.
