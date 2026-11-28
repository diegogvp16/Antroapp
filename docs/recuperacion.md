# Recuperación ante desastres

Escrito el 27/11/2026, en la rama `post-junta-4`. Qué respaldos hay hoy, qué
se perdería en cada escenario y cómo levantar AntroApp en un **proyecto de
Supabase nuevo** si el de producción se pierde.

Este documento no repite lo que ya está en otros:
- **`docs/respaldos.md`**: revisar qué respaldos tiene Supabase y probar una restauración sin tocar producción.
- **`docs/operacion.md`**, «Restaurar un respaldo»: restaurar **en el mismo** proyecto, y la herramienta de dev.
- **`docs/seguridad-manual.md`**: la configuración de los paneles (Auth, Vercel, GitHub), punto por punto.

Lo que depende del plan contratado o no se pudo comprobar desde aquí está
marcado **(por confirmar con Diego)**. Claude Code no ve los paneles de
Supabase ni de Vercel. De producción solo lee el catálogo.

---

## 1. Qué respaldos existen hoy

| Pieza | Respaldo | Qué incluye | Qué **no** incluye | Retención |
|---|---|---|---|---|
| **Base de producción** (Supabase `kigltjvakwuuulvzbyri`) | Respaldo diario automático de Supabase (Database → Backups) | Toda la base de Postgres. Incluye `public`, `auth` (usuarios, hash de contraseñas, identidades) y los **registros** de `storage` (qué archivo hay y dónde) | Los **archivos** de Storage. Tampoco la configuración del proyecto (sección 4, paso 5) | Pro: 7 días · Team: 14 · Enterprise: hasta 30. Free: sin respaldos utilizables. **Plan actual (por confirmar con Diego)** |
| Base, a cualquier minuto | Point in Time Recovery (complemento de pago) | Igual que arriba, eligiendo el minuto | Igual que arriba | **Hoy no está contratado, hasta donde sabemos (por confirmar con Diego)** |
| **Archivos de Storage** (`club-photos` público, `verificacion-docs` privado) | **Ninguno automático.** Solo `node scripts/exportar-storage.mjs` a mano (nuevo, sección 3) | Cada archivo con su tamaño, tipo y sha256, y la configuración de cada bucket | — | Lo que se guarde en `backups/` (la laptop) |
| **Código** | GitHub `diegogvp16/Antroapp` (`master` protegida) | Todo lo que esté **empujado** | Las ramas sin empujar: hoy `post-junta-4` vive **solo en la laptop** (sin upstream, 27/11) | Indefinida |
| **Esquema y SQL** | En Git: `sql/esquema/esquema-prod.sql` (se regenera del catálogo) y cada `sql/**` con su rollback | Estructura, funciones, RLS, triggers, buckets, políticas de Storage | Datos | Indefinida |
| **Deploys** | Vercel guarda los deploys anteriores (Instant Rollback) | El build de cada deploy | Las variables de entorno no se pueden leer de vuelta si son Sensitive | Según plan de Vercel **(por confirmar con Diego)** |
| **Variables y llaves** | Vercel (Production y Preview) y, en la laptop, `.env.local` y `.env.dev` | — | No hay copia en Git (y no debe haberla). **¿Están en un gestor de contraseñas? (por confirmar con Diego)** | — |
| **Respaldos locales** (`backups/`, ignorado por Git) | `respaldar-dev.mjs` (dev, completo), los `prod-2026-11-2x-*` (copias puntuales de producción en JSON, hechas antes del pase), `storage-*` (archivos) | Filas de `public` en JSON y los usuarios de Auth **sin contraseña** | No sirven para restaurar Auth. Viven en un solo disco | Mientras exista la laptop. **¿Disco cifrado, con copia fuera? (por confirmar con Diego)** |

Lo importante:
1. **Storage no está en el respaldo de la base.** Si se borra una foto o un documento, el respaldo diario no la trae de vuelta: solo trae el registro que dice que existía.
2. **Fuera de Supabase no hay hoy ningún respaldo completo de la base de producción.** Los JSON de `backups/prod-*` son puntuales y no traen contraseñas. Si se pierde la cuenta o la organización de Supabase, sus respaldos se pierden con ella.

---

## 2. Qué se perdería en cada escenario

RPO = cuánto trabajo reciente se pierde. RTO = cuánto tarda la app en volver.

| Escenario | Qué se pierde | Cómo se recupera | RPO | RTO |
|---|---|---|---|---|
| Deploy malo | Nada | Vercel → Instant Rollback (`operacion.md`) | 0 | 5–10 min |
| SQL malo (esquema) | Nada, si es solo estructura | El `*-rollback.sql` de ese archivo | 0 | 15–30 min |
| Datos dañados o borrados (error humano, bug) | Lo posterior al respaldo elegido | Respaldo a un proyecto aparte y copiar solo las filas dañadas, o restaurar todo (`operacion.md`) | Hasta 24 h (con PITR, minutos) | 1–3 h |
| Fotos o documentos borrados en Storage | Los archivos desde la última exportación | Subirlos desde `backups/storage-*` a mano en el panel. El importador se niega contra producción: ver la nota abajo. Si no hay exportación, el dueño vuelve a subir fotos y documentos | Desde la última exportación (hoy: **nunca** se ha exportado producción) | 30 min–1 h |
| **Proyecto de Supabase perdido o inservible** (borrado, cuenta bloqueada, falla larga de la región) | Lo posterior al último respaldo disponible | Proyecto nuevo (sección 4) | 24 h si los respaldos de Supabase siguen a la mano. **Si se perdió la cuenta: todo**, salvo un respaldo lógico propio y la exportación de Storage | ≈ 3–4 h (sección 5) |
| Vercel caído o proyecto borrado | Nada de datos | Volver a importar el repositorio en Vercel y cargar las variables desde el gestor de contraseñas | 0 | 1 h |
| GitHub perdido | Nada, si la laptop está bien | Empujar desde la laptop a un repositorio nuevo y reconectar Vercel | 0 | 30 min |
| **Laptop perdida o robada** | `backups/` (datos personales), `.env.*` y las ramas sin empujar | Rotar **ya** la service role, la contraseña de la base y las llaves de Stripe y Resend (las tenía la laptop). Lo demás vive en GitHub y Supabase | Las ramas sin empujar | 1–2 h de rotación |

**Nota sobre Storage en producción**: `scripts/dev/importar-storage.mjs` se
niega a subir a producción a propósito. Para devolver unos cuantos archivos
borrados a producción, súbelos desde el panel (Storage → bucket → carpeta →
Upload) con el mismo nombre que dice `manifiesto.json`. Si alguna vez hace falta
devolver muchos, habilitar un modo de producción en el importador es
**decisión de Diego** y lleva su propia revisión.

---

## 3. Exportar y probar Storage

### Exportar

```bash
node scripts/exportar-storage.mjs                                  # dev (.env.dev)
node scripts/exportar-storage.mjs --env=<llaves de prod> --produccion
```

- Solo **lee**: lista los buckets, lista sus objetos a cualquier profundidad y los descarga.
- Contra producción exige `--env` explícito y `--produccion`, y avisa que descarga también los documentos privados de `verificacion-docs` (identificaciones y comprobantes fiscales).
- La carpeta (`backups/storage-<AAAA-MM-DD-HH-MM>-<origen>/`) se queda en la laptop. Nunca va a Git, a Drive ni a WhatsApp.
- Deja `archivos/<bucket>/<ruta>`, `manifiesto.json` (por archivo: ruta, tamaño, tipo, cache-control y sha256; por bucket: público o privado, límite y tipos) y `manifiesto.sha256`.
- Al terminar verifica:
  - relee cada archivo del disco y compara tamaño y huella;
  - compara el tamaño con el que reporta Storage;
  - revisa que no sobren archivos;
  - vuelve a listar Storage para avisar si algo cambió mientras exportaba.
- Imprime solo conteos, tamaños y huellas.
- La fecha de la carpeta está en UTC, igual que en `respaldar-dev`.

Claude Code **no** lo corre contra producción. Lo corre Diego, con las llaves
de producción en un archivo propio (no `.env.dev`). Ese archivo se borra al
terminar.

### Importar (proyecto que no sea producción)

```bash
node scripts/dev/importar-storage.mjs backups/storage-<fecha>-<origen>                       # simula
node scripts/dev/importar-storage.mjs backups/storage-<fecha>-<origen> --env=<archivo> --si  # sube
node scripts/dev/importar-storage.mjs backups/storage-<fecha>-<origen> --prueba-temporal     # ensayo en dev
```

- Se niega si la URL o la service role son de producción, o si la URL y la llave son de proyectos distintos.
- Antes de subir, revisa que la exportación esté íntegra (huella del manifiesto y de cada archivo).
- Crea los buckets que falten con la misma configuración.
- Si un objeto ya existe: con el mismo contenido lo deja; con otro contenido, o con registro pero sin archivo (pasa cuando la base restaurada trae `storage.objects`), lo reporta como falla. Con `--sobrescribir`, lo reemplaza.
- Al terminar descarga cada objeto del destino y compara su sha256.
- `--prueba-temporal` sube a buckets `tmp-rest-<hora>-<bucket>`, verifica y los vacía y borra, aunque algo falle. Además compara los buckets reales antes y después.

### Prueba en dev (27/11/2026)

| Prueba | Resultado |
|---|---|
| Exportar dev | 2 buckets, 6 archivos, 0.15 MB, en 2.4–2.9 s. 6/6 huellas OK al releer |
| Importar esa exportación con `--prueba-temporal` | 6/6 huellas OK en el destino y la misma huella del conjunto. Buckets temporales borrados. Buckets reales iguales antes y después |
| Exportación sintética con los casos difíciles, importada a buckets `tmp-ensayo-*` | 8/8. Casos: bucket privado con límite de 10 MB y tipos permitidos, rutas de 5 niveles, `:` y espacios en el nombre, `CON.jpg`, carpeta que termina en punto, archivo vacío y un PDF de 3 MB |
| Reimportar lo mismo | 8 «ya estaban iguales» |
| Una variante con un archivo distinto | Sin `--sobrescribir`: falla, como debe. Con `--sobrescribir`: 1 reemplazado y 8/8 |
| `exportar-storage` sobre esos buckets temporales | 14/14, y los 8 sintéticos idénticos a los originales (misma configuración del bucket privado) |
| Esa exportación, importada otra vez con `--prueba-temporal` | 14/14 |
| Velocidad (80 MB: 40 archivos de 2 MB) | Subida más verificación en 21.4 s, ≈ 7.5 MB/s sumando las dos. Unos **4–5 min por GB** desde la laptop de Diego |
| Candados (llaves falsas, sin red) | Llaves de prod sin `--produccion`: aborta. `--produccion` con llaves de dev: aborta. URL y llave de proyectos distintos: aborta. Importar con llaves de prod, o con dominio propio y llave de prod: aborta |
| Al final | Buckets temporales borrados. Dev con los mismos 2 buckets y la misma huella del conjunto que al inicio (`f5964b09…`) |

**Hallazgo**: Storage sirve las descargas desde un CDN con caché. Un objeto
recién reemplazado se descargaba con el contenido **viejo** hasta que vencía su
`cache-control` (3600 s). La primera verificación de la sobrescritura falló por
eso. Ahora toda descarga lleva `cacheNonce` (`scripts/storage-comun.mjs`).
Lo mismo aplica si alguien revisa a mano una foto recién cambiada.

---

## 4. Restaurar en un proyecto nuevo, paso a paso

Úsalo solo si el proyecto de producción ya no sirve. Si solo se dañaron
datos, ve a `operacion.md`, «Restaurar un respaldo».

### Paso 0. Decidir y avisar (10 min)

1. Anota la hora y qué falla.
2. Avisa a los gerentes por WhatsApp. La puerta y la caja siguen en papel (`operacion.md`, «Durante una noche de operación»).
3. Elige el respaldo: el último diario disponible (o el minuto, con PITR).
4. Elige la exportación de Storage más reciente.

### Paso 1. Crear el proyecto (10 min)

1. supabase.com → la organización de AntroApp → **New project**. Nombre: `antroapp-recuperado`.
2. **Misma región** que producción (según `docs/privacidad-datos.md`, Canadá; confírmalo en Settings → General del proyecto viejo, si todavía abre).
3. Plan **Pro** o superior.
4. Contraseña de la base: una nueva y larga, directo al gestor de contraseñas.
5. Espera a que diga «Healthy» (unos minutos).

### Paso 2. Restaurar la base (15–60 min, según el tamaño y la opción)

Elige **una** opción:

- **A. Desde el respaldo de Supabase** (si la cuenta sigue y el plan lo ofrece): proyecto viejo → Database → Backups → el respaldo → **Restore to a new project** (o «Clone»). Trae `public`, `auth` y los registros de `storage` (incluidos los buckets). **(por confirmar con Diego: que el plan lo ofrezca. El primer ensayo, sección 6, lo confirma.)**
- **B. Respaldo descargado**: Database → Backups → **Download** y restaurarlo con `psql` en el proyecto nuevo. **(por confirmar: que el plan permita descargar y el formato del archivo.)**
- **C. Respaldo lógico propio** (`respaldos.md`, opción B). Es la única que sobrevive a perder la cuenta de Supabase, y **hoy no existe ninguno de producción**. Hace falta instalar las herramientas cliente de Postgres 17 (`pg_dump`, `psql`), que hoy no están en la laptop (27/11). Con la CLI de Supabase el método de su guía es: roles, esquema y datos por separado (`supabase db dump --role-only`, `supabase db dump` y `supabase db dump --data-only --use-copy`), luego `psql --single-transaction` con `SET session_replication_role = replica` antes de los datos. **(por confirmar en el ensayo: que los datos de `auth` viajen así.)**

Al terminar, en el SQL Editor del proyecto nuevo:

```sql
select (select count(*) from pg_tables where schemaname = 'public') as tablas,
       (select count(*) from pg_policies) as politicas,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as funciones,
       (select count(*) from pg_trigger where not tgisinternal) as triggers,
       (select count(*) from storage.buckets) as buckets,
       (select count(*) from auth.users) as usuarios;
```

Los cuatro primeros deben salir iguales que en el esquema de producción. Para
compararlos:
- si producción todavía abre, corre la misma consulta allá;
- si no, cuenta en `sql/esquema/esquema-prod.sql` tras el último pase.

`usuarios` debe ser razonable.

**Pendiente**: `extraer-esquema.mjs` hoy solo acepta `--origen=prod|dev`. Para
la comparación completa con `DATABASE_URL_RESTAURACION` (`respaldos.md`, A.3)
falta un tercer origen.

### Paso 3. Storage (5–15 min hoy; ≈ 5 min por GB)

1. En la laptop, un archivo de llaves **solo para esto**, p. ej. `.env.restauracion`. Lo ignora Git como todos los `.env*`. Lleva `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` del proyecto **nuevo**.
2. Simula:
   ```bash
   node scripts/dev/importar-storage.mjs backups/storage-<fecha>-prod --env=.env.restauracion
   ```
3. Sube:
   ```bash
   node scripts/dev/importar-storage.mjs backups/storage-<fecha>-prod --env=.env.restauracion --si
   ```
   Con la opción A del paso 2, la base ya trae los registros de `storage.objects` pero no los archivos. Agrega `--sobrescribir`.
4. Debe terminar en «OK: importación completa y verificada».
5. **Arreglar las URL de las fotos.** `club_photos.url` guarda la URL pública **completa**, con el ref del proyecto (`https://<ref>.supabase.co/storage/v1/object/public/club-photos/…`). En el proyecto nuevo seguirían apuntando al viejo. En el SQL Editor del proyecto **nuevo**:
   ```sql
   -- Antes: cuántas apuntan al proyecto viejo
   select count(*) from public.club_photos where url like 'https://kigltjvakwuuulvzbyri.supabase.co/%';
   -- Arreglo
   update public.club_photos
     set url = replace(url, 'https://kigltjvakwuuulvzbyri.supabase.co/', 'https://<REF_NUEVO>.supabase.co/')
     where url like 'https://kigltjvakwuuulvzbyri.supabase.co/%';
   -- Rollback: el mismo replace al revés.
   ```
6. Fotos que la base registra pero que no venían en la exportación (subidas después). Con la opción C:
   ```sql
   select count(*) from public.club_photos p
   where not exists (select 1 from storage.objects o where o.bucket_id = 'club-photos' and o.name = p.storage_path);
   ```
   Con la opción A ese conteo sale 0 aunque falten archivos (los registros vienen en la base). Revísalo en `/cliente`. Las que falten, el dueño las vuelve a subir. Los documentos de verificación que falten: el dueño los vuelve a subir, o el admin rechaza con ese motivo.

### Paso 4. Configuración que no viaja en el respaldo (30–45 min)

Nada de esto está en la base. Se copia a mano del proyecto viejo (si abre),
de `docs/seguridad-manual.md` y del gestor de contraseñas.

**Supabase (proyecto nuevo)**

| Dónde | Qué | Referencia |
|---|---|---|
| Authentication → URL Configuration | **Site URL** (`https://antroapp.vercel.app`, o el dominio propio) y **Redirect URLs**. Incluye `/actualizar-contrasena`: la recuperación de contraseña regresa ahí (`app/recuperar-contrasena`) | — |
| Authentication → Email / Providers | Confirmación de correo encendida o no, como en producción. Plantillas de correo, si se personalizaron. SMTP propio, si lo hay **(por confirmar con Diego)** | — |
| Authentication → Attack Protection | Contraseñas filtradas y longitud mínima. CAPTCHA (Turnstile) con la **misma secret key**, solo si estaba encendido | `seguridad-manual.md` §1 y §3, `docs/captcha.md` |
| Authentication → Rate Limits | Los mismos valores | `seguridad-manual.md` §2 |
| Settings → Data API | Esquemas expuestos y «Automatically expose new tables» como en producción | `seguridad-manual.md` §5 |
| Settings → Database | Restricciones de red y SSL, si se usaban **(por confirmar)** | — |
| Storage → Settings | Límite global de tamaño de archivo **(por confirmar)** | — |
| Settings → API | Copia la URL, la anon key y la service role **nuevas** | — |

El proyecto nuevo firma las sesiones con **otras llaves**: todas las sesiones
abiertas se cierran. Con `auth` restaurado, las contraseñas siguen sirviendo y
cada quien vuelve a entrar. Las apps instaladas (Staff/RP/Dueño) piden login
otra vez.

**Vercel → Settings → Environment Variables → Production**

| Variable | ¿Cambia? |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (tipo config) | **Sí**: las del proyecto nuevo |
| `SUPABASE_SERVICE_ROLE_KEY` (Sensitive) | **Sí** |
| `CRON_SECRET` (Sensitive) | No (es de la app, no de Supabase) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_CAPTCHA_TURNSTILE`, `NEXT_PUBLIC_CAPTCHA_MODO` | No, salvo cambio de dominio (el widget de Turnstile lista sus dominios) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PERMITIR_PRODUCCION`, `NEXT_PUBLIC_MENSUALIDAD` | No. El webhook de Stripe apunta a la app en Vercel (`/api/stripe/webhook`), no a Supabase. Solo cambia con dominio nuevo |
| `CORREO_MODO`, `RESEND_API_KEY`, `CORREO_DE`/`ALERTAS_DE`, `CORREO_LISTA_BLANCA`, `ALERTAS_CORREO`, `ALERTAS_PARA`, `URL_PUBLICA` | No |
| `NEXT_PUBLIC_LEGALES`, `NEXT_PUBLIC_FASE2`, `NEXT_PUBLIC_CLUB_DEMO_ID`, `NEXT_PUBLIC_SITIO_URL` | No (los id de los antros se conservan con la base) |

Las `NEXT_PUBLIC_*` se **incrustan en el build**. Después de cambiarlas hay que
hacer un **Redeploy**: no basta con guardarlas. Al redeploy, desmarca «Use
existing Build Cache» **(por confirmar el texto exacto en Vercel)**.

**Fuera de Supabase y Vercel**
- Dominio: hoy la app vive en `antroapp.vercel.app`. El DNS de un dominio propio apunta a Vercel y no cambia.
- UptimeRobot, Stripe y Resend: no cambian.
- **En el repositorio**: `REF_PROD` en `scripts/db/conexion.mjs` (los candados de las herramientas), la tabla de entornos de `CLAUDE.md`, y `DATABASE_URL_PROD` en `.env.dev` y `.env.local` de la laptop con el ref y la contraseña nuevos. Sin esto, `conteos-prod` y `extraer-esquema --origen=prod` siguen apuntando al viejo (o se niegan).
- Preview sigue con las llaves de dev: no se toca.

### Paso 5. Apuntar la app y publicar (15 min)

1. Vercel: las variables del paso 4 → **Redeploy** del último deploy de `master`.
2. Mientras tanto, ningún antro opera en la app (sigue el papel del paso 0).

### Paso 6. Verificar (40 min)

1. `https://antroapp.vercel.app/api/salud`: `"estado":"ok"`.
2. `node scripts/humo-produccion.mjs https://antroapp.vercel.app`: todo en verde.
3. `node scripts/db/conteos-prod.mjs` (con `REF_PROD` y `DATABASE_URL_PROD` ya actualizados). Compara con los conteos del último respaldo y con lo que esperaban los gerentes.
4. Recorrido de los 6 roles a mano (`docs/pase-produccion.md`, paso 9), y además:
   - login con una cuenta real;
   - fotos en `/cliente` y en la ficha de un antro;
   - un documento de verificación abierto desde `/admin` (URL firmada);
   - una reserva nueva y su `/r/<codigo>`;
   - abrir y cerrar una mesa de prueba en Club Demo.
5. Con la mensualidad encendida: Stripe → Webhooks → **Send test event** (debe responder 2xx). Al día siguiente, revisa que la tarea diaria (16:00 UTC) haya corrido.
6. Avisa a los gerentes que la app regresó. Lo anotado en papel se captura (`operacion.md`).

### Paso 7. Después

- El proyecto viejo: **pausar, no borrar**, al menos 30 días (por si algo faltó).
- Si la causa fue una llave filtrada: rota las llaves del proyecto viejo.
- Anota qué pasó, cuánto se perdió y cuánto tardó cada paso: así se corrigen los tiempos de este documento.

---

## 5. Tiempos, RPO y RTO

| Paso | Estimado |
|---|---|
| 0. Decidir y avisar | 10 min |
| 1. Crear el proyecto | 10 min |
| 2. Restaurar la base (A o B; C si hay respaldo propio) | 15–60 min **(por confirmar en el ensayo; la base de hoy es chica)** |
| 2. Comparar el catálogo | 10 min |
| 3. Storage (hoy pocos MB; ≈ 5 min por GB) y URL de fotos | 10–20 min |
| 4. Configuración de Auth, Data API y Vercel | 30–45 min |
| 5. Redeploy | 15 min |
| 6. Verificación (humo, conteos, recorrido) | 40 min |
| **Total** | **≈ 2 h 30 min – 3 h 30 min** |

Contando que no todo sale a la primera, **RTO realista: 4 horas** en horario
de Diego. De noche, hasta la mañana siguiente: mientras tanto, papel.

**RPO** (cuánto se pierde):
- **Base y cuentas**: hasta **24 h** con el respaldo diario. Si pasa un sábado a las 3 a. m., se pierde la caja del viernes y la noche en curso, y se captura del papel. Con PITR, unos minutos **(por confirmar el valor que da Supabase)**.
- **Archivos**: desde la **última exportación**. Producción no se ha exportado nunca: hoy el RPO de las fotos y documentos es «todo».
- **Si se pierde la cuenta de Supabase**: desde el último respaldo lógico propio. Hoy no hay: se perdería todo menos el código y los JSON puntuales de `backups/prod-*`.

**Para bajar el RPO** (decisiones de Diego, en orden de impacto):
1. Exportar Storage de producción **cada semana y antes de cada pase**. Hoy son pocos MB: menos de 1 minuto.
2. Un respaldo lógico propio de la base cada semana. Instalar las herramientas de Postgres 17 o la CLI de Supabase; lo corre Diego, porque lee datos de producción.
3. Copiar `backups/` a un disco o almacenamiento cifrado fuera de la laptop.
4. Valorar PITR cuando la caja se use todas las noches.
5. Guardar todas las variables de Vercel en el gestor de contraseñas.

---

## 6. Ensayos

| Ensayo | Cada cuánto | Cómo | Tiempo |
|---|---|---|---|
| Storage en dev | Cada mes y cuando cambie `scripts/*storage*` | `node scripts/exportar-storage.mjs` y luego `node scripts/dev/importar-storage.mjs backups/storage-<fecha>-dev --prueba-temporal` | 1 min |
| Exportación de producción | Cada semana y antes de cada pase | Diego: `node scripts/exportar-storage.mjs --env=<llaves de prod> --produccion`. Debe terminar en «OK» | 1–5 min |
| Restauración completa en un proyecto de prueba | **Una vez cuanto antes**, después cada 3 meses y después de cada cambio de plan | Las secciones 4 y 5 contra un proyecto `antroapp-restauracion-prueba`. Sin cambiar Vercel de producción: se apunta un deploy Preview o `servidor-prod-dev` a ese proyecto. Anota los tiempos reales. Al final, **borra el proyecto** (cobra) y la exportación de prod si no se va a guardar | 2–3 h |
| Revisar respaldos de Supabase | Cada semana | `operacion.md`, «Cada semana», punto 1 | 2 min |

El primer ensayo completo cierra los **(por confirmar)** de este documento:
- si el plan restaura a un proyecto nuevo;
- si `auth` viaja;
- cuánto tarda la base;
- el texto de las opciones de Vercel.
