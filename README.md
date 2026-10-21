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

## Página para clientes: solicitar préstamo

La página de solicitud se entrega por separado de la aplicación de administración:

- [SOLICITAR-PRESTAMO.html](entrega/SOLICITAR-PRESTAMO.html): un único archivo HTML para abrir en el navegador, sin instalaciones.
- [Nicolas-solicitud-prestamo.zip](entrega/Nicolas-solicitud-prestamo.zip): paquete con la página de solicitud.

El cliente ingresa sus datos, el capital solicitado, la cantidad de cuotas y una fecha propuesta para el primer pago. La simulación aplica **35% de interés total, una sola vez sobre el capital**, sin multiplicarlo por la cantidad de meses. Por ejemplo, $200.000 generan $70.000 de interés y $270.000 de total: en 2 cuotas, son $135.000 por cuota. Esta condición corresponde a la página de solicitud; la aplicación de administración conserva sus planes y tasas mensuales.

El botón de WhatsApp prepara el mensaje dirigido al prestamista **5493544617342**. El cliente debe revisar el texto y **enviarlo manualmente en WhatsApp**. La simulación, la solicitud y las fechas propuestas quedan pendientes de aprobación; completar el formulario no otorga el préstamo ni confirma sus vencimientos.

La página permite descargar un calendario de las fechas propuestas. Hay que importarlo en una aplicación de calendario; los avisos dependen de esa aplicación, su configuración y sus permisos. Descargar el archivo no activa alarmas por sí solo.

Los datos personales del formulario no se guardan por la página ni se envían a un backend propio. Se utilizan para preparar la solicitud que el cliente decide enviar por WhatsApp.

### Desarrollo y validación de la solicitud

Los fuentes están en `client-request/`. Para generar el HTML, el ZIP y la copia idéntica `docs/index.html`:

```bash
node scripts/build-client-request.cjs
CHROMIUM_PATH=/ruta/a/chrome node tests/client_request_smoke.cjs entrega/Nicolas-solicitud-prestamo.zip
```

### Publicar la página de solicitud con GitHub Pages

`docs/index.html` queda preparado para publicar únicamente la página cliente desde `/docs`. Su presencia en el repositorio no confirma que el sitio ya esté publicado. Después de subir los archivos a la rama `codex/web-privada-descargable`:

1. Abrí el repositorio en GitHub y entrá en **Settings → Pages**.
2. En **Build and deployment**, elegí **Source: Deploy from a branch**.
3. Seleccioná la rama **codex/web-privada-descargable** y la carpeta **/docs**.
4. Pulsá **Save** y esperá a que GitHub indique que el despliegue terminó.
5. Usá la dirección que muestre GitHub Pages para compartir la solicitud con los clientes.
