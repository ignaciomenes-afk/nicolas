# Guía y video de primer acceso

Publicación: https://ignaciomenes-afk.github.io/nicolas/guia/ . El MP4 incluye voz sintetizada local en español latinoamericano y la página ofrece subtítulos y capítulos.

El video muestra las interfaces reales con respuestas simuladas y datos de ejemplo en perfiles temporales. No se envían correos, solicitudes ni WhatsApp al proveedor. No se utiliza el token del propietario, ni sus contraseñas o registros. Los textos y los tiempos exactos quedan en conexion-guion.json.

Requiere Node/Playwright, Chrome oficial autorizado, ffmpeg/ffprobe y espeak-ng solo para producir el video; el usuario únicamente necesita un navegador. El generador es scripts/build-connection-tutorial.cjs. NICOLAS_ESPEAK_ROOT puede apuntar a una extracción local de paquetes oficiales Debian con usr/bin/espeak-ng y usr/lib/x86_64-linux-gnu. En esta ejecución se usaron espeak-ng, espeak-ng-data, libespeak-ng1, libpcaudio0 y libsonic0 de Debian bookworm, descargados por HTTPS oficial y comprobados contra SHA256 de Packages.xz, extraídos en /tmp/nicolas-tts sin modificar el sistema. CHROMIUM_PATH permite indicar el Chrome de pruebas; no se alteran las políticas del Chromium administrado.

El generador captura pantallas, las compone con instrucciones y produce MP4 H.264/AAC, portada y WebVTT. Los enlaces de ambas aplicaciones se conservan; esta guía es una ruta adicional para ayuda.
