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
| 5. Puerta y equipo | ⏳ Siguiente |
| 4. CAPTCHA y antiabuso | Pendiente |
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

**Para producción (pase 2)**: aplicar `sql/post-junta/01-alta-club.sql`
**antes** de publicar el código (sin la función, el asistente responde «No se
pudo dar de alta el antro. No se guardó nada» y borra las cuentas que creó).
Rollback: `sql/post-junta/01-alta-club-rollback.sql` (no borra antros).
