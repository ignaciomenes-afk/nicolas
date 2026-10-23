# Bandeja privada de solicitudes

La página pública puede enviar solicitudes a un proyecto Supabase y Nicolás puede consultarlas con una cuenta autorizada. El proyecto y la cuenta deben pertenecer al prestamista. Esta entrega incluye el código y la migración; **no crea una cuenta, no despliega un backend y deja la conexión desactivada** hasta configurar y comprobar un proyecto real.

Los registros existentes de Nicolás siguen en su bóveda cifrada local. La bandeja remota guarda datos personales de las solicitudes en una base privada: activar esta integración agrega almacenamiento en la nube y requiere conexión para enviar, consultar y decidir solicitudes. No sincroniza las copias completas de la bóveda entre equipos.

## Preparar el proyecto

1. Creá o elegí un proyecto Supabase y conservá el control de su administración. Revisá el plan, la región y las condiciones de tratamiento de datos antes de usar información real.
2. En el editor SQL del proyecto, ejecutá `supabase/migrations/202610230001_private_requests.sql` completo como administrador. Usa `auth.users`, `auth.uid()`, los roles estándar `anon`/`authenticated` y PostgreSQL; no requiere una extensión adicional.
3. En **Authentication → Users**, creá la cuenta de correo y contraseña que usará el prestamista. No reutilices la contraseña de la bóveda local. Copiá su UUID de usuario; no su contraseña ni una sesión.
4. Autorizá ese UUID mediante SQL administrativo:

   ```sql
   insert into nicolas_private.owner_users(user_id)
   values ('REEMPLAZAR-POR-UUID-DEL-USUARIO'::uuid)
   on conflict do nothing;
   ```

5. Desactivá el registro público de usuarios si no lo necesitás. Crear otra cuenta no otorga acceso a la bandeja: cada operación privada comprueba el UUID contra `owner_users` en el servidor.
6. En la configuración de la Data API, mantené **`nicolas_private` fuera de los esquemas expuestos**. Las cuatro funciones RPC están en `public`; las tablas privadas tienen RLS habilitado y no conceden acceso directo a `anon` ni `authenticated`.
7. Tomá la URL HTTPS del proyecto y su **publishable key** (`sb_publishable_…`), o la antigua clave JWT con rol `anon`. Son configuración pública. Nunca uses una clave `sb_secret_…`, `service_role`, contraseña de base de datos o token de administración en el HTML, JSON, repositorio o GitHub Pages.

También se puede aplicar la migración con la CLI oficial Supabase, ya autenticada en la cuenta correcta:

```bash
supabase link --project-ref REFERENCIA_DEL_PROYECTO
supabase db push
```

La CLI puede necesitar `SUPABASE_ACCESS_TOKEN` y `SUPABASE_DB_PASSWORD` para las operaciones administrativas. Solo se suministran mediante el gestor de secretos o la sesión segura de la CLI; no son variables del navegador ni se escriben en este repositorio. No hacen falta estas credenciales para abrir los HTML ya configurados.

## Activar y generar los HTML

Editá únicamente los valores públicos de `integration/requests-config.json`:

```json
{
  "enabled": true,
  "supabase_url": "https://REFERENCIA_DEL_PROYECTO.supabase.co",
  "publishable_key": "REEMPLAZAR_POR_LA_PUBLISHABLE_KEY_PUBLICA"
}
```

Después ejecutá los generadores del proyecto:

```bash
node scripts/build-client-request.cjs
node scripts/build-standalone.cjs
```

Como alternativa a editar el JSON, cargá las variables públicas `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` en el entorno y ejecutá:

```bash
node scripts/configure-requests.cjs
```

Ese ayudante valida y guarda la configuración pública; no crea ni configura el proyecto Supabase. Después hay que volver a generar ambos HTML. Estas variables son opcionales si se usa el JSON; no incluyas en ellas una contraseña, token administrativo o clave privada.

Cada generador incorpora esa configuración antes de `shared/requests-cloud.js`. La política CSP debe permitir conexiones **solo al origen HTTPS exacto del proyecto**. No hace falta un SDK externo ni abrir destinos con comodines. Para desactivar la integración, usá `enabled: false` y volvé a generar ambos HTML.

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
