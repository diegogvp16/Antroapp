# Carril b-alta — Etapa 1: reglas de comisión y RPs en el alta de antro (B5)

24/11/2026. Rama `b-alta` (worktree `AntroApp-wt/b-alta`, desde `post-junta-2`).
Solo **antroapp-dev**. Producción: nada (ni lectura ni escritura).

> **Sin commits.** El clasificador de permisos bloqueó `git commit`, y
> CLAUDE.md dice «nada de `git commit` sin que Diego lo pida». Todo quedó en
> el working tree de `b-alta` para revisión (lista de archivos al final).

## Qué se hizo

### El problema
El asistente `/admin/alta-antro` (6 pasos, `admin_alta_club`) creaba el antro
**sin regla nueva**. Calculaba la comisión con las columnas viejas de `clubs`
(`comision_tipo = fijo`, `comision_monto = 0`): **$0 por reserva** hasta que el
dueño o el gerente la configuraran. Qué ven los RPs y los permisos de caja
quedaban en los valores de la plataforma, sin que nadie los eligiera.

### Ahora: paso 4 de 7, «Reglas de comisión y RPs»
Va entre «Mesas» y «Equipo» (`components/admin/alta/paso-reglas.tsx`):

1. **Cómo se paga a los RPs**: «Por reserva que consume» o «Por día trabajado»
   (`clubs.pago_rp_modo`).
2. **Por reserva**: regla del antro con el modelo del bloque 8
   (`reglas_comision`). Tres tipos: porcentaje del consumo, monto fijo por
   reserva que consume, o cuota («las primeras N de la semana no pagan; desde
   la N+1, $X»). Abajo, una vista previa con el texto de `describirRegla`.
   **Es obligatoria**: sin regla no se puede seguir.
3. **Por día**: tarifas del día 1 al 7 (`club_dia_tarifas`); al menos la del
   día 1. Si un RP trabaja más días, se repite la última (como ya hace
   `registrar_pago_dia`).
4. **Qué ven los RPs** (`club_config_rp`): solo estado · estado y monto ·
   estado, monto y botellas.
5. **Permisos de caja (opcional)**: casilla «Cambiar los permisos de la
   plataforma». Si se marca, aparece la matriz de 9 permisos × {staff,
   gerente}, ya con los valores de la plataforma. Solo se guardan las casillas
   que **cambian** (el antro sigue los de la plataforma en lo que no tocó).
   Botón «Volver a los de la plataforma».

El **resumen** muestra la regla, qué ven los RPs y los permisos cambiados.
La **ruta** (`/api/admin/alta-club`) valida con zod (`esquemaRp`,
`esquemaPermisosCaja` en `lib/domain/alta-club.ts`; mismos rangos y mensajes
que `validarRegla` del editor del dueño). Si la base responde sin la llave
`rp` (SQL viejo), el antro se crea igual pero la pantalla final avisa que las
reglas **no** se guardaron.

### En la base (misma transacción del alta)
`sql/post-junta-2/10-alta-club-reglas.sql` redefine `admin_alta_club(jsonb)`:

- Acepta `p.rp = { modo_pago, regla, visibilidad, tarifas_dia: [{posicion,
  monto_centavos}] }` y `p.caja_permisos = [{permiso, rol, permitido}]`.
- **Vuelve a validar todo** antes de insertar el antro, con
  `coalesce(…, false)`, sin casts que truenen (regex antes del cast,
  `case` en vez de `and`). Los errores salen como P0001. Mismos rangos que
  `config_rp_cambiar_regla`: porcentaje de 1 a 10000 bp, monto de 1 a
  10,000,000 centavos, cuota de 1 a 100, tarifas de $0 a $100,000 en los
  días 1–7 sin repetir, permisos solo de la lista del check y solo para
  `staff` o `gerente`, `permitido` booleano, máximo 18.
- Inserta `reglas_comision` con `vigente_desde = lunes de la semana del alta`
  (noche operativa del antro), `club_config_rp`, `club_dia_tarifas` y
  `caja_permisos` por rol. Quién lo hizo sale de `auth.uid()`, nunca del
  cuerpo.
- Bitácora `config_rp_cambios`: siempre la regla (con `alta: true`); la
  visibilidad solo si cambia la de la plataforma. `club_altas.resumen` también
  guarda las reglas.
- **Compatibilidad**: sin `p.rp` hace exactamente lo de antes, así que el
  código viejo sigue funcionando entre el SQL y el merge. Responde
  `"rp": null`.
- `security definer`, `search_path = ''`, mismos GRANT (sin `anon` ni
  `public`). Adentro sigue exigiendo admin.

## SQL, en orden

| # | Archivo | Rollback |
|---|---|---|
| 10 | `sql/post-junta-2/10-alta-club-reglas.sql` | `sql/post-junta-2/10-alta-club-reglas-rollback.sql` |

- **Requiere**: `sql/post-junta/01-alta-club.sql` y `07-config-rp.sql` (pase 2).
- **Rollback**: copia byte a byte de la función del 01. Probado en dev:
  después del rollback, `pg_get_functiondef` tiene el mismo md5 que antes del
  cambio (`44c32ea1…`) y el mismo ACL. Luego se volvió a aplicar el 10 y quedó
  idéntico al archivo. **Dev queda CON el 10 aplicado.**
- El rollback no borra configuraciones de antros ya dados de alta.
- **Orden en el pase**: el SQL **antes** del código. Con código nuevo y SQL
  viejo, el antro se crea sin reglas y la pantalla lo avisa. Con SQL nuevo y
  código viejo, todo funciona como hoy.

## Pruebas automáticas (resultados reales en dev)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-alta-club-dominio.mjs` (sin base) | **75/75** (antes 47; +28 de reglas, tarifas, permisos y coincidencia con `validarRegla`) |
| `node scripts/dev/probar-alta-club.mjs --base=http://localhost:3021` (regresión del alta; ahora con prefijo `t_alta_`) | **54/54**, limpieza sin restos |
| `node scripts/dev/probar-alta-reglas.mjs --base=http://localhost:3021` (nueva, de punta a punta) | **77/77**, limpieza: 4 antros y 6 cuentas borrados |
| `PLAYWRIGHT_DESDE=… node scripts/dev/capturas-alta-reglas.mjs http://localhost:3021` (pantallas y alta por la interfaz) | **28/28**, 1 antro borrado |
| `npx tsc --noEmit`, `npx eslint` (archivos tocados) | sin errores |
| `NEXT_DIST_DIR=.next-build next build` con `.env.dev` | compila (`/admin/alta-antro` 37.1 kB) |

Qué cubre `probar-alta-reglas.mjs`:
- **Cuota, por la ruta**: queda la regla de cuota (la 1.ª no paga, desde la
  2.ª $200), vigente desde el lunes de esta semana, creada por el admin.
  Visibilidad, 3 permisos por rol y bitácora en su lugar. El gerente la ve
  vigente en `config_rp_actual` (no programada) y el staff no la ve.
- **Permisos de verdad**: `caja_mis_permisos` del staff sale sin cobrar y con
  anular; el gerente, sin cerrar la noche. En una mesa abierta, la base no
  deja cobrar al staff.
- **Camino real de la caja** (abrir, sentar, consumo, pago, cerrar, cuadrar):
  1.ª reserva $0 y 2.ª $200, con `regla_id` del alta (las columnas viejas
  darían $0). El panel del RP ve su cuota y las botellas.
- **Por día**: tarifas $300/$300/$500, sin regla. Una asistencia genera $300
  con `registrar_pago_dia`.
- **La ruta rechaza** sin `rp`, reserva sin regla, porcentaje 0 y permiso para
  RP, sin crear cuentas ni antro.
- **La base rechaza, llamada directo como admin**, 35 cargas malas (26 de
  regla, tarifa o modo y 9 de permisos) con P0001 y su mensaje, sin dejar
  antro. Una alta válida directa funciona. La misma clave dos veces da un solo
  antro y una sola regla. Sin `p.rp`, se comporta como antes.
- **Nadie fuera del admin**: `dev_gerente`, `dev_dueno`, una cuenta de Auth
  sin perfil y el anónimo son rechazados.

Capturas en `screenshots-b-alta/` (ignorada por git): paso al entrar, con
error, cuota con permisos y por día, a 390 y 360 px; resumen y resultado a
390. Las revisé: sin desborde, ningún control de menos de 40 px y sin
errores en consola.

### Nota sobre el servidor local
`node scripts/dev/servidor-dev.mjs` **no arranca en este worktree**. Su
`node_modules` es un enlace a `AntroApp/node_modules` y Turbopack lo rechaza
(«Symlink node_modules is invalid, it points out of the filesystem root»).
Usé el mismo servidor **sin Turbopack** (`next dev -p 3021` con las tres
llaves de `.env.dev`), desde un script en el scratchpad. En el repo principal,
`servidor-dev.mjs` debería funcionar igual que siempre.

## Prueba manual, clic a clic

Usuario: `dev_admin@example.com` (contraseña en
`backups/dev-credenciales.json`). Servidor local contra dev o la vista previa
de la rama.

1. `/admin/login` → entra → tarjeta «Dar de alta un antro» → «Empezar el alta».
2. **Datos**: nombre «T alta Manual», dirección, ciudad y horario → Siguiente.
3. **Cover y políticas** → Siguiente. **Mesas** → «Agregar 20 mesas» → Siguiente.
4. **Reglas de comisión y RPs** (paso 4 de 7):
   - Deja el monto vacío y pulsa Siguiente: debe decir «Escribe un monto entre
     $0.01 y $100,000.» y no avanzar.
   - Elige «Con cuota…», N = 3 y pago 200: la caja gris dice «Las primeras 3
     reservas de la semana no pagan; desde la 4.ª, $200 cada una».
   - Marca «Estado, monto y botellas».
   - Marca «Cambiar los permisos de la plataforma» y quita «Staff: Cobrar»:
     abajo dice «1 cambio respecto de la plataforma». Prueba «Volver a los de
     la plataforma».
   - Cambia a «Por día trabajado»: aparecen «Día 1», «Agregar el día 2» (hasta
     el 7) y el bote de basura solo en el último día.
5. Regresa a «Por reserva», Siguiente → **Equipo**: agrega un gerente y un
   RP con correos `t_alta_…@example.com` → Siguiente → **Grupo**:
   independiente → **Resumen**: revisa la sección «Reglas de comisión y RPs» y
   su botón «Editar».
6. «Dar de alta en borrador» → guarda las contraseñas temporales.
7. Entra con el gerente nuevo (te pide cambiar la contraseña) → `/staff/panel`
   → «Reglas de pago a RPs»: «Esta semana» muestra la regla de cuota (no
   «$0»).
8. Limpieza: borrar el antro y las cuentas de prueba (o correr la limpieza
   del script con su sufijo).

## Decisiones pendientes para Diego

1. **Regla obligatoria en «por reserva»**: no hay opción «lo configura el
   dueño después», porque eso era justo lo que hacía nacer el antro en $0.
   ¿Te late, o prefieres una regla de plataforma por defecto (por ejemplo,
   $X fijo)?
2. **La regla vale desde el lunes de la semana del alta**, no desde el lunes
   siguiente. Es la única excepción a «nunca retroactivo». Es segura porque el
   antro es nuevo y no tiene comisiones. Si das de alta un martes, las
   reservas del lunes y martes de ese antro (no hay) ya usarían la regla.
3. **Modo «por día» sin regla por reserva**: si después cambian a «por
   reserva», ese antro caería en las columnas viejas ($0) hasta que pongan
   regla. ¿Pedimos también la regla en modo día?
4. **Permisos de caja**: no hay pantalla para cambiarlos después del alta
   (nadie llama a `caja_configurar_permiso`; está en el inventario B12). Hoy lo
   del alta solo se cambia por SQL.
5. Las **columnas viejas** `clubs.comision_*` quedan en su valor por defecto
   (fijo $0). Ya no mandan para estos antros, pero el formulario de «sueldo
   individual por RP» las usa para prellenar. No las sincronicé a propósito,
   para no mezclar los dos modelos.

## Riesgos

- Redefine `admin_alta_club`: **B2 (clonar)** y **B3 (herencia del grupo)**
  también la tocan, según el inventario. Debe haber **una sola** versión
  nueva. La siguiente etapa debe partir de este archivo 10 (o de uno
  posterior que lo incluya), con rollback al 10 y no al 01.
- **Orden del pase**: si se publica el código antes del SQL, los antros nuevos
  nacen sin reglas (avisado en pantalla, no en silencio).
- `caja_permisos.club_id` **no** tiene `on delete cascade`. Para borrar un
  antro de prueba con permisos hay que borrar antes sus `caja_permisos` (los
  scripts ya lo hacen).
- Las pruebas que inician muchas sesiones chocan con el **límite de Supabase
  Auth**: la IP la comparten 6 agentes. `probar-alta-reglas.mjs` reintenta con
  espera. La primera corrida falló solo por eso (73 pasaron, 1 falló); la
  segunda dio 77/77.

## Archivos (working tree de `b-alta`, sin commit)

- Nuevos: `sql/post-junta-2/10-alta-club-reglas.sql`,
  `sql/post-junta-2/10-alta-club-reglas-rollback.sql`,
  `components/admin/alta/paso-reglas.tsx`, `scripts/dev/probar-alta-reglas.mjs`,
  `scripts/dev/capturas-alta-reglas.mjs`, este documento.
- Modificados: `lib/domain/alta-club.ts`, `components/admin/alta/estado.ts`,
  `components/admin/alta/paso-resumen.tsx`,
  `components/admin/alta/resultado-alta.tsx`, `app/admin/alta-antro/page.tsx`,
  `app/api/admin/alta-club/route.ts`, `scripts/dev/probar-alta-club-dominio.mjs`,
  `scripts/dev/probar-alta-club.mjs` (prefijo `t_alta_` y `rp` en el cuerpo).
