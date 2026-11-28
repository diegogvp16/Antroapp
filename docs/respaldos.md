# Respaldos de Supabase y cómo probar una restauración

> Escrito el 20/11/2026. Claude Code no tiene acceso al dashboard de Supabase
> ni a los datos de producción (solo lee su catálogo, en modo solo lectura),
> así que **la revisión del plan y de los respaldos la hace Diego** con estos
> pasos. Nada de esto toca producción salvo el paso 1, que solo mira.

## 1. Revisar qué respaldos hay (5 minutos, solo mirar)

1. supabase.com → proyecto **antroapp** (producción, ref `kigltjvakwuuulvzbyri`)
   → **Database → Backups**.
2. Anota:
   - **Plan** del proyecto (Settings → Billing). En **Free** no hay respaldos
     descargables ni restaurables: si es Free, lo primero es subir a **Pro**
     antes de tener datos reales de antros.
   - **Respaldos diarios** (Pro: últimos 7 días; Team: 14; Enterprise: 30):
     ¿aparecen fechas recientes, una por día?
   - **Point in Time Recovery (PITR)**: complemento de pago que permite volver
     a cualquier minuto. Con caja real (dinero de antros) vale la pena
     considerarlo.
3. Si no aparece ningún respaldo reciente, **avísame antes del pase a
   producción** (bloque 6): no se aplica SQL nuevo sin un respaldo fresco.

## 2. Probar una restauración SIN tocar producción

**Nunca uses "Restore" sobre el proyecto de producción para probar**:
restaurar en el mismo proyecto reemplaza la base actual por la del respaldo
(se pierde todo lo posterior).

### Opción A (recomendada): restaurar en un proyecto nuevo

1. Database → Backups → en un respaldo, **"Restore to a new project"** (si tu
   plan lo ofrece). Ponle un nombre como `antroapp-restauracion-prueba`.
2. Cuando termine, en el proyecto nuevo:
   - Table Editor: revisa que estén `clubs`, `reservations`, `profiles` con
     el número de filas esperado (compáralo con producción en el mismo
     momento del respaldo).
   - Authentication → Users: que estén los usuarios.
   - Storage: que estén los buckets `club-photos` y `verificacion-docs`.
     **Ojo:** los respaldos de base de datos **no incluyen los archivos de
     Storage**; solo sus registros. Las fotos se respaldan aparte (ver 3).
3. Si quieres que yo lo verifique: pon en `.env.dev` una línea
   `DATABASE_URL_RESTAURACION=...` (Session pooler del proyecto nuevo) y te
   comparo su esquema contra producción con
   `scripts/db/extraer-esquema.mjs` (mismo método que dev: debe salir
   idéntico).
4. Al terminar, **pausa o borra** el proyecto de prueba para que no cobre.

### Opción B: respaldo lógico propio (si el plan no restaura a proyecto nuevo)

Con las herramientas de Postgres instaladas (`pg_dump` y `psql`, versión 17):

```bash
# Respaldo (solo lectura sobre producción)
pg_dump "<DATABASE_URL_PROD>" --schema=public --schema=auth --no-owner \
  --format=custom --file=backups/antroapp-AAAA-MM-DD.dump

# Restaurar en un proyecto VACÍO de prueba (nunca en producción ni en dev)
pg_restore --no-owner --dbname="<URL del proyecto de prueba>" backups/antroapp-AAAA-MM-DD.dump
```

`backups/` está en `.gitignore` (trae datos personales): el archivo nunca va a
Git ni a Vercel.

## 3. Archivos de Storage (fotos y documentos)

Los respaldos de Supabase cubren la base de datos, no los archivos. Hoy las
fotos de los antros y los documentos de verificación solo existen en
Storage.

Desde el 27/11/2026 hay script:
- `node scripts/exportar-storage.mjs` exporta todos los buckets a `backups/storage-<fecha>-<origen>/`, con manifiesto y huellas. Solo lee.
- `scripts/dev/importar-storage.mjs` lo sube a un proyecto que no sea producción, para restaurar.

Uso, prueba en dev, frecuencia y la restauración completa en un proyecto
nuevo: **`docs/recuperacion.md`**. Producción todavía no se ha exportado: lo
corre Diego (`--env=<llaves de prod> --produccion`), cada semana y antes de
cada pase.

## 4. Qué hacer antes del pase a producción (bloque 6)

1. Confirmar en Database → Backups que hay un respaldo de **ese mismo día**
   (o tomar uno manual si el plan lo permite).
2. Tener a mano los `*-rollback.sql` de cada archivo (ya probados en dev:
   dejan el esquema idéntico al de producción).
3. Aplicar en el orden del bloque 6 y verificar después de cada paso.
