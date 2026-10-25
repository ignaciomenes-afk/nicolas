# Bandeja privada de solicitudes

La página pública envía solicitudes al proyecto Supabase configurado y Nicolás las consulta con una cuenta autorizada. La migración y la función de acceso inicial están instaladas en el proyecto del prestamista. El acceso requiere verificar el correo y autorizar la primera cuenta mediante un token administrativo con permiso de escritura; no se elige automáticamente al primer usuario registrado.

Los registros existentes de Nicolás siguen en su bóveda cifrada local. La bandeja remota guarda datos personales de las solicitudes en una base privada: activar esta integración agrega almacenamiento en la nube y requiere conexión para enviar, consultar y decidir solicitudes. No sincroniza las copias completas de la bóveda entre equipos.

## Instalación guiada desde el navegador

El asistente del propietario está en **[Activar solicitudes](https://ignaciomenes-afk.github.io/nicolas/activar/)**. No se enlaza desde el formulario del cliente y no permite leer solicitudes ni ejecutar SQL por sí mismo. Incorpora únicamente la URL y la clave pública del proyecto y el código de instalación.

Con la conexión ya activada, ese asistente conduce directamente a [Nicolás](https://ignaciomenes-afk.github.io/nicolas/privado/). Los pasos SQL siguientes son para preparar otro proyecto; no hay que repetirlos para entrar al proyecto ya conectado. El acceso actual se explica en [OWNER-ACCESS.md](OWNER-ACCESS.md).

1. Abrí **Usuarios de Supabase** desde el asistente y creá tu cuenta de administración con tu correo y una contraseña propia. La contraseña se escribe únicamente en Supabase.
2. Volvé al asistente, indicá el correo de esa cuenta y copiá la instalación preparada. Abrí el **SQL Editor**, pegá el código y pulsá **Run**. El script instala las funciones y autoriza únicamente al usuario existente con ese correo, dentro de una transacción. Si la cuenta no existe o hay coincidencias ambiguas, se detiene sin instalar parcialmente.
3. Usá **Comprobar instalación**. La comprobación no crea pedidos y solo verifica que la recepción está instalada. La publicación de las páginas conectadas y el acceso del propietario se verifican por separado; no presenta la instalación como un circuito ya activado.

El correo se mantiene en memoria y en el SQL que decidís copiar; no se envía durante la comprobación, no se guarda en el navegador y no se añade a enlaces. El asistente no pide la contraseña, una clave de administrador ni datos de clientes.

Para generar la copia web `docs/activar/index.html` y el archivo autónomo `entrega/ACTIVAR-SOLICITUDES.html`, usá `node scripts/build-requests-setup.cjs` después de guardar la URL y la clave pública correctas en `integration/requests-config.json`. El asistente permite comprobar la instalación aunque la aplicación mantenga `enabled: false` hasta completar la verificación.

## Preparar el proyecto

1. Entrá a tu cuenta en [Supabase](https://supabase.com/dashboard), creá un proyecto o abrí el que ya tenés y esperá a que esté disponible. Conservá el acceso de administración. Revisá el plan, la región y las condiciones de tratamiento de datos antes de usar información real.
2. Abrí [el archivo de instalación SQL](../supabase/migrations/202610230001_private_requests.sql), copiá todo su contenido y pegalo en una consulta nueva del **SQL Editor** de ese proyecto. Ejecutalo completo con **Run**. Este paso instala la bandeja; copiar la URL y la clave pública no lo reemplaza. La migración usa los componentes estándar de Supabase y no requiere una extensión adicional.
3. En **Authentication → Users**, creá la cuenta de correo y contraseña que usará el prestamista. No reutilices la contraseña de la bóveda local. Copiá su UUID de usuario; no su contraseña ni una sesión.
4. Autorizá ese UUID mediante SQL administrativo:

   ```sql
   insert into nicolas_private.owner_users(user_id)
   values ('REEMPLAZAR-POR-UUID-DEL-USUARIO'::uuid)
   on conflict do nothing;
   ```

5. Desactivá el registro público de usuarios si no lo necesitás. Crear otra cuenta no otorga acceso a la bandeja: cada operación privada comprueba el UUID contra `owner_users` en el servidor.
6. En la configuración de la Data API, mantené **`nicolas_private` fuera de los esquemas expuestos**. Las cuatro funciones RPC están en `public`; las tablas privadas tienen RLS habilitado y no conceden acceso directo a `anon` ni `authenticated`.
7. En la configuración de API del **mismo proyecto**, copiá la **Project URL** HTTPS y su **publishable key** (`sb_publishable_…`), o la antigua clave JWT con rol `anon`. Cargá esos dos valores públicos en las variables del entorno `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY`. Una variable presente pero incompleta no conecta la bandeja. Nunca uses una clave `sb_secret_…`, `service_role`, contraseña de base de datos o token de administración en el HTML, JSON, repositorio o GitHub Pages.

También se puede aplicar la migración con la CLI oficial Supabase, ya autenticada en la cuenta correcta:

```bash
supabase link --project-ref REFERENCIA_DEL_PROYECTO
supabase db push
```

La CLI puede necesitar `SUPABASE_ACCESS_TOKEN` y `SUPABASE_DB_PASSWORD` para las operaciones administrativas. Solo se suministran mediante el gestor de secretos o la sesión segura de la CLI; no son variables del navegador ni se escriben en este repositorio. No hacen falta estas credenciales para abrir los HTML ya configurados.

## Activar y generar los HTML

Con `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` cargadas, comprobá primero la conexión sin activar ni modificar archivos:

```bash
node scripts/configure-requests.cjs --check
```

La comprobación valida el formato de ambos valores y consulta la función remota con un formulario vacío (`{"p_payload":{}}`). La respuesta esperada es **HTTP 400, código `PT400`, `Invalid request fields.`**: confirma que la función instalada rechaza datos incompletos antes de escribir. No crea una solicitud, no consulta datos personales ni modifica el proyecto. `--check` tampoco cambia `integration/requests-config.json`.

Si la comprobación pasa, activá la configuración pública:

```bash
node scripts/configure-requests.cjs
```

El comando sin opciones hace **la misma comprobación remota antes de guardar**. Solo si pasa escribe `integration/requests-config.json` con `enabled: true`. Ante un error conserva la configuración anterior; no crea el proyecto, instala SQL ni autoriza usuarios. No actives el JSON manualmente para saltar una comprobación fallida.

Si la URL y la clave pública correctas ya están guardadas en `integration/requests-config.json`, podés usarlas explícitamente sin depender de variables antiguas: `node scripts/configure-requests.cjs --from-config --check` comprueba y `node scripts/configure-requests.cjs --from-config` activa después de comprobar. Ambos conservan las validaciones y rechazan claves privadas.

Después generá ambos HTML:

```bash
node scripts/build-client-request.cjs
node scripts/build-standalone.cjs
```

| Resultado de la comprobación | Qué hacer |
| --- | --- |
| Faltan variables, URL inválida o clave no reconocida | Volvé a copiar la URL completa y la clave pública del proyecto. No uses textos de ejemplo ni valores abreviados. |
| HTTP 401/403 o clave rechazada | Verificá que URL y clave pertenezcan al mismo proyecto y que la clave siga vigente. Una clave de otro proyecto no sirve. |
| HTTP 404 o `PGRST202` | Comprobá que ejecutaste la migración completa en ese proyecto y que la Data API expone `public`. |
| Fallo de red, espera agotada o proyecto no disponible | Revisá que el proyecto esté activo y que la red permita su origen HTTPS; repetí después de corregirlo. |
| Respuesta distinta del rechazo `400 / PT400` esperado | Revisá la instalación y su versión; el ayudante conserva la configuración anterior. |

Una comprobación anónima correcta **no confirma que el dueño esté autorizado**. Para verificarlo, abrí la nueva versión de Nicolás, desbloqueá la bóveda e iniciá sesión en **Solicitudes** con el usuario creado en Supabase. Si no tiene permiso, revisá el UUID registrado en `nicolas_private.owner_users`; la clave pública no permite agregarlo. La contraseña de esa cuenta se ingresa en Nicolás, no se incorpora al HTML.

Cada generador incorpora esa configuración antes de `shared/requests-cloud.js`. La política CSP debe permitir conexiones **solo al origen HTTPS exacto del proyecto**. No hace falta un SDK externo ni abrir destinos con comodines. Para desactivar la integración, ejecutá `node scripts/configure-requests.cjs --disable` y volvé a generar ambos HTML.

Publicá la nueva página cliente en GitHub Pages y distribuí la nueva versión de Nicolás al prestamista. La URL pública y la clave pública identifican el backend; los datos de las solicitudes no se guardan en GitHub. El servidor Supabase debe admitir solicitudes CORS tanto desde la página pública como desde el HTML local (`Origin: null`); CORS no reemplaza la autenticación del prestamista.

## Contratos y decisiones

El transporte expone `window.NicolasCloud`: `configured`, `config`, `submit(payload)`, `signIn(email, password)`, `signOut()`, `listRequests()`, `approveRequest(id)` y `rejectRequest(id)`. Los errores tienen `status` numérico y mensajes seguros; no muestran respuestas internas de PostgreSQL ni datos del servidor. La sesión JWT solo vive en RAM, se limpia al bloquear Nicolás o cerrar sesión y no usa `localStorage`, `sessionStorage` ni IndexedDB. Al vencer se vuelve a pedir acceso. Cerrar sesión elimina el token de esta pestaña; no revoca por sí solo un JWT ya emitido por el servidor.

RPC disponibles:

| Función | Parámetros JSON | Acceso y resultado |
| --- | --- | --- |
| `nicolas_submit_request` | `{ "p_payload": solicitud }` | Anónimo: recibo `{request_id,status:"pending"}`; nunca devuelve datos personales ni la decisión. |
| `nicolas_list_requests` | `{}` | Dueño autorizado: lista con `id`, `status`, `created_at`, `customer`, `quote`, `approved_payload`. |
| `nicolas_approve_request` | `{ "p_request_id": "UUID" }` | Dueño: aprobación persistida y presupuesto canónico para importar. |
| `nicolas_reject_request` | `{ "p_request_id": "UUID" }` | Dueño: `{id,status:"rejected"}`. No permite rechazar una solicitud aprobada. |

La solicitud lleva exactamente estas claves:

```text
request_id: UUID estable durante reintentos
customer: { full_name, cuil, address_street, address_number, locality, client_whatsapp }
quote: { policy_version: "nicolas-total-v1", principal_cents, term_months,
         first_due_date: "AAAA-MM-DD", due_anchor_day }
contact_consent: true
```

`client_whatsapp` contiene los dígitos internacionales; se admite un `+` inicial y se normaliza. El CUIL admite espacios/guiones y se valida por prefijo y dígito verificador; esto no acredita la identidad del solicitante.

El servidor rechaza campos adicionales y recalcula el presupuesto: 35% total de 1 a 3 meses, 40% desde 4 a 24, interés redondeado a centavos y cada cuota igual redondeada hacia arriba a un múltiplo de $1.000. El capital máximo es 100.000.000.000 centavos ($1.000.000.000). Los vencimientos mensuales conservan el día ancla o el último día del mes. No acepta totales calculados por un navegador como autoridad.

El presupuesto persistido contiene `policy_version`, capital, plazo, primera fecha, día ancla, porcentaje, interés, total base, ajuste por redondeo, total final y todas las cuotas `{number,due_date,amount_cents}`. Una aprobación devuelve `{request_id,approved_at,issued_date,customer,quote}`. `issued_date` se fija al aprobar con la fecha de Argentina. La primera cuota debe ser posterior a esa fecha; una solicitud vencida exige fechas renovadas, sin modificar silenciosamente el cronograma que vio el cliente.

El UUID es único. Un reintento con el mismo contenido normalizado devuelve el mismo recibo; con contenido distinto devuelve conflicto. Aprobar dos veces devuelve el mismo resultado original, incluso si luego transcurre la fecha de primera cuota. Las decisiones usan bloqueo de fila y no pueden aprobar y rechazar una misma solicitud simultáneamente.

La aprobación remota y la escritura cifrada local son operaciones separadas. Nicolás debe importar el resultado canónico por `request_id`, de manera atómica e idempotente dentro de su bóveda. Si falla la escritura local, la aprobación queda recuperable en `approved_payload`; reintentar la importación no debe duplicar clientes, préstamos ni cuotas. No se debe mostrar «incorporada» hasta confirmar el guardado local.

## Límites y operación

La recepción admite hasta 16 KiB por solicitud, 3 nuevas solicitudes por CUIL y hora, 120 nuevas solicitudes globales por hora y **1.000 registros en la bandeja**. Los reintentos idénticos no consumen otro cupo. Estos límites se aplican dentro de PostgreSQL bajo bloqueo transaccional; no dependen del navegador. El límite global puede temporalmente impedir solicitudes legítimas durante abuso: para exposición amplia, agregá protección antiabuso en el gateway sin conceder lectura anónima. No registres cuerpos con datos personales en logs públicos.

El listado se descarga completo; el límite de 1.000 registros y las longitudes máximas mantienen incluso las respuestas con presupuestos de 24 cuotas por debajo del tope de 12 MiB del transporte. Antes de alcanzar el cupo, el administrador debe exportar o archivar los registros antiguos de forma privada y aplicar la retención en la base; no hay una función de archivado en la interfaz. Una bandeja llena rechaza nuevas solicitudes, sin borrar datos automáticamente ni perder los reintentos ya guardados.

Los datos permanecen hasta que el administrador de la base defina y ejecute su política de conservación. Conservá las aprobaciones aún no importadas y las copias necesarias; no borres eventos de aprobación esperando que el sistema los pueda volver a descargar. Revisá las copias de seguridad y la recuperación ofrecidas por el proyecto.

Para revocar acceso a la bandeja, un administrador elimina el UUID de `nicolas_private.owner_users`. La comprobación se repite en cada RPC privada, incluso si el usuario mantiene un JWT vigente.

## Validación antes de usar datos reales

```bash
node --test supabase/tests/transport.test.cjs
```

La suite del transporte usa respuestas simuladas y comprueba sesiones en memoria y los contratos REST. No acredita un despliegue Supabase. En el proyecto real, verificá además:

1. Un visitante puede enviar una solicitud sintética válida y recibe solo el UUID/recibo; no puede listar la bandeja ni consultar tablas privadas.
2. Un usuario autenticado que no figure en `owner_users` no puede listar, aprobar ni rechazar.
3. El dueño puede revisar, aprobar e importar una solicitud; el cronograma y el total coinciden exactamente con la simulación.
4. Repetir envío, aprobación e importación no crea registros duplicados. Reutilizar el UUID con otro contenido devuelve conflicto.
5. Rechazar no crea un préstamo; no se puede rechazar una aprobada. Fechas vencidas impiden una aprobación nueva.
6. Una pérdida de conexión tras aprobar deja el resultado recuperable para volver a importar; bloquear la bóveda invalida las respuestas de sesión tardías.

No publiques una afirmación de bandeja conectada hasta comprobar el circuito completo contra el proyecto real.
