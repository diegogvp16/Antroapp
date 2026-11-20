# Pase a producción — runbook paso a paso

> Preparado la noche del 19/11/2026. **Nada de esto se ha ejecutado en
> producción.** Lo corre Diego, o Claude Code cuando Diego lo pida de forma
> explícita. Cada paso dice si se puede deshacer:
>
> - **[REVERSIBLE]** tiene rollback probado en dev.
> - **[REVERSIBLE CON CUIDADO]** el rollback borra lo que se haya capturado
>   después.
> - **[IRREVERSIBLE]** no tiene vuelta atrás.
>
> Producción: Supabase `kigltjvakwuuulvzbyri`, rama `master`, antroapp.vercel.app.

## Antes de empezar

- **Cuándo**: de día, sin antros operando, idealmente lunes a miércoles
  antes de las 18:00. Los pasos 5 (estabilidad) y 8 (merge) van **seguidos,
  el mismo día y con minutos de diferencia** (ver paso 5).
- **Tiempo estimado**: 60–90 minutos, más el recorrido de roles.
- **Estado de la rama `desarrollo`**: todas las pruebas en verde contra dev
  (ver "Pruebas en dev" al final) y el build de producción sin errores.
- **El catálogo de producción no ha cambiado** desde
  `sql/esquema/esquema-prod.sql`: se comparó el 19/11/2026 en solo lectura
  y no hubo ninguna diferencia. Si pasan días antes del pase, repetirlo:
  ```bash
  node scripts/db/extraer-esquema.mjs --origen=prod --salida=<scratch>/prod-hoy.sql
  diff sql/esquema/esquema-prod.sql <scratch>/prod-hoy.sql   # debe salir vacío (salvo finales de línea)
  ```
- **Cómo pegar cada archivo en el SQL Editor**: abrir el `.sql` en el editor
  de código, copiar todo y pegarlo en una pestaña nueva del SQL Editor,
  agregando `begin;` en la primera línea y `commit;` en la última. Si algo
  falla, Postgres revierte el archivo completo y la base queda como estaba.
  Se corrige y se vuelve a pegar entero. Ningún archivo se corre dos veces
  si ya terminó bien: no todos son idempotentes.
- **Los rollbacks solo funcionan en orden inverso**: el de un paso supone
  que los pasos posteriores ya se revirtieron. La cadena completa (todos
  los rollbacks, del último al primero) se probó en dev el 19/11/2026 y dejó
  el esquema **idéntico** al de producción.

## Orden

| # | Paso | Tipo | Tiempo |
|---|---|---|---|
| 1 | Respaldo del día | — | 10 min |
| 2 | Diagnósticos de solo lectura | — | 5 min |
| 3 | `sql/2026-11-20-cover.sql` | REVERSIBLE | 2 min |
| 4 | `sql/2026-11-20-caja-por-mesa.sql` | REVERSIBLE CON CUIDADO | 5 min |
| 5 | `sql/2026-11-20-estabilidad.sql` | REVERSIBLE | 2 min |
| 6 | `sql/2026-11-20-nomina-y-grupo.sql` | REVERSIBLE | 2 min |
| 7 | `sql/2026-11-21-rp-panel.sql` y `sql/2026-11-21-caja-permisos.sql` | REVERSIBLE | 2 min |
| 8 | Merge `desarrollo` → `master` (auto-deploy) | REVERSIBLE (redeploy anterior) | 10 min |
| 9 | `sql/2026-11-20-caja-candado-puerta.sql` | REVERSIBLE | 2 min |
| 10 | Recorrido de los 6 roles en producción | — | 30 min |
| 11 | Datos demo para la junta (25/11 después de las 08:00) | IRREVERSIBLE para lo demo | 10 min |

---

## 1. Respaldo del día

Seguir `docs/respaldos.md` sección 1: confirmar que hay un respaldo diario
de **hoy** en Database → Backups. Si el plan es Free (sin respaldos
restaurables), **no seguir**: subir a Pro o decidirlo con el socio.

Respaldo lógico adicional (opcional, recomendado): en el SQL Editor,
exportar a CSV `reservations`, `profiles`, `clubs`, `commissions` y
`rp_pagos_dia` (Table Editor → Export). Guardarlos en `backups/`, que no va
a Git.

## 2. Diagnósticos (solo lectura)

Cada uno debe regresar **0 filas**. Si alguno regresa filas, parar: el paso
correspondiente fallaría y hay que decidir qué hacer con esos datos.

```sql
-- a) Reservas duplicadas por cliente, antro y noche (bloquea el índice del paso 5).
--    Corrido el 19/11/2026: 136 reservas, 0 con cuenta de cliente, 0 duplicadas.
select cliente_id, club_id, fecha, count(*)
from public.reservations
where cliente_id is not null and status in ('pendiente', 'confirmada', 'usada')
group by 1, 2, 3 having count(*) > 1;

-- b) Pagos por día duplicados por asistencia (bloquea el índice del paso 5).
select rp_attendance_id, count(*)
from public.rp_pagos_dia
group by 1 having count(*) > 1;

-- c) Estados de pagos por día fuera de la lista nueva (bloquea el check del paso 6).
select status, count(*)
from public.rp_pagos_dia
where status not in ('pendiente', 'en_revision', 'validada', 'pagada', 'anulada')
group by 1;

-- d) Dueños con más de un antro (/dueno/panel asume uno solo).
select dueno_id, count(*) from public.clubs
where dueno_id is not null group by 1 having count(*) > 1;
```

El diagnóstico completo de duplicados, con sus variantes por teléfono,
está en `sql/2026-11-borrador-una-reserva-por-dia.sql`, **PASO 0**. Solo
ese paso: es SELECT puro. El resto de ese archivo **no se corre** (el
índice ya viene en estabilidad).

## 3. Cover informativo — `sql/2026-11-20-cover.sql`

Agrega `cover_modo` y `cover_monto` a `clubs` (con default `oculto`) y fija
el default de `deposito_monto` en 0. No cobra nada: es informativo.

- **Verificar**:
  ```sql
  select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'clubs' and column_name like 'cover_%';
  -- cover_modo, cover_monto
  ```
- **Rollback**: `sql/2026-11-20-cover-rollback.sql`. Borra las columnas y
  con ellas cualquier cover que un dueño haya capturado.

## 4. Caja por mesa — `sql/2026-11-20-caja-por-mesa.sql`

El archivo grande (≈1,900 líneas). Agrega:
- Tablas de caja: `caja_noches`, `mesa_sesiones`, `mesa_cuentas`,
  `caja_consumos`, `caja_pagos`, `caja_cuadres`, `caja_permisos`,
  `caja_eventos`.
- Grupos de antros: `grupos`, `grupo_clubs`, `grupo_miembros`.
- Puerta y zona horaria del antro, con sus candados de reservas y perfiles.
- Funciones de caja y de nómina. Ya incluye:
  - un RP o staff dado de baja no ve la caja ni su nómina;
  - índices por noche;
  - la secuencia de eventos cerrada al navegador.

Todas las tablas nuevas llevan RLS y GRANT explícitos (revoca a `anon` y
`public`; el navegador solo lee). En dev se comprobó que `anon` no tiene
ningún privilegio sobre ellas.

- **Verificar** (Claude Code lo puede revisar en solo lectura con
  `extraer-esquema --origen=prod`):
  ```sql
  select count(*) from pg_tables where schemaname = 'public'
    and tablename in ('caja_noches','mesa_sesiones','mesa_cuentas','caja_consumos','caja_pagos',
                      'caja_cuadres','caja_permisos','caja_eventos','grupos','grupo_clubs','grupo_miembros');
  -- 11
  select count(*) from pg_tables where schemaname = 'public' and rowsecurity = false;
  -- 0
  ```
- **Rollback**: `sql/2026-11-20-caja-por-mesa-rollback.sql`. Es
  **reversible con cuidado**: borra las tablas de caja con todo lo que se
  haya registrado. Antes de que un antro opere con caja real, no se pierde
  nada. Después, solo con respaldo previo.

## 5. Estabilidad — `sql/2026-11-20-estabilidad.sql`

- Índice "1 reserva por cliente, antro y noche".
- `registrar_comision_reserva` y `registrar_pago_dia` reescritas para no
  confiar en datos del navegador.
- Tablas `login_intentos` (límite de intentos de login) y `app_errores`.

**Importante: este paso y el merge (paso 8) van seguidos.**
- El código **nuevo** necesita `login_intentos`: sin este paso, los
  formularios de login responden error.
- El código **viejo**, con estas funciones nuevas, deja de generar
  comisiones de RP desde el panel de staff anterior.
- Por eso la ventana entre los pasos 5 y 8 debe ser de minutos y sin antros
  operando.

- **Verificar**:
  ```sql
  select indexname from pg_indexes where indexname in
    ('reservations_una_por_cliente_dia', 'rp_pagos_dia_una_por_asistencia');   -- 2 filas
  select to_regclass('public.login_intentos'), to_regclass('public.app_errores');  -- ninguno nulo
  ```
- **Si falla con `23505` (duplicate key)**: hay duplicados que el paso 2 no
  detectó (por ejemplo, se crearon entre el diagnóstico y este paso).
  Postgres revirtió todo. Volver a correr el diagnóstico, decidir con Diego
  qué reserva se queda y repetir.
- **Rollback**: `sql/2026-11-20-estabilidad-rollback.sql`.

## 6. Nómina y grupo — `sql/2026-11-20-nomina-y-grupo.sql`

Estados de la nómina (pendiente → en revisión → validada → pagada, y
anulada con motivo), quién y cuándo cambió el estado, y el resumen del
grupo de antros.

- **Verificar**:
  ```sql
  select proname from pg_proc where proname in
    ('nomina_semana', 'nomina_semana_mia', 'nomina_marcar_pagada', 'nomina_cambiar_estado', 'grupo_resumen');  -- 5
  ```
- **Rollback**: `sql/2026-11-20-nomina-y-grupo-rollback.sql`.

## 7. Panel del RP y permisos de caja

Pegar en dos pestañas, una después de otra:
- `sql/2026-11-21-rp-panel.sql`:
  - `rp_mis_reservas`, que devuelve solo las reservas del RP que llama;
  - `rp_progreso_cuota`;
  - `rp_nivel_visibilidad`;
  - dos políticas restrictivas: un RP dado de baja no lee reservas ni
    comisiones, aunque conserve una sesión abierta.
- `sql/2026-11-21-caja-permisos.sql`: `caja_mis_permisos` (los 8 permisos
  de caja en una sola llamada).

Los dos son idempotentes.

- **Verificar**:
  ```sql
  select proname from pg_proc where proname in
    ('rp_mis_reservas', 'rp_progreso_cuota', 'rp_nivel_visibilidad', 'soy_rp_dado_de_baja', 'caja_mis_permisos');  -- 5
  select policyname from pg_policies where policyname like '%rp_dado_de_baja';  -- 2
  ```
- **Rollback**: primero `drop function if exists public.caja_mis_permisos(uuid);`
  y después `sql/2026-11-21-rp-panel-rollback.sql`.

## 8. Merge a `master` (publica el código)

```bash
git checkout master
git pull
git merge --no-ff desarrollo -m "Pase a producción: caja por mesa, panel RP, nómina, estabilidad"
git push origin master
git checkout desarrollo
```

- Vercel publica solo (auto-deploy desde `master`). Revisar:
  ```bash
  npx vercel ls --scope antroapp      # el primero: Production, ● Ready
  ```
- Variables de Production: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` ya existen
  (revisado el 19/11/2026, solo nombres). El código nuevo no pide otras.
- **Si el deploy falla o la app se ve mal**: en Vercel, Deployments → el
  deploy de producción anterior → **Instant Rollback**. El SQL de los pasos
  3–7 es compatible hacia atrás, salvo la nota del paso 5 (comisiones del
  código viejo).
- **No** usar `npx vercel --prod` salvo emergencia.

## 9. Candado de puerta — `sql/2026-11-20-caja-candado-puerta.sql`

**Solo después de que el paso 8 esté Ready.** Bloquea marcar una reserva
como `usada` sin pasar por la puerta nueva. Si se aplica antes, rompe el
botón "Confirmar entrada" del código viejo.

- **Verificar**: `select tgname from pg_trigger where tgname like '%candado_puerta%';`
- **Rollback**: `sql/2026-11-20-caja-candado-puerta-rollback.sql`.

## 10. Recorrido de los 6 roles en producción

Con las cuentas reales de Club Demo (credenciales en
`backups/2026-11-12-club-demo-credenciales.json`) a 390 px en el teléfono:

| Rol | Cuenta | Qué revisar |
|---|---|---|
| Sin sesión | — | `/`, `/cliente`, ficha de Club Demo, reservar sin cuenta, boleto `/r/<código>` |
| Cliente | una cuenta de cliente de Diego | Reservar; una segunda reserva el mismo día en el mismo antro debe dar "Ya tienes una reserva…" |
| RP | `demo_mariana` | `/rp/panel`: Reservas con estados (Consumió / Llegó, sin consumo / No llegó / Por llegar), detalle, Escribirle, tarjeta de cuota, Nómina |
| Staff | personal de Club Demo | `/staff/panel` puerta; `/staff/caja`: abrir mesa, agregar consumo, cobrar, cerrar. **No** puede cuadrar si no tiene el permiso. `/staff/nomina` dice "Solo el gerente ve la nómina" |
| Gerente | `lolo.demo@example.com` | `/staff/caja` completo incluido cuadrar; `/staff/nomina` |
| Dueño | diegogv | `/dueno/panel`, `/dueno/nomina`, `/grupo` |
| Admin | admin | `/admin`: dashboard, verificaciones, alertas |

Además, en el SQL Editor:
`select count(*) from public.app_errores where creado_en > now() - interval '1 hour';`
(los errores de pantalla que la app reportó durante el recorrido).

## 11. Datos demo para la junta del miércoles 25/11

**El 25/11 después de las 08:00** (hora de la Ciudad de México): antes de
esa hora la noche operativa todavía es la del 24 y la caja de la noche
objetivo no queda "en curso".

```bash
node scripts/demo-datos.mjs --fecha=2026-11-25         # simulación: revisar el resumen
node scripts/demo-datos.mjs --fecha=2026-11-25 --si    # escribe
```

- Borra solo lo demo de Club Demo:
  - reservas con teléfono `0000000…` y sin cliente;
  - turnos, asistencias y comisiones de las cuentas `demo_*`.
- **Nunca borra cuentas.** Es irreversible para esos datos demo; el
  respaldo del paso 1 los conserva.
- Con la caja ya en producción, arma mesas abiertas, cerradas y cuadradas,
  mesas con 2 y 3 grupos y comisiones nacidas al cuadrar.
- Si responde "Hay N cuentas de caja de una demo anterior", correr
  `sql/limpiar-demo-caja.sql` en el SQL Editor (solo toca Club Demo) y
  repetir. En producción la caja no se borra por la API.

## Problemas comunes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Login responde "No pudimos iniciar sesión" (500) | Falta `login_intentos` (paso 5) | Aplicar el paso 5 |
| `/staff/caja` dice "No se pudo cargar la caja" | Falta el paso 4 o 7, o el usuario no es staff/gerente de ese antro | Revisar las verificaciones del paso 4 y 7; revisar el rol en `profiles` |
| "Confirmar entrada" falla con "El check-in solo se registra con…" o "La puerta solo se registra con las funciones de puerta" | El paso 9 se aplicó antes del código nuevo | Rollback del paso 9 y reaplicarlo cuando el paso 8 esté Ready |
| `permission denied for table …` | GRANT faltante | Comparar con dev: `extraer-esquema --origen=dev` y `--origen=prod` |
| `duplicate key value violates unique constraint` en el paso 5 | Duplicados nuevos | Ver paso 5 |
| El RP no ve sus reservas | `rp_mis_reservas` falta (paso 7), o el RP está dado de baja | Verificación del paso 7; `profiles.activo` |
| Un dueño ve "Antro no encontrado" | Tiene dos antros (diagnóstico d) | Deuda conocida: dejarle uno |

## Pruebas en dev (antes del pase)

```bash
node scripts/dev/probar-caja.mjs                               # 167/167
node scripts/probar-clubs-visibilidad.mjs --env=.env.dev       # 68/68
node scripts/dev/probar-login.mjs                              # 15/15 (con servidor-dev)
PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-rp-panel.mjs    # 40/40
PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/recorrido-roles.mjs    # 32/32
npx tsc --noEmit && npx eslint . && npx next build
```
