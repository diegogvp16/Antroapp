# Operación de AntroApp

Escrito el 24/11/2026 (rama `post-junta`). Qué revisar cada día y cada
semana, cómo reaccionar si algo se cae y cómo restaurar un respaldo. Lo
marcado **(pase 2)** existe solo después de aplicar el SQL y el código de
`post-junta` en producción.

## Herramientas

| Qué | Dónde | Para qué |
|---|---|---|
| Salud **(pase 2)** | `https://antroapp.vercel.app/api/salud` | 200 = app y base bien; 503 = la app responde pero la base no. Sin datos personales. |
| Errores recientes | `/admin` → «Errores recientes» | Errores que vieron los usuarios en pantalla, agrupados, con conteo de 24 h. **(pase 2)**: sin correos, teléfonos ni tokens. |
| Bandeja de correos | `/admin` → «Bandeja de correos» | Cada correo que la app mandó, archivó o no pudo mandar (30 días), con el modo de envío actual. No incluye los de Supabase. |
| Logs | Vercel → proyecto → **Logs** (filtro **Level: Error**) | Errores del servidor. Los nuevos **(pase 2)** registran solo código y tipo, sin datos personales (`lib/log.ts`). |
| Mensualidades **(pase 2, con bandera)** | `/admin/mensualidad` | Antros en gracia o vencidos. |
| Humo | `node scripts/humo-produccion.mjs https://antroapp.vercel.app` | Solo GET, sin sesión: páginas, cabeceras, manifiestos. |
| Conteos | `node scripts/db/conteos-prod.mjs` | Producción en solo lectura, conteos fijos, sin datos personales. |

## Cada día (por la mañana, después del corte de las 08:00)

1. Abre `/api/salud` **(pase 2)**: debe decir `"estado":"ok"` y `ms` de menos
   de 1000.
2. `/admin` → «Errores recientes»: la etiqueta de 24 h en verde (0) o ámbar
   (pocos). Si está en rojo (10 o más), abre el más repetido y revisa su ruta.
3. Vercel → Logs → Level: Error, últimas 24 h: no debe haber el mismo error
   repetido muchas veces.
4. Si un antro usa la caja: en su `/grupo` o en la nómina, que la noche
   anterior aparezca **cerrada**. Si no, avisa al gerente (la conversión solo
   cuenta noches cerradas).
5. **(pase 2, con mensualidad)** `/admin/mensualidad`: antros «En periodo de
   gracia» (avísales antes de que venza) y «Vencida» (ya no se ven al público).

## Cada semana (lunes)

1. Supabase → **Database → Backups**: un respaldo por día, en «Completed».
   Si falta alguno, abre un ticket a Supabase. Los archivos de Storage **no**
   vienen ahí: `node scripts/exportar-storage.mjs --env=<llaves de prod> --produccion`
   (`docs/recuperacion.md`).
2. Supabase → **Advisors → Security**: sin avisos nuevos.
3. Limpieza de intentos viejos **(pase 2)**: Supabase → SQL Editor:
   `select public.antiabuso_limpiar();`. Borra intentos de login y registro
   de más de 30 días.
4. Cuentas huérfanas del alta **(pase 2)**: solo lista, no borra:
   `node scripts/limpiar-altas-huerfanas.mjs --env=.env.local --produccion`.
   Si aparece alguna, decide si se borra (`--borrar`).
5. `npm audit` en la laptop: si hay algo **high** o **critical** en
   dependencias de la app (no de desarrollo), actualizar en una rama, probar y
   pasar.
6. Revisa el personal dado de baja que debería seguir así (`/dueno/equipo`).

## Monitoreo automático (recomendado)

### 1. Monitor externo de salud (gratis)

1. Crea una cuenta en **UptimeRobot** (o Better Stack).
2. **New monitor** → tipo **HTTP(s)**.
3. URL: `https://antroapp.vercel.app/api/salud` **(pase 2)**. Antes del pase,
   usa `https://antroapp.vercel.app/`.
4. Intervalo: **5 minutos**. Alerta: tu correo (y WhatsApp o SMS si lo ofrece).
5. **Qué deberías ver**: el monitor en verde («Up»). Para probarlo, pon una
   URL inexistente un momento: debe avisarte en unos minutos.

### 2. Alertas por correo de la app (pase 2, bandera apagada)

La app puede mandarte un correo si hay un **pico de errores** (10 o más en 10
minutos), si **falla el cobro** de la mensualidad de un antro, o si la tarea
diaria **despublica** antros vencidos. Cada tipo, máximo una vez por hora
(`lib/alertas.ts`, `sql/post-junta/11-alertas.sql`). Sin datos personales.

1. **resend.com** → crea la cuenta → **Domains** → **Add Domain**: tu dominio
   (si no tienes uno propio, Resend solo deja mandar a tu propio correo
   desde `onboarding@resend.dev`, suficiente para alertas).
2. Agrega en tu DNS los registros que te da Resend y espera a que digan
   **Verified**.
3. **API Keys** → **Create API Key** → permiso **Sending access** → copia
   la llave a tu gestor de contraseñas (no al repositorio ni al chat).
4. Vercel → Settings → Environment Variables → **Production**:

   | Nombre | Valor | Tipo |
   |---|---|---|
   | `ALERTAS_CORREO` | `1` | Plain |
   | `ALERTAS_PARA` | tu correo | Plain |
   | `CORREO_MODO` | `enviar` | Plain |
   | `RESEND_API_KEY` | la llave del paso 3 | **Sensitive** |
   | `CORREO_DE` | `alertas@tu-dominio` (o `onboarding@resend.dev`; `ALERTAS_DE` también sirve) | Plain |

5. Redeploy.

**Ojo (desde post-junta-2, B7)**: todos los correos de la app salen por un
solo punto (`lib/correo.ts`) y quedan en la **bandeja** `/admin/correos`. Sin
`CORREO_MODO=enviar` el modo es **archivo**: la alerta se guarda en la
bandeja pero **no llega a tu correo**. Y aunque pongas `enviar`, en vista
previa, dev o local solo se manda a los correos de `CORREO_LISTA_BLANCA`
(separados por coma); a los demás se archiva. `CORREO_MODO=apagado` no
manda ni guarda nada. Los correos de Supabase (recuperar contraseña,
confirmar registro) **no** pasan por aquí.

**Qué deberías ver**: nada hasta que haya un problema. Para probar en una
vista previa: pon ahí `ALERTAS_CORREO=1`, `ALERTAS_PARA` y, si quieres que
llegue, `CORREO_MODO=enviar`, la llave, `CORREO_DE` y tu correo en
`CORREO_LISTA_BLANCA`. Provoca 10 errores (por ejemplo, abriendo 10 veces
una página que falle en esa vista previa) y revisa `/admin/correos` (y tu
correo, si lo pusiste en la lista blanca; el asunto llega con «[Prueba]»).
Apagarlas: quita `ALERTAS_CORREO`.

## Si algo se cae

### Síntoma → primer paso

| Síntoma | Primer paso |
|---|---|
| Nadie puede entrar a la app | Abre `/api/salud`. Si no carga: **Vercel**. Si dice `sin_base`: **Supabase**. |
| Todo carga pero «No pudimos…» en todas las pantallas | Supabase: status.supabase.com y el panel del proyecto (¿pausado? ¿límite de uso?). |
| Falla después de un deploy | **Vercel → Deployments → Instant Rollback** al anterior (`docs/seguridad-manual.md`, punto 7). |
| Falla después de un SQL | El **rollback** de ese SQL (cada archivo en `sql/` y `sql/post-junta/` tiene el suyo). |
| Errores en una sola pantalla | `/admin` → «Errores recientes» y Vercel Logs con esa ruta. |
| Login bloqueado para alguien | Espera 15 min, o revisa si lo dieron de baja (`/dueno/equipo`). |

### Durante una noche de operación

1. **La puerta no se detiene**: si la cámara o el escáner fallan, «Confirmar
   entrada sin cámara» desde la lista de la noche. Si la app entera cae: la
   puerta anota a mano (nombre y hora) y se captura después.
2. **La caja**: si cae, el antro cobra como siempre y anota en papel mesa,
   consumo y pago. Cuando regrese la app, se captura (la caja guarda quién y
   cuándo; el motivo explica que fue captura tardía).
3. **Nunca** se cambia SQL de producción a media noche: primero Instant
   Rollback del código, y el SQL al día siguiente con calma.
4. Avisa a los gerentes por WhatsApp qué pasa y cuándo esperas que regrese.

### Después

1. Anota qué pasó, desde cuándo, qué se hizo y qué se perdió (si algo).
2. Si se capturó a mano, revisa con el gerente que la caja cuadre.

## Restaurar un respaldo

### Producción (Supabase)

> Si el proyecto entero se perdió (no solo datos dañados): restauración en un
> proyecto nuevo, Storage incluido, en `docs/recuperacion.md`.

> Restaurar reemplaza **toda** la base por la del momento del respaldo: lo
> que pasó después (reservas, caja, cuentas nuevas) **se pierde**. Es el
> último recurso, nunca a media noche de operación.

1. **Decide el momento**: Supabase → **Database → Backups**. Con Point in
   Time Recovery (de pago) puedes elegir minuto; si no, uno diario.
2. **Antes de restaurar**:
   - avisa a los antros que la app estará en mantenimiento;
   - en Vercel, deja una vista de mantenimiento o haz Instant Rollback a un
     deploy estable;
   - anota la hora exacta y qué se va a perder.
3. **Restaurar sin perder lo nuevo** (recomendado si solo se dañó una
   parte): en Backups, **Restore to a new project** (si tu plan lo ofrece).
   Así tienes el respaldo en un proyecto aparte y copias solo las filas
   dañadas, con un SQL revisado.
4. **Restaurar todo**: en Backups, el respaldo elegido → **Restore** →
   confirma. Tarda de minutos a horas según el tamaño; el proyecto no responde
   mientras tanto.
5. **Después**:
   - `node scripts/db/extraer-esquema.mjs --origen=prod --salida=…` y
     compara con `sql/esquema/esquema-prod.sql` (que el esquema sea el
     esperado);
   - `node scripts/db/conteos-prod.mjs` (conteos razonables);
   - `node scripts/humo-produccion.mjs https://antroapp.vercel.app`;
   - recorrido de los 6 roles a mano (`docs/pase-produccion.md`, paso 9).
6. Las **cuentas** (Auth) se restauran junto con la base: quien cambió su
   contraseña después del respaldo vuelve a la anterior.

### Dev (probado el 24/11/2026)

```bash
node scripts/dev/respaldar-dev.mjs <nombre>                       # foto de los datos de dev
node scripts/dev/restaurar-dev.mjs backups/dev-<fecha>-<nombre>    # simula
node scripts/dev/restaurar-dev.mjs backups/dev-<fecha>-<nombre> --si
```

Prueba hecha:
1. Respaldo (43 tablas, 1,209 filas).
2. Daño a propósito: cambiar el nombre de Club Demo Dev, borrar los 6 turnos
   de RP y meter un error falso.
3. Restaurar: **42 tablas idénticas al respaldo** (verificado fila por fila
   antes de confirmar), en 14.2 s. La que falta respecto a las 43 es una
   tabla que ya no existe en dev y se ignora.
4. Después: `verificar-cuadre` sin diferencias, dashboards 28/28 y caja
   167/167.

Límites de la herramienta de dev:
- No restaura usuarios de Auth (el respaldo no tiene contraseñas). Si se
  borró un usuario, `sembrar-dev` lo vuelve a crear.
- No restaura el esquema; para eso: `aplicar-dev.mjs --reiniciar` con el
  `esquema.sql` del respaldo.
- Es **solo para dev** (se niega contra producción).
