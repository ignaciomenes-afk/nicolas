# Acceso del propietario en esta instalación

El backend y `nicolas-owner-access` están desplegados en el proyecto configurado. La página del cliente guarda solicitudes antes de abrir WhatsApp. La primera cuenta de administración se autoriza **desde Nicolás**:

1. Abrí `https://ignaciomenes-afk.github.io/nicolas/privado/` o el archivo actualizado y desbloqueá tu cartera local.
2. En **Solicitudes**, usá el correo de tu cuenta de Supabase y solicitá un enlace de acceso. Podés abrir el botón del correo para volver a la web o copiar su dirección y pegarla en el archivo descargado. También se admite un código si la plantilla de tu proyecto lo muestra.
3. La primera vez, pegá tu token personal en **Activar mi cuenta**. La función verifica el correo y exige que el token pueda ejecutar escritura administrativa en **ese proyecto**. Una cuenta registrada sin ese permiso no puede obtener acceso. El token se borra del campo y no se conserva.

Una vez autorizada tu cuenta, los siguientes accesos solo necesitan el enlace o tu contraseña, si ya configuraste una. Podés revocar el token de instalación después de autorizar tu cuenta. La contraseña de la cartera cifrada permanece independiente y nunca se envía al servidor.

El proveedor de correo predeterminado del plan gratuito no permite personalizar plantillas y puede limitar los destinatarios a miembros del proyecto. Esta instalación conserva las plantillas originales y utiliza sus enlaces; no cambia de plan ni configura un SMTP de terceros. Usá el correo con el que administrás Supabase.

La versión web y el archivo tienen almacenamiento local separado: importá una copia cifrada para mover una cartera existente. El enlace de descarga anterior permanece disponible.

## Referencia técnica de despliegue

`nicolas-owner-access` resuelve la primera autorización del dueño cuando el token administrativo está limitado al proyecto y no revela una identidad de usuario de plataforma. La función debe comprobar el JWT del usuario con Supabase Auth y usar el PAT que ese usuario aporta temporalmente para autorizar su UUID mediante Management API. Nunca asigna el rol al primer usuario registrado.

El PAT se usa únicamente durante esa operación. No debe incorporarse al código, configuración pública, almacenamiento del navegador, secretos globales de la función ni logs.

## Despliegue de un único archivo TypeScript

Management API admite subir `supabase/functions/nicolas-owner-access/index.ts` directamente mediante multipart. No hace falta comprimirlo ni generar un ESZIP. El siguiente comando es una plantilla: `PROJECT_REF` identifica el proyecto y `SUPABASE_ACCESS_TOKEN` debe estar disponible únicamente en la sesión administrativa segura, sin escribir su valor en archivos.

```bash
curl --fail-with-body --request POST \
  'https://api.supabase.com/v1/projects/PROJECT_REF/functions/deploy?slug=nicolas-owner-access' \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --form 'metadata={"name":"nicolas-owner-access","entrypoint_path":"index.ts","verify_jwt":false};type=application/json' \
  --form 'file=@supabase/functions/nicolas-owner-access/index.ts;filename=index.ts;type=application/typescript'
```

`file` es un campo multipart repetible para los archivos del despliegue; el nombre `index.ts` coincide con `metadata.entrypoint_path`. Para este archivo sin imports se omite `import_map_path`. Si se agregan imports o archivos después, hay que subir sus dependencias y mantener sus rutas relativas. No fijes el header global `Content-Type`: el cliente HTTP debe generar el boundary multipart.

La respuesta esperada del despliegue es HTTP 201. Consultá después `GET /v1/projects/PROJECT_REF/functions/nicolas-owner-access` y comprobá `status: ACTIVE` y `verify_jwt: false`. La función se invoca en el gateway del proyecto, bajo `/functions/v1/nicolas-owner-access`.

Desactivar la comprobación JWT del gateway no permite acceso anónimo al handler: este debe rechazar toda petición privada cuyo bearer no valide con `GET /auth/v1/user`. CORS solo permite los orígenes previstos de la página y del HTML local; no sustituye esa comprobación.

## Variables del runtime

Supabase inyecta `SUPABASE_URL` y la clave pública heredada `SUPABASE_ANON_KEY`. Los runtimes actuales también pueden ofrecer `SUPABASE_PUBLISHABLE_KEYS`, un diccionario JSON de claves públicas; se puede usar su entrada `default` cuando no esté disponible la clave heredada. Ninguna de estas claves identifica al dueño: se necesita además su JWT Auth.

Este flujo no necesita copiar una clave `service_role` ni una clave secreta global al navegador. El permiso administrativo para la primera autorización proviene del PAT aportado expresamente por el operador y validado contra el proyecto exacto.

## Mostrar el código de acceso por correo

La personalización siguiente es opcional y requiere que el plan o SMTP del proyecto lo permita. El proyecto actual conserva los correos originales y usa enlaces; no se modificaron esas plantillas ni se contrató otro servicio.

La primera solicitud de código puede usar la plantilla de confirmación; los accesos posteriores pueden usar la de enlace mágico. Consultá primero `GET /v1/projects/PROJECT_REF/config/auth` y conservá ambas plantillas y sus asuntos actuales. Actualizá mediante PATCH únicamente los cuerpos que todavía no incluyan `{{ .Token }}`:

- `mailer_templates_confirmation_content`;
- `mailer_templates_magic_link_content`.

Insertá un bloque como `<p>Tu código para Nicolás: <strong>{{ .Token }}</strong></p>` sin quitar el contenido existente ni `{{ .ConfirmationURL }}`. Conservá `mailer_subjects_confirmation` y `mailer_subjects_magic_link`. Si el contenido está vacío porque se usa el default, partí de la plantilla oficial correspondiente, conservá su enlace y agregá el bloque del código.

El usuario solicita el correo desde la interfaz. El despliegue y la actualización de plantillas no deben enviar correos de prueba automáticamente. La verificación de código usa `POST /auth/v1/verify` con `{email, token, type: "email"}`; ese tipo admite tanto confirmación inicial como acceso posterior. La longitud configurada del código puede ser de 6 a 10 dígitos.

## Fuentes oficiales

- [Management API: esquema de despliegue, metadata y configuración Auth](https://github.com/supabase/supabase/blob/master/apps/docs/spec/api_v1_openapi.json).
- [Variables inyectadas en Edge Functions](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/functions/secrets.mdx).
- [Plantillas predeterminadas y variables Token/ConfirmationURL](https://github.com/supabase/auth/blob/master/internal/mailer/templatemailer/templatemailer.go).
- [Verificación Auth de los códigos](https://github.com/supabase/auth/blob/master/internal/api/verify.go).
