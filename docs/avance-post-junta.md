# Avance del trabajo post-junta (rama `post-junta`)

Bitácora viva: se actualiza al terminar **cada** bloque. Si el trabajo se
detiene a la mitad, aquí queda exactamente qué está hecho, qué falta, cómo
probarlo y con qué usuario de dev.

- **Rama**: `post-junta`, creada el 24/11/2026 desde `candidato-pase`
  (`d7b2e7f`) porque el pase todavía **no** está en `master`
  (`master` = `dc61d91`).
- **Etiqueta**: `checkpoint-post-pase` en `d7b2e7f` (subida a GitHub).
- **Base**: solo antroapp-dev. A producción no se escribió nada.
- **SQL nuevo**: `sql/post-junta/NN-*.sql`, cada uno con su
  `NN-*-rollback.sql`, aplicado solo en dev.
- **Usuarios de dev**: `dev_<rol>@example.com` (admin, dueno, gerente,
  staff, rp, cliente…); contraseña en `backups/dev-credenciales.json`.
- **Servidor local contra dev**: `node scripts/dev/servidor-dev.mjs`
  (puerto 3001). Build sin pisarlo: `NEXT_DIST_DIR=.next-build npx next build`.

Orden pedido: 1 → 5 → 4 → 3 → 2 → 8 → 7 → 6 → 9 → 10.

| Bloque | Estado |
|---|---|
| 1. Alta de antro desde /admin | ✅ Hecho y probado en dev |
| 5. Puerta y equipo | ✅ Hecho y probado en dev |
| 4. CAPTCHA y antiabuso | ⏳ Siguiente |
| 3. Legales | Pendiente |
| 2. Mensualidad con Stripe (prueba) | Pendiente |
| 8. Qué ve el RP, por antro | Pendiente |
| 7. Fase 2 | Pendiente |
| 6. Monitoreo y operación | Pendiente |
| 9. Tema oscuro y pulido | Pendiente |
| 10. Cierre | Pendiente |

---

## Bloque 1 — Alta de un antro nuevo desde /admin ✅

**Qué quedó**

- `/admin` → tarjeta «Dar de alta un antro» → `/admin/alta-antro`
  (reemplaza el formulario corto anterior, que creaba el antro sin equipo).
- Asistente en 6 pasos: **Datos** (nombre, dirección, ciudad, zona horaria,
  horario) · **Cover y políticas** (cover informativo, depósito informativo,
  edad mínima ≥ 18, vestimenta, música, ambiente, hora límite de llegada) ·
  **Mesas** (generador «N mesas con prefijo y capacidad», más edición fila
  por fila) · **Equipo** (dueño opcional; gerentes, staff y RPs uno por uno o
  pegando una lista «Nombre, correo») · **Grupo** (independiente, grupo
  nuevo o grupo existente; dueño del grupo = el dueño del antro, una cuenta
  nueva o nadie más) · **Resumen** con «En borrador» / «Publicado».
- Validación con el mismo esquema (zod) en el navegador y en el servidor:
  `lib/domain/alta-club.ts`.
- `POST /api/admin/alta-club`: exige sesión de **admin** (rol leído de la
  base), valida, crea las cuentas de Auth con contraseña temporal generada en
  el servidor y llama a `admin_alta_club()` **con la sesión del admin**. Si
  una cuenta o la base fallan, borra las cuentas que había creado: **no queda
  nada a medias**.
- `sql/post-junta/01-alta-club.sql`: función `admin_alta_club(jsonb)`
  (`security definer`, `search_path` vacío; vuelve a exigir admin y toma
  quién lo creó de `auth.uid()`) que hace antro + mesas + perfiles + grupo +
  bitácora en **una transacción**; tabla `club_altas` (bitácora: quién, cuándo,
  publicado o no, conteos; sin correos ni contraseñas), con RLS: solo el
  admin la lee; nadie la escribe directo. GRANT explícitos.
- Las contraseñas temporales se muestran **una vez** al final (con «Copiar
  todo») y no se guardan en ningún lado.

**Decisiones tomadas (cámbialas si no te late)**

- Contraseñas temporales generadas por el servidor en vez de pedirlas una por
  una (con 130 RPs no es práctico). Cada quien la cambia con «¿Olvidaste tu
  contraseña?».
- El dueño del antro se liga por `clubs.dueno_id` (como `/dueno/signup`), con
  `profiles.club_id` nulo. Un dueño de grupo «cuenta nueva» es un perfil
  `dueno` sin antro propio que ve el grupo en `/grupo` (su `/dueno/panel`
  dice que no tiene antro: pendiente decidir si se le manda directo a
  `/grupo`).
- Las reglas de pago de RPs no van en el alta: el dueño/gerente las pone
  en su panel (bloque 8).

**Cómo probarlo**

```bash
node scripts/dev/probar-alta-club-dominio.mjs        # 44/44, sin base
node scripts/dev/servidor-dev.mjs                    # en otra terminal
node scripts/dev/probar-alta-club.mjs [--masivo]     # 48/48 (49/49 con --masivo)
```

A mano: entra como `dev_admin@example.com` a `/admin` → «Empezar el alta».

**Resultados (24/11/2026, dev)**

- Seguridad: sin sesión → 401; cliente, RP, staff, gerente y dueño → 403 en
  la ruta **y** rechazados por la función de la base; ninguno (ni el anónimo)
  lee `club_altas`.
- Alta en borrador con 5 cuentas en 1.1 s; alta masiva de 130 RPs en 9.1 s
  (la función de Vercel tiene 60 s).
- Transacción: correo ya existente → 400 «Ya existe una cuenta con el correo
  …», sin antro ni cuentas nuevas; falla a la mitad dentro de la base → no
  queda antro, mesas ni perfiles; zona horaria inválida → no queda nada.
- Capturas a 390 y 360 px en `screenshots-post-junta/alta/` (sin scroll
  horizontal ni errores de página).

**Revisión de seguridad (subagente, solo lectura)**: sin hallazgos críticos
ni altos. Arreglado después (commit `97868dd`):
- **Idempotencia**: la ruta genera `alta_id`; si la respuesta de la base se
  pierde, revisa si sí se guardó antes de borrar cuentas, y la misma clave
  dos veces no crea dos antros.
- La función solo liga cuentas **recién creadas por el alta**
  (`app_metadata.alta_club`, de menos de 30 min, sin borrar ni bloquear).
- Rangos de edad, depósito y textos también en la base.
- `club_altas` sobrevive si se borra el antro (`on delete set null`).
- Tope real de 400 cuentas contando dueños.
- Respuesta con `Cache-Control: no-store`.
- Errores al deshacer cuentas se registran (sin correos) y
  `scripts/limpiar-altas-huerfanas.mjs` lista o borra las huérfanas (dev por
  defecto; producción solo con `--produccion`).
- El dueño de grupo sin antro propio va directo a `/grupo`.

Queda abierto (decisión tuya, en el reporte): las contraseñas temporales no
expiran y las cuentas nacen confirmadas; un correo mal escrito del dueño
queda ligado al antro. Se mitiga en el bloque 4 con «cambiar contraseña en
el primer inicio».

**Para producción (pase 2)**: aplicar `sql/post-junta/01-alta-club.sql`
**antes** de publicar el código (sin la función, el asistente responde «No se
pudo dar de alta el antro. No se guardó nada» y borra las cuentas que creó).
Rollback: `sql/post-junta/01-alta-club-rollback.sql` (no borra antros).

---

## Bloque 5 — Puerta y equipo ✅

**a) Linterna en el escáner** (`components/boton-linterna.tsx`, en los dos
escáneres de `/staff/panel`): el botón «Prender linterna» aparece **solo** si
la cámara la soporta (Chrome en Android sí; Safari en iPhone no). Si falla al
prenderla, avisa y la cámara sigue leyendo. Prueba: `probar-escaner.mjs`
13/13 (con linterna simulada: aparece, pide `torch=true` y el QR se lee en
1.9 s con la linterna prendida; sin linterna: no aparece y lee igual).
Falta probarla en un celular real.

**b) Baja y reactivación de staff y gerentes** (`sql/post-junta/02-baja-personal.sql`):
- `current_role_name()` y `current_club_id()` devuelven nulo para un perfil
  con `activo = false`: **pierde todo al momento aunque tenga la sesión
  abierta** (todas las políticas pasan por ahí). Además la baja borra sus
  sesiones de Auth: su cookie vieja da 401 y no puede renovar el token.
- `personal_cambiar_estado(perfil, activo, motivo)`: motivo obligatorio y
  bitácora `personal_movimientos` (quién, cuándo, motivo). Admin y dueño:
  staff y gerentes; gerente: solo staff; nadie a sí mismo. El UPDATE directo
  de `activo` sobre staff o gerentes queda bloqueado (siempre con motivo). La
  baja de RPs **sigue igual que hoy**.
- El login (`/api/auth/login`) y `create-staff` rechazan staff y gerentes
  dados de baja (antes solo RPs); `/staff/*` y `/rp/panel` cierran la sesión
  y el login muestra «Tu cuenta ha sido desactivada».
- Pantallas: en `/dueno/panel` («Mi personal») y en `/staff/equipo` y
  `/dueno/equipo` («Equipo y actividad»), con confirmación y motivo.

**c) Registro de actividad** (`sql/post-junta/03-actividad.sql`,
`actividad_club`): quién cuadró, anuló, reabrió o cerró (mesa, monto, motivo,
hora) y las bajas de personal, por noche operativa; filtros «Anulaciones y
reaperturas», «Cuadres y cierres», «Personal». Solo gerente, dueño y admin.
El gerente entra con el botón «Equipo y actividad» de `/staff/panel`; el
dueño con «Ver actividad del antro».

**Cómo probarlo**

```bash
node scripts/dev/probar-baja-personal.mjs      # 39/39 (con servidor-dev)
PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-escaner.mjs   # 13/13
```
A mano: `dev_gerente` → «Equipo y actividad»; `dev_dueno` → «Mi personal».

**Regresión** tras cambiar `current_role_name()`: visibilidad 68/68, caja
167/167, dashboards 28/28, concurrencia 29/29, login 15/15 (dos chequeos
ajustados: el RP dado de baja ahora recibe «Solo para RPs» en vez de «Tu
cuenta está desactivada»; sigue rechazado y el panel lo saca con el aviso).

**Para producción (pase 2)**: 02 y 03 **antes** del código (sin 02, las
pantallas de equipo fallan con «No se pudo guardar»). Rollback en orden
inverso: `03-actividad-rollback.sql`, `02-baja-personal-rollback.sql`
(regresa los ayudantes y el trigger; no reactiva a nadie).
