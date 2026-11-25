# Carril b-alta — reglas en el alta (B5), clonar antro (B2) y configuración por grupo (B3)

24–25/11/2026. Rama `b-alta` (worktree `AntroApp-wt/b-alta`, desde `post-junta-2`).
Solo **antroapp-dev**. Producción: nada (ni lectura ni escritura).

> **Commits**: los hace el coordinador (a los subagentes el sistema de
> permisos les bloquea `git commit`). La etapa 1 y un avance parcial de la 2
> están en `21106f8`; el cierre de la etapa 2 queda en el working tree.

- Etapa 1 (B5): abajo, «Etapa 1».
- Etapa 2 (B2, clonar antro): sección «Etapa 2» más abajo.
- Etapa 3 (B3, configuración por grupo): sección «Etapa 3», al final.

# Etapa 1 — reglas de comisión y RPs en el alta de antro (B5)

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

---

# Etapa 2 — Clonar antro (B2)

25/11/2026. La etapa se cortó por el límite de uso a las 23:40 del 24. El
avance parcial quedó en `21106f8`. Esta mañana:
- lo revisé contra el código;
- endurecí la prueba: ahora revisa todas las tablas con `club_id`, no una
  lista fija;
- probé el ciclo SQL → rollback → SQL;
- corrí todas las pruebas.

## Qué hace, por pieza

### /admin: botón «Clonar» por antro
En `app/admin/page.tsx` (`TarjetaAntro`), cada tarjeta, publicada o no, tiene
el botón «Clonar», de 40 px de alto. Abre `/admin/alta-antro?desde=<id>`. La
tarjeta de alta dice que, para partir de otro antro, se usa «Clonar».

### Asistente precargado
En `app/admin/alta-antro/page.tsx`, con `?desde=`, la pantalla dice «Leyendo
la configuración del antro de origen…» mientras lee la plantilla. Si la
lectura falla, muestra el aviso y dos botones: «Intentar de nuevo» y «Hacer un
alta en blanco». Si sale bien, el asistente arranca en el paso 1 así:

- **Lo que se precarga**:
  - datos: ciudad, zona horaria y horario;
  - políticas: cover, depósito, edad, vestimenta, música, ambiente y hora
    límite de llegada;
  - mesas: nombre y capacidad, sin repetidas, hasta 300;
  - pago a RPs: el modo de pago y la regla de comisión **que vale hoy** (la
    nueva, o la anterior traducida);
  - qué ven los RPs, las tarifas por día y los permisos de caja **por rol**;
  - el grupo del origen, como «grupo existente» y sin tocar a su dueño.
- **Lo que queda vacío**: nombre, dirección y equipo (dueño, gerentes, staff
  y RPs).
- **Avisos** (`components/admin/alta/aviso-clon.tsx`, arriba del paso 1).
  Salen cuando hay:
  - una regla programada a futuro, que no se copia;
  - una regla anterior o incompleta (por ejemplo, $0);
  - permisos por persona, que no pasan al antro nuevo;
  - tarifas por día en un origen que paga por reserva (solo cuentan en modo
    día);
  - una zona horaria fuera de la lista;
  - más de 300 mesas.

  También está el botón «Mejor hacer un alta en blanco».
- El admin revisa y cambia todo paso a paso, como en un alta normal: el
  asistente **es** la vista previa.
- **Resumen**: la sección «Clon» dice de qué antro sale y cuántos productos se
  copian (con existencias en 0). Trae la lista de lo que **no** se copia
  (`NO_SE_COPIA_CLON` en `lib/domain/alta-club.ts`).

La plantilla se convierte en el asistente en dos piezas de
`lib/domain/alta-club.ts`:
- `esquemaPlantilla`, en zod, es tolerante: lo raro se ignora con un aviso y
  nunca truena;
- `precargaDesdePlantilla` arma lo que precarga el asistente.

Lo usa `borradorDesdeClon`, en `components/admin/alta/estado.ts`.

### Ruta `/api/admin/alta-club`
Acepta `clonar_de` (uuid o null, validado con zod). Si viene, revisa que el
antro exista **antes** de crear cuentas de Auth. Si la base no responde la
llave `clon` (SQL 11 sin aplicar), el antro se crea, pero la pantalla final
avisa que el catálogo no se copió.

### Base: `sql/post-junta-2/11-clonar-club.sql`
1. **`admin_club_plantilla(p_club uuid)`**, de solo lectura.
   - `security definer` con `search_path = ''`. Exige `coalesce(auth.uid() is
     not null and current_role_name() = 'admin', false)`.
   - Devuelve **solo configuración**, con columnas explícitas (nunca
     `to_jsonb` de la fila).
   - No trae nombres de personas, dirección, dueño, ubicación, verificación,
     suscripción, bono ni las columnas viejas `comision_*`.
   - Productos sin `id` ni existencias, y solo si existe la tabla de fase 2.
   - Los permisos por persona solo se **cuentan**.
   - Permisos de ejecución: `revoke` a `public` y `anon`; `grant` a
     `authenticated` y `service_role`.
2. **`admin_alta_club(p)`**: es la del 10 **más** `p.clonar_de`.
   - Valida el uuid con regex antes del cast. Si no sirve, da P0001 «El
     antro de origen no existe.».
   - En la **misma transacción** del alta copia el catálogo. Lo lee **del
     origen en la base, no del cuerpo**: `productos` con `existencias = 0`,
     sin movimientos y con `creado_por = auth.uid()`.
   - Guarda `clon: {clonado_de, productos}` en `club_altas.resumen` y en la
     respuesta.
   - Lo demás (regla, tarifas, permisos, mesas y datos) viaja en el cuerpo
     como en cualquier alta. Lo valida zod y otra vez la base. El admin
     podría escribirlo a mano, así que no se le da ninguna confianza nueva.

### Lo que NO se copia (por diseño; la prueba lo verifica)
- **Operación**: reservas, consumos, caja (noches, sesiones, cuentas,
  consumos, pagos, cuadres y eventos), comisiones, pagos por día, turnos y
  asistencias.
- **Personas**: personal y cuentas, el dueño, los permisos de caja por
  persona y los overrides por RP (comisión y tarifa por día).
- **Archivos**: fotos (filas y archivos) y documentos de verificación.
- **Inventario**: existencias e historial.
- **Del antro**: ubicación, suscripción, estado de verificación (nace en
  borrador salvo que el admin publique), bono de plataforma y columnas viejas
  `comision_*`.
- **Historia**: reglas programadas a futuro, la bitácora de cambios y las
  altas del origen.
- **Otras tablas**: invitaciones, suscripciones, pagos de mensualidad,
  correos, movimientos de personal e intentos de reserva.

## SQL, en orden

| # | Archivo | Rollback |
|---|---|---|
| 10 | `sql/post-junta-2/10-alta-club-reglas.sql` | `sql/post-junta-2/10-alta-club-reglas-rollback.sql` |
| 11 | `sql/post-junta-2/11-clonar-club.sql` | `sql/post-junta-2/11-clonar-club-rollback.sql` |

- El 11 **requiere el 10**: su `admin_alta_club` es la del 10 más el clon.
- **Rollback del 11**: regresa `admin_alta_club` a la versión **exacta** del
  10 y borra `admin_club_plantilla`. Lo probé hoy en dev:
  - después del rollback, el cuerpo es idéntico al del archivo 10 (md5 de
    `pg_get_functiondef` `1ab3be32…`), con el mismo ACL, y
    `admin_club_plantilla` ya no existe;
  - al volver a aplicar el 11, el cuerpo es idéntico al del archivo (md5
    `9c56b000…`, el mismo de antes del ciclo), con el mismo ACL.

  **Dev queda CON el 10 y el 11.**
- Rollback en cadena: primero el del 11 y luego el del 10.
- El rollback no borra los antros ya clonados ni su catálogo.
- **Orden en el pase**: el SQL antes del código. Con el código nuevo y sin el
  11, «Clonar» muestra el error de lectura (no existe la plantilla) y ofrece
  el alta en blanco.

## Pruebas automáticas (resultados reales en dev, 25/11)

Servidor: `next dev -p 3021` **sin Turbopack**, con las llaves de dev (ver
«Nota sobre el servidor local»).

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-clonar-club.mjs --base=http://localhost:3021` | **107/107**; limpieza: 5 antros, 7 cuentas y 1 grupo, no quedó nada |
| `PLAYWRIGHT_DESDE=… node scripts/dev/capturas-clonar-club.mjs http://localhost:3021` | **53/53** (390 y 360 px); limpieza: 2 antros |
| Regresión: `probar-alta-club-dominio.mjs` | **75/75** |
| Regresión: `probar-alta-club.mjs` | **54/54**, sin restos |
| Regresión: `probar-alta-reglas.mjs` | **77/77**, 4 antros y 6 cuentas borrados |
| `npx tsc --noEmit`, `npx eslint` (archivos tocados) | sin errores |
| `NEXT_DIST_DIR=.next-build next build` con llaves de dev | compila (`/admin` 12.7 kB, `/admin/alta-antro` 40.6 kB); `tsconfig.json` sin cambios |

Qué cubre `probar-clonar-club.mjs`:
- **Dominio (sin base)**:
  - la plantilla se convierte en la precarga: textos, mesas sin repetir,
    regla de cuota, porcentaje 1250 bp ↔ «12.5», tarifas en orden, permisos
    de RP ignorados y avisos;
  - casos raros: regla anterior en $0, zona fuera de la lista, más de 300
    mesas y una plantilla rota, que se rechaza;
  - `clonar_de` en el esquema y en el payload.
- **Un origen con todo lo que no se debe copiar**:
  - personas: dueña, gerente, staff y RP;
  - operación: una noche de caja completa con su comisión, una asistencia, un
    pago por día y un turno fijo;
  - reglas: una regla programada a futuro, un override de comisión, uno de
    tarifa y un permiso de caja por persona;
  - además: foto, documento, lat/lng, grupo y 3 productos con existencias e
    historial.
- **Plantilla**:
  - solo trae las 11 columnas de configuración;
  - no trae teléfonos, correos, dirección, fotos, ubicación ni personas;
  - trae la regla que vale hoy; la programada llega solo como aviso;
  - los productos vienen sin `id` ni existencias;
  - la de Club Demo Dev se lee (solo lectura).
- **Clon por la ruta**:
  - datos y políticas iguales a los del origen; nombre y dirección nuevos;
  - sin dueño ni ubicación; en borrador y sin suscripción;
  - columnas viejas `comision_*` en su valor por defecto;
  - las mismas mesas;
  - **una** sola regla (la de hoy), vigente desde este lunes y creada por el
    admin;
  - la misma visibilidad;
  - permisos por rol, ninguno por persona;
  - el catálogo, con existencias en 0.
- **Nada más se copió**:
  - 0 filas del clon en 18 tablas nombradas (reservas, consumos, caja,
    comisiones, pagos por día, turnos, asistencias, fotos, documentos,
    overrides y movimientos de inventario);
  - 0 filas en **toda otra tabla de `public` con `club_id`**, que la prueba
    descubre en el catálogo. Hoy son 6 más: `correos_salida`, `invitaciones`,
    `pagos_mensualidad`, `personal_movimientos`, `reserva_intentos` y
    `suscripciones`;
  - personal: solo las 2 cuentas nuevas.
- **El origen no cambió**: el md5 de cada fila de 35 tablas sale igual en
  cuatro momentos: antes del clon, después del clon, después de operar la caja
  del clon y al final.
- **La regla clonada manda**: en la caja del clon (abrir, sentar, consumo,
  pago, cerrar y cuadrar), la 1.ª y la 2.ª reserva dan $0 y la 3.ª $250, con
  el `regla_id` del clon.
- **Origen que paga por día**: las tarifas $300/$450/$600 se copian, sin regla
  por reserva.
- **Rechazos**:
  - por la ruta, un origen que no existe o mal escrito, sin crear cuentas;
  - por la base, un uuid que no existe, texto, una inyección y un número: los
    cuatro dan P0001, sin dejar antro;
  - la misma `alta_id` dos veces da un solo clon y un solo catálogo;
  - no leen la plantilla ni clonan: el gerente y el dueño de dev, la dueña y
    el gerente del origen, una cuenta sin perfil y el anónimo;
  - la ruta le da 403 al gerente.

Capturas en `screenshots-b-alta/` (ignorada por git), revisadas a 390 y 360
px:
- `/admin` con «Clonar»;
- paso 1 con el aviso del clon;
- políticas y reglas;
- resumen y resultado;
- el estado de error.

Ninguna tiene desborde ni controles de menos de 40 px, y la página no marcó
errores.

## Prueba manual, clic a clic

Usuario: `dev_admin@example.com` (contraseña en
`backups/dev-credenciales.json`). Servidor local contra dev o vista previa.

1. `/admin/login` → entra. En «Antros», cada tarjeta tiene «Clonar».
2. Pulsa «Clonar» en **Club Demo Dev**. Arriba debe decir «Clon de antro ·
   paso 1 de 7». Debajo sale la caja «Precargado con la configuración de Club
   Demo Dev…», con los avisos que apliquen y el botón «Mejor hacer un alta en
   blanco».
3. **Datos**: nombre y dirección vacíos; ciudad, zona y horario del origen.
   - Pulsa «Siguiente» sin nombre: debe decir «Escribe el nombre del
     antro.».
   - Escribe «T alta Manual clon» y una dirección → Siguiente.
4. **Cover y políticas**: los del origen → Siguiente.
5. **Mesas**: las del origen (puedes quitar o agregar) → Siguiente.
6. **Reglas**: la regla, qué ven los RPs y los permisos del origen. Si el
   aviso decía «regla anterior» o «no está completa», escribe la regla aquí.
7. **Equipo**: vacío. Agrega un gerente con correo `t_alta_…@example.com`.
8. **Grupo**: si el origen está en un grupo, viene «grupo existente» con ese
   grupo, sin dueño de grupo nuevo.
9. **Resumen**: revisa la sección «Clon» (sale de, catálogo, «No se copia»).
   Pulsa «Dar de alta en borrador» y guarda las contraseñas.
10. Revisa:
    - el antro nuevo aparece en «No publicados»;
    - Club Demo Dev no cambió: sus reservas, fotos y personal siguen igual;
    - el nuevo no tiene reservas, fotos ni personal del origen;
    - con el gerente nuevo, `/staff/panel` → «Reglas de pago a RPs» muestra
      la regla copiada.
11. Error: abre
    `/admin/alta-antro?desde=00000000-0000-4000-8000-000000000000`. Debe
    decir «El antro de origen no existe.», con «Intentar de nuevo» y «Hacer
    un alta en blanco». Este último abre el asistente vacío.
12. Limpieza: borrar el antro y la cuenta de prueba.

## Decisiones pendientes para Diego (B2)

1. **El mismo grupo por defecto**: el clon propone el grupo del origen. ¿Te
   late, o prefieres «independiente» por defecto?
2. **La regla de hoy, no la programada**: si el origen tiene un cambio de
   regla para el lunes siguiente, el clon copia la que vale hoy y avisa.
   ¿Copiamos también la programada?
3. ~~**Origen «por reserva» con tarifas por día guardadas**: las tarifas se
   precargan, pero solo se guardan si eliges «por día».~~ **Corregido tras
   la revisión** (ver «Correcciones de la revisión», al final): el clon
   guarda la regla Y las tarifas del origen, use el modo que use.
4. **Solo admin** en esta versión. Que un dueño de grupo clone sus antros es
   otra decisión: podría crear antros sin pasar por la verificación.
5. **Fotos**: no se copian, porque Storage necesita la API y además son fotos
   de otro lugar.

## Riesgos (B2)

- **Una sola versión de `admin_alta_club`**: el 11 parte del 10. Si **B3**
  (herencia del grupo) también la redefine, tiene que partir del 11, y su
  rollback, regresar al 11. Hoy, en dev, la función es la del 11.
- El **catálogo** depende de fase 2 (`public.productos`). Sin la tabla, el
  clon funciona igual y no copia catálogo (la plantilla manda `productos:
  null`).
- Las pruebas inician muchas sesiones, y el **límite de Supabase Auth** de la
  IP compartida puede cortar una corrida. `probar-clonar-club.mjs` reintenta
  con espera.
- `caja_permisos.club_id` no tiene `on delete cascade`: para borrar un clon
  de prueba hay que borrar antes sus permisos (los scripts ya lo hacen).

## Archivos de la etapa 2

- Nuevos:
  - `sql/post-junta-2/11-clonar-club.sql`
  - `sql/post-junta-2/11-clonar-club-rollback.sql`
  - `components/admin/alta/aviso-clon.tsx`
  - `scripts/dev/probar-clonar-club.mjs`
  - `scripts/dev/capturas-clonar-club.mjs`
- Modificados:
  - `app/admin/page.tsx`
  - `app/admin/alta-antro/page.tsx`
  - `app/api/admin/alta-club/route.ts`
  - `lib/domain/alta-club.ts`
  - `components/admin/alta/estado.ts`
  - `components/admin/alta/paso-resumen.tsx`
  - `components/admin/alta/resultado-alta.tsx`
  - este documento
- Cambios de hoy, sin commit:
  - `scripts/dev/probar-clonar-club.mjs` (la huella ahora cubre todas las
    tablas con `club_id`)
  - este documento

---

# Etapa 3 — Configuración por grupo (B3)

25/11/2026. Todo queda en el working tree, sin commit. No había avance
parcial de esta etapa: el último commit de la rama (`21106f8`) es el de B5
y B2.

## La idea, en corto

Un grupo define **valores por defecto**. Cada antro del grupo los **hereda**
mientras no los **sobrescriba**. En cada antro se puede «volver al del
grupo» o «usar uno propio». Lo del grupo lo editan **solo** el dueño del
grupo y el admin. Todo deja bitácora. Al dar de alta o clonar un antro
dentro del grupo, la base le aplica los valores del grupo.

Claves (6):

| Clave | Qué es | Cuándo vale un cambio del grupo |
|---|---|---|
| `regla_comision` | regla de comisión por reserva | **desde el lunes siguiente** de cada antro (en su zona horaria); esta semana no cambia |
| `visibilidad_rp` | qué ve el RP de sus clientes | al momento |
| `modo_pago` | por reserva o por día (con tarifas por día) | al momento, como hoy cuando lo cambia el dueño: **excepción explícita** a «desde el lunes», la pantalla pide confirmarla. **Decisión pendiente** |
| `caja_permisos` | permisos de caja **por rol** (staff y gerente) | al momento |
| `cover` | cover informativo | al momento |
| `tolerancia` | hora límite de llegada | al momento |

## Cómo funciona (modelo «empujar»)

El valor **efectivo** de cada antro sigue viviendo en sus tablas de siempre:
`reglas_comision`, `club_config_rp`, `clubs.pago_rp_modo`, `club_dia_tarifas`,
`caja_permisos`, `clubs.cover_*` y `clubs.tolerancia_hora`. El grupo solo
escribe ahí. Por eso:

- El cálculo de comisiones sigue leyendo de **un solo punto en la base**:
  `regla_comision_vigente`. Igual con lo que ve el RP
  (`rp_nivel_visibilidad`) y con los permisos (`caja_tiene_permiso`). No
  toqué ninguna de esas funciones ni `caja_liquidar_cuenta`: el camino del
  dinero es el mismo (el md5 de esas funciones es idéntico antes y después).
- **Nada es retroactivo**. La regla del grupo entra como una regla nueva del
  antro desde su lunes siguiente. La que vale esta semana se cierra el
  domingo (no se borra) y las comisiones ya calculadas no se tocan.
- `club_config_efectiva(club)` es la **única** función que resuelve, para la
  pantalla, qué vale hoy en un antro y de dónde sale: del grupo o propio.

Por qué no «resolver al leer»: habría que redefinir `caja_liquidar_cuenta`,
`registrar_pago_dia` y `rp_progreso_cuota`, y guardar semana por semana si el
antro heredaba o no, para no ser retroactivo. Con «empujar», ese historial
ya es el de `reglas_comision`.

**Herencia.** Un antro sigue al grupo en una clave mientras **no** tenga una
fila en `club_config_propia` para esa clave.

- **Sobrescribir.** Cualquier cambio hecho **en el antro** lo vuelve
  «propio», sea por las funciones de siempre o por el UPDATE directo del
  dueño. Lo detectan triggers en:
  - `reglas_comision`;
  - `club_config_rp`;
  - `caja_permisos` (solo las casillas por rol);
  - `club_dia_tarifas`;
  - `clubs` (modo, cover y hora límite).

  No redefiní **ninguna** función de configuración existente. Lo que escribe
  el grupo lleva la marca local `antroapp.config_grupo` y no cuenta.
- **Volver al del grupo.** `club_config_heredar` borra la marca y aplica el
  valor del grupo; la regla, desde el lunes siguiente.
- **Usar uno propio** sin cambiar nada: `club_config_sobrescribir`.
- **Bloqueado.** El grupo puede bloquear una clave. Al guardarla bloqueada
  se aplica a **todos** sus antros, también a los que la tenían propia. Desde
  entonces un antro ya no la puede cambiar: el trigger responde P0001 «Esto
  lo define el grupo…». Solo el admin puede.

**Quién puede qué:**

- **Edita lo del grupo**: el admin, o el **dueño del grupo**. Para contar
  como dueño del grupo hace falta ser miembro `dueno_grupo` de ese grupo y
  tener un perfil **activo de dueño**. `current_role_name()` es nulo sin
  perfil, con el perfil dado de baja o con contraseña temporal, así que esas
  cuentas quedan fuera.
- **Decide de dónde sale cada valor en un antro**: el admin, el dueño del
  antro, el dueño de su grupo y el gerente. El gerente, **solo** en la regla
  y la visibilidad, que es lo que ya edita hoy.
- **Ve la configuración efectiva**: el admin, el dueño, el gerente y el
  dueño del grupo. El staff y el RP no.

Todas las condiciones van con `coalesce(…, false)`.

**Antros que ya estaban en un grupo** al aplicar el SQL, o que el admin
agregue a un grupo directo en la tabla, quedan como «propio» en las 6
claves: no cambia nada en silencio. En dev eso incluye el antro de Tijuana
del «Grupo Demo Dev», que **no** toqué.

**Alta y clon dentro de un grupo**:

- `admin_alta_club` ahora **envuelve** la versión del 11, renombrada
  `_admin_alta_club_base`. Su cuerpo es el mismo, pero ya no la puede
  ejecutar nadie con sesión.
- Con `grupo_config = 'heredar'` (por defecto), lo que el grupo define
  reemplaza lo del alta. La regla vale desde el lunes de la semana del alta
  (el antro es nuevo) y el antro sigue al grupo en todo.
- Con `'propio'`, el antro se queda con lo del alta y queda «propio», menos
  en lo que el grupo **bloqueó**.
- Si con lo del grupo el antro queda «por reserva» y sin regla, el alta se
  rechaza con un mensaje claro.
- `club_altas.resumen.grupo_config` guarda qué tomó del grupo.

**Bitácora.** `grupo_config_cambios` registra:

- cuando el grupo define o quita un valor: antes, después, si quedó
  bloqueado, desde cuándo y cuántos antros lo siguen;
- cuando un antro sobrescribe o vuelve a heredar;
- cuando un alta hereda o se queda con lo propio.

La regla y la visibilidad, además, quedan en `config_rp_cambios` de cada
antro con `grupo: true`, así que el historial del antro las muestra.

## Pantallas

- **`/grupo/configuracion`** (nueva). Es para el dueño del grupo y el admin.
  Se llega por el enlace «Configuración del grupo» de `/grupo`, que solo
  sale si la cuenta tiene grupos que configurar.
  - Un selector, si la cuenta tiene más de un grupo.
  - Una tarjeta por clave:
    - insignia «Definido por el grupo», «Sin definir» o «Bloqueado»;
    - el valor, quién lo cambió y cuándo;
    - «Cambiar» o «Definir para el grupo», con su editor, la casilla
      «Bloquear» y cuándo aplica;
    - el botón para guardar («Programar desde el lunes…» en la regla,
      «Guardar para el grupo» en lo demás) y «Dejar de definirlo».
  - «Antros del grupo», con «Del grupo» o «Propio» por clave y el botón
    «Volver al del grupo».
  - La bitácora.
  - Estados de cargando, de error (con «Reintentar») y de vacío.
- **En la configuración de cada antro.** Está en `ReglasPagoRP`, dentro de
  `/dueno/panel` y del `/staff/panel` del gerente.
  - Una tarjeta «Configuración del grupo «X»» que, por clave, dice «Del
    grupo», «Propio» o «Bloqueado por el grupo».
  - Muestra el valor de hoy y el del grupo. Si la regla del grupo empieza el
    lunes, lo dice: «Desde el lunes: …».
  - Botones «Volver al del grupo» y «Usar uno propio», según quién pueda.
  - Solo aparece si el antro está en un grupo.
  - Al guardar el modo de pago o la visibilidad, un error ahora muestra el
    aviso de la base (por ejemplo, «bloqueado»). Antes salía un texto
    genérico o el error tapaba la tarjeta.
- **Alta y clon** (`/admin/alta-antro`, paso «Grupo»). Con un grupo
  existente:
  - muestra lo que define el grupo;
  - deja elegir «Usar la del grupo (recomendado)» o «Usar lo de este alta»;
  - avisa que lo bloqueado se aplica igual.

  El resumen dice cuál se eligió.

## SQL, en orden

| # | Archivo | Rollback |
|---|---|---|
| 10 | `sql/post-junta-2/10-alta-club-reglas.sql` | `…/10-alta-club-reglas-rollback.sql` |
| 11 | `sql/post-junta-2/11-clonar-club.sql` | `…/11-clonar-club-rollback.sql` |
| 12 | `sql/post-junta-2/12-config-grupo.sql` | `sql/post-junta-2/12-config-grupo-rollback.sql` |

- **Requisitos.** El 12 necesita el 11, porque renombra su
  `admin_alta_club`. También necesita el 07 del pase 2 y el pase 1.
- **Qué crea:**
  - **Tablas:** `grupo_config`, `club_config_propia` y
    `grupo_config_cambios`. Tienen RLS y **ninguna** política: `revoke all`
    a `public`, `anon` y `authenticated`, y `grant all` solo a
    `service_role`. Nadie con sesión las lee ni las escribe directo.
  - **Ayudantes internos:** `es_dueno_de_grupo`, `grupo_puede_editar`,
    `_config_normalizar`, `_config_valor_club`, `_config_aplicar_club`,
    `_config_marcar_propia`, `_club_config_puede`, los 6 de los triggers y
    `_admin_alta_club_base`. Ninguno tiene EXECUTE para `anon` ni para
    `authenticated`; lo probé por rpc.
  - **Funciones públicas** (`authenticated`): `grupo_config_mis_grupos`,
    `grupo_config_actual`, `grupo_config_cambiar`, `grupo_config_quitar`,
    `club_config_heredar`, `club_config_sobrescribir` y
    `club_config_efectiva`. También `admin_alta_club`, la envoltura, que
    adentro exige admin.
  - **6 triggers**, y las marcas «propio» de los antros que ya estaban en un
    grupo.
- **Rollback:**
  - Quita la envoltura y le regresa a la función del 11 su nombre y su ACL.
    Luego borra triggers, funciones y tablas.
  - Lo que el grupo ya escribió en los antros se queda: son valores normales
    de cada antro.
  - Va **antes** del rollback del 11.
  - **Probado en dev:**
    - tras el rollback, `admin_alta_club` tiene el **mismo md5** que antes
      del 12 (`9c56b000…`) y el mismo ACL;
    - `config_rp_cambiar_*`, `caja_configurar_permiso`,
      `rp_nivel_visibilidad`, `regla_comision_vigente` y
      `caja_liquidar_cuenta` quedan idénticas;
    - no queda ninguna función, trigger ni tabla del 12.
  - Hice el ciclo dos veces: aplicar, probar, rollback y volver a aplicar.
    **Dev queda CON el 10, el 11 y el 12.**
- **Orden en el pase:** el SQL antes que el código.
  - Con el SQL nuevo y el código viejo, todo funciona como hoy: el alta
    manda sin `grupo_config` y hereda, pero ningún grupo tiene valores.
  - Con el código nuevo y sin el 12, no aparece el enlace a
    `/grupo/configuracion` ni la tarjeta del antro.
- **Deadlock.** Aplicar el 12 falló una vez por deadlock con otros agentes
  en dev: crear los triggers bloquea `clubs`. Al reintentar, pasó. En
  producción, aplicarlo fuera de la noche.

## Pruebas automáticas (resultados reales en dev, 25/11)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-config-grupo.mjs` (nueva; solo base, con sesiones reales) | **105/105**. Limpieza: 8 antros, 2 grupos y 9 cuentas; no quedó nada |
| `PLAYWRIGHT_DESDE=… node scripts/dev/capturas-config-grupo.mjs http://localhost:3021` (nueva; pantallas a 390 y 360) | **50/50**; no quedó nada |
| `probar-alta-club-dominio.mjs` | **79/79** (4 nuevas, de `grupo_config`) |
| `probar-alta-club.mjs --base=…` | **54/54** |
| `probar-alta-reglas.mjs --base=…` | **77/77** |
| `probar-clonar-club.mjs --base=…` | **107/107**. Agregué `club_config_propia` y `grupo_config_cambios` a lo permitido: son bitácora del alta, no copia del origen |
| `probar-config-rp.mjs` | 27/28; la falla es de **otro carril** (abajo) |
| `probar-caja.mjs` | 166/167; la falla es de **otro carril** (abajo) |
| `npx tsc --noEmit`, `npx eslint` (archivos tocados) | sin errores |
| `NEXT_DIST_DIR=.next-build next build` con `.env.dev` | compila (`/grupo/configuracion` pesa 6.93 kB); `tsconfig.json` sin cambios |

Las dos fallas de regresión **no son de este carril**:

- **`probar-config-rp`**, caso «ve el renglón «Botella Tequila»». Lo cambia
  el `41-rp-visibilidad` de b-cliente, ya aplicado en dev: ya no da renglones
  de concepto libre, que ahora van a `otros_centavos`. La prueba todavía
  espera lo de antes.
- **`probar-caja`**, caso «dueño: INSERT de antro con RETURNING». La
  política de INSERT en `clubs` ahora exige `not dueno_tiene_club()` (viene
  del `62-clubs-dueno-valido` de c-rls), y la prueba inserta un segundo
  antro para un dueño que ya tiene uno. Mis triggers en `clubs` son BEFORE
  UPDATE: no tocan el INSERT.

**Qué cubre `probar-config-grupo.mjs`:**

- **Escenario:** G1 con los antros A y B, G2 con C, y D fuera de todo grupo.
- **Rechazos:**
  - el gerente, el staff y el RP de A, el dueño de A (que no es dueño del
    grupo), el dueño de G2, una cuenta sin perfil, un dueño de G1 con
    contraseña temporal y el anónimo no cambian ni ven lo de G1;
  - los ayudantes internos no se pueden llamar por rpc; la base del alta, ni
    siquiera el admin;
  - nadie lee ni escribe las tablas directo.
- **Regla:**
  - antes del cambio, un cuadre real por la caja paga $100;
  - el dueño de G1 define $250: A y B la tienen desde el lunes siguiente;
    esta semana sigue $100 (la vieja se cierra el domingo); C y D no cambian;
  - otro cuadre de esta semana, después del cambio, sigue en $100 y guarda
    el id de la regla vieja;
  - las comisiones ya calculadas no cambian y quedan en la bitácora del
    antro;
  - repetir el mismo valor no cambia nada;
  - «llegado el lunes» (simulado), la caja calcula $250 con el id de la
    regla del grupo.
- **Visibilidad:**
  - llega al momento;
  - el gerente de A la cambia y A queda «propio»; el siguiente cambio del
    grupo llega a B y no a A;
  - el staff, el dueño de G2 y la cuenta sin perfil no pueden «volver al del
    grupo»; el gerente sí;
  - el gerente no decide de dónde salen los permisos de caja.
- **Permisos de caja:**
  - el staff de A deja de cobrar y puede anular;
  - su casilla **por persona** sigue ganando y no se toca;
  - la casilla vieja del rol vuelve a la de la plataforma;
  - el staff de C no cambia.
- **Modo de pago:**
  - por día, con $300 y $400 en B; por día sin tarifas se rechaza;
  - D no cambia;
  - el UPDATE directo del dueño de A deja a A «propio».
- **Cover bloqueado:**
  - se aplica también a A, que lo tenía propio;
  - el dueño de A ya no lo puede cambiar («lo define el grupo») ni marcarlo
    propio; el admin sí;
  - un cover de $0 se rechaza.
- **Hora límite:**
  - llega a B; una hora inválida se rechaza;
  - el gerente no la puede quitar;
  - al quitarla del grupo, B se queda con su 01:30;
  - el dueño de G2 no toca G1;
  - C, que entró al grupo por la tabla, queda «propio».
- **Pantallas (funciones de lectura):**
  - `grupo_config_actual` trae las claves, los bloqueos, el origen por
    antro y la bitácora con quién;
  - `club_config_efectiva` la ve el gerente, y no la ven el staff, el RP,
    el dueño de otro grupo, la cuenta sin perfil ni el anónimo. D sale «sin
    grupo».
- **Alta** (`admin_alta_club` directo, como admin):
  - en G1 con «heredar» toma los 5 valores del grupo, con la regla desde
    este lunes, una sola regla y sin marcas;
  - con «propio» se queda con lo suyo, menos el cover bloqueado;
  - un valor raro se rechaza sin crear el antro;
  - en G2 solo toma la hora;
  - sin grupo, todo como antes;
  - solo el admin puede.

**Qué cubre `capturas-config-grupo.mjs`.** Las capturas (`390-grupo-*.png` y
`360-grupo-*.png`) quedan en `screenshots-b-alta/`; las revisé.

- **Dueño del grupo:**
  - ve el enlace en `/grupo` y entra a `/grupo/configuracion`;
  - una regla sin monto da error y no se guarda;
  - al guardar «qué ven los RPs», el cambio llega a los 2 antros (revisado
    en la base);
  - define la hora límite;
  - «Volver al del grupo» en el cover propio de A funciona (revisado en la
    base y en la bitácora).
- **Gerente de A:**
  - ve la tarjeta con «Del grupo» y «Bloqueado por el grupo»;
  - no tiene botones en los permisos de caja;
  - «Usar uno propio» en la regla deja la marca.
- **Dueño de A:** ve la tarjeta, y los permisos bloqueados no tienen botón.
- **Admin:**
  - en el clon de A dentro del grupo, el paso «Grupo» muestra lo que define
    el grupo y el aviso de lo bloqueado, y el resumen lo repite;
  - el clon hecho por la interfaz nace con la regla de cuota y la
    visibilidad del grupo, sin marcas.
- **Revisión visual,** a 390 y 360: sin desborde, ningún control de menos de
  40 px y sin errores en la página. En los paneles grandes, la regla de los
  40 px se midió solo en la tarjeta nueva: el panel del dueño ya tenía tres
  selectores de archivo de 34 px (`verif-*`) que no son de este carril.

## Prueba manual, clic a clic

Servidor local contra dev o la vista previa de la rama. Contraseñas de dev
en `backups/dev-credenciales.json`. No escribas en el «Grupo Demo Dev»: lo
leen otros carriles.

1. **Preparar** con `dev_admin@example.com`:
   - Da de alta «T alta Grupo Manual». En el paso Grupo elige «Grupo nuevo»;
     dueño del grupo: «Una cuenta nueva», `t_alta_manual_dg@example.com`.
     Guarda la contraseña temporal.
   - Da de alta otro antro y, en el paso Grupo, elige «Agregar a un grupo
     existente» → el grupo nuevo.
2. Entra con `t_alta_manual_dg@example.com`, cambia la contraseña y en
   `/grupo` pulsa **«Configuración del grupo»**.
3. **Regla de comisión** → «Definir para el grupo» → «Monto fijo», $250 →
   «Programar desde el lunes …». Debe decir «Guardado. 2 antros lo siguen.
   Empieza el lunes …; esta semana no cambia.».
4. **Qué ven los RPs** → «Solo el estado» → «Guardar para el grupo».
5. **Permisos de caja por rol** → quita «Staff: Cobrar», marca «Bloquear» y
   guarda. La tarjeta dice «Bloqueado».
6. Abajo, en **«Antros del grupo»**, las 4 claves que definiste salen «Del
   grupo» en los dos antros.
7. Entra con el **gerente** de uno de los antros → `/staff/panel` → «Reglas
   de pago de RPs».
   - La tarjeta «Configuración del grupo «…»» dice «Del grupo»:
     - en la regla, con «Desde el lunes: $250…»;
     - en la visibilidad;
     - en los permisos, con «Bloqueado por el grupo» y sin botones.
   - En «Qué ven tus RPs» elige «Estado y monto» → Guardar. Arriba, la
     visibilidad pasa a «Propio», con «Volver al del grupo».
8. Con el dueño del grupo, cambia la visibilidad a «Estado, monto y
   botellas».
   - El antro del gerente **no** cambia (es propio); el otro sí.
   - En «Antros del grupo», el primero sale «Propio» con «Volver al del
     grupo». Púlsalo: toma «Estado, monto y botellas».
9. Con el dueño del antro (si tiene cuenta), intenta cambiar el modo de pago
   u otra cosa bloqueada. Debe responder «Esto lo define el grupo…».
10. «Cambios del grupo (N)»: aparecen la definición, «usa su propio valor»
    y «volvió al del grupo», con quién y cuándo.
11. **Alta en el grupo** (admin): «Clonar» uno de los antros.
    - En el paso «Grupo» aparecen los valores del grupo, con «Usar la del
      grupo» marcada.
    - Dalo de alta en borrador. Nace con la regla de $250 desde **este**
      lunes y con la visibilidad del grupo.
12. **Rechazos:**
    - un staff o un RP no ven la tarjeta;
    - un dueño que no es del grupo, en `/grupo/configuracion`, ve «Tu
      cuenta no administra ningún grupo».
13. **Limpieza:** borra los antros y las cuentas de prueba. Antes de borrar
    los antros hay que borrar sus filas de `grupo_clubs` y de
    `caja_permisos`, porque no tienen cascada.

## Decisiones pendientes para Diego

1. **Escritura para el dueño de grupo.** Hasta ahora solo leía
   (`docs/caja-por-mesa.md`). Ahora edita la configuración de **sus**
   antros, dinero incluido (regla y modo de pago). ¿Te late, o que solo lo
   haga el admin?
2. **Modo de pago del grupo, al momento (DECIDIR ANTES DEL PASE).** Así
   funciona hoy cuando lo cambia el dueño del antro, y lo ya calculado no
   cambia. Pero a media semana un RP puede quedar con comisiones de lunes a
   miércoles y pago por día desde el jueves, y ahora un solo cambio del
   grupo lo hace en **todos** sus antros a la vez. El revisor lo marcó
   (medio): contradice «vale desde el lunes siguiente, nada hacia atrás» de
   B3. Hoy queda como **excepción explícita**: la pantalla del grupo lo dice
   en ámbar y no deja guardar sin la casilla «Entiendo que cambia al momento
   en N antros». ¿Lo dejamos así o «desde el lunes», como la regla? Lo
   segundo es: guardar el modo y las tarifas del grupo como programados
   (vigencia en `grupo_config`) y aplicarlos en el primer cuadre o
   asistencia de la semana siguiente de cada antro; toca
   `caja_liquidar_cuenta` y `registrar_pago_dia`. No lo hice sin tu
   decisión.
3. **El gerente puede sobrescribir** la regla y la visibilidad del grupo
   (lo que ya edita hoy), salvo que el grupo bloquee la clave. ¿Bien, o el
   gerente nunca debería salirse de lo del grupo?
4. **Antros que ya estaban en un grupo**, y los que el admin agrega directo
   en la tabla, quedan «propio» en todo: el grupo no les cambia nada hasta
   que alguien pulse «Volver al del grupo». ¿O prefieres que al entrar tomen
   lo del grupo?
5. **Bloquear aplica a todos**, también a los antros que tenían su propio
   valor. ¿Te late?
6. **Tarifas por día.** Las del grupo van dentro de «modo de pago» (por
   día). Las tarifas personalizadas por RP siguen siendo del antro.
7. **Lo que todavía no es del grupo:** la comisión personalizada por RP (es
   por persona) y las políticas de texto (edad, vestimenta, música). Se
   pueden sumar como claves nuevas con el mismo patrón.

## Riesgos

- **`admin_alta_club` ahora es una envoltura.** Si otro carril hace `create
  or replace admin_alta_club` a partir del 10 o del 11, reemplaza la
  envoltura y el alta deja de aplicar lo del grupo, sin ningún error.
  Cualquier cambio futuro al alta debe tocar `_admin_alta_club_base` o
  partir del 12.
- **Triggers nuevos** en `clubs`, `reglas_comision`, `club_config_rp`,
  `caja_permisos`, `club_dia_tarifas` y `grupo_clubs`.
  - Solo insertan marcas, o rechazan si la clave está bloqueada.
  - En antros sin grupo no hacen nada.
  - Con sesión de servicio (`auth.uid()` nulo; por ejemplo, `sembrar-dev` o
    `demo-datos`) nunca rechazan, pero sí marcan «propio».
  - Al borrar un antro en cascada no marcan nada (probado en las
    limpiezas).
- **Posible choque con B10.** Si ese bloque pone un candado a
  `clubs.pago_rp_modo` con la bandera `antroapp.config_rp`, el aplicador ya
  la enciende. Revisarlo al integrar.
- **Escala.** `grupo_config_cambiar` aplica a todos los antros del grupo en
  **una** transacción, con un candado por grupo. Con decenas de antros es
  rápido; no lo medí con cientos.
- **Zona horaria.** La regla se programa con el «lunes siguiente» de
  **cada** antro, en su zona horaria. La pantalla del grupo muestra el de la
  Ciudad de México.

## Archivos de la etapa 3 (sin commit)

- Nuevos:
  - `sql/post-junta-2/12-config-grupo.sql`
  - `sql/post-junta-2/12-config-grupo-rollback.sql`
  - `lib/domain/config-grupo.ts`
  - `app/grupo/configuracion/page.tsx`
  - `components/grupo/config-grupo.tsx`
  - `components/grupo/editores-config.tsx`
  - `components/grupo/origen-config-antro.tsx`
  - `scripts/dev/probar-config-grupo.mjs`
  - `scripts/dev/capturas-config-grupo.mjs`
- Modificados:
  - `app/grupo/page.tsx`: el enlace.
  - `components/reglas-pago-rp.tsx`: la tarjeta del grupo, y el error del
    modo con el aviso de la base.
  - `components/config-rp/config-rp-antro.tsx`: avisa cuando guarda; el
    error de la visibilidad sale junto al botón.
  - `components/admin/alta/paso-grupo.tsx`, `estado.ts` y `paso-resumen.tsx`.
  - `lib/domain/alta-club.ts`: `grupo.config`, y `grupo_config` en el
    payload.
  - `scripts/dev/probar-alta-club-dominio.mjs`: 4 casos nuevos.
  - `scripts/dev/probar-clonar-club.mjs`: las tablas de bitácora quedan
    permitidas.
  - Este documento.

# Correcciones de la revisión adversarial (25/11, tarde)

El revisor del carril encontró 5 defectos. Los 5 se verificaron contra el
código; los 5 eran reales. 4 quedaron corregidos y 1 (el modo de pago «al
momento») queda como **excepción explícita** en espera de tu decisión. Todo
está en el working tree, sin commit.

## 1. (Alto) Carrera: el cambio del gerente se perdía en silencio

**Qué pasaba.** `grupo_config_cambiar` revisaba «¿el antro es propio?» antes
de tomar el candado de la regla. Si el gerente guardaba su regla en ese
mismo momento, el grupo esperaba el candado y luego **borraba** la regla del
gerente. El antro quedaba marcado «propio», pero el dinero se calculaba con
la regla del grupo. Con «qué ven los RPs» pasaba lo mismo, y ahí ni siquiera
había candado.

**Arreglo** (`sql/post-junta-2/12-config-grupo.sql`):
- `_config_marcar_propia` (la llaman los triggers cuando alguien cambia algo
  en el antro) toma un candado por antro y por clave:
  `'config_club|<club>|<clave>'`.
- `_config_aplicar_club` toma **el mismo** candado, en el mismo orden que el
  cambio del antro, para que no se traben entre sí:
  - la regla: primero `regla_comision|club` y luego el del antro;
  - modo, cover y hora límite: primero la fila de `clubs` (`for no key
    update`, igual que el UPDATE del dueño) y luego el del antro;
  - visibilidad y permisos: solo el del antro, que el trigger BEFORE INSERT
    toma antes de tocar la fila.
- Ya con los candados tomados, **vuelve a revisar** «propio». Si el antro
  ganó, no lo toca, y `grupo_config_cambiar` lo cuenta como propio.
- Parámetro nuevo `p_forzar`. Lo usan «volver al del grupo», el bloqueo y el
  alta. Con él se aplica de todos modos y se borra la marca «propio», así que
  tampoco queda una marca vieja después de un bloqueo.
- Las marcas `antroapp.config_grupo` y `antroapp.config_rp` quedan al final
  como estaban (antes se apagaban), porque ahora la función se llama dentro
  de sí misma.

**Riesgo que queda.** Un dueño que **borra** una tarifa por día justo cuando
el grupo cambia el modo de pago toma los candados en otro orden: primero la
fila de la tarifa y luego el del antro. Postgres detecta el abrazo mortal y
cancela uno de los dos con error (40P01). Ninguno de los dos cambios se
guarda a medias y no se pierde nada en silencio: quien recibió el error
vuelve a intentarlo. Es muy improbable.

## 2. (Alto) «Por reserva» sin ninguna regla calculaba con $0

**Qué pasaba.** El grupo, o «volver al del grupo», podía pasar a «por
reserva» un antro que no tenía ninguna fila en `reglas_comision`. Desde ese
momento el antro calculaba con las columnas viejas `clubs.comision_*`, en $0.

**Arreglo** (en `_config_aplicar_club`, dentro de la misma transacción).
Cuando el modo cambia a «reserva» y el antro no tiene ninguna regla:
- **Si el grupo tiene regla**: se le pone, desde el lunes de **esta** semana
  (el antro no tenía ninguna, así que no hay nada que respetar), y el antro
  queda siguiendo al grupo en la regla.
- **Si no**: se rechaza con P0001: «Para pagar por reserva en «X» hace falta
  la regla de comisión: defínela en el grupo o en el antro…».

En el alta dentro de un grupo, la envoltura revisa lo mismo antes y da su
mensaje de siempre («elige «Usar lo de este alta» o define la regla en el
grupo»). Si la regla del grupo entró por este camino, también cuenta como
«del grupo» y no queda marcada propia.

## 3. (Medio) Modo de pago y tarifas del grupo «al momento»

Sigue igual en la base: decidirlo es tuyo (ver «Decisiones pendientes»,
punto 2, de la etapa 3). Lo que cambió es que ya **no es implícito**:
- El texto de la pantalla del grupo está en ámbar: «No espera al lunes:
  cambia al momento en todos los antros que siguen al grupo…».
- «Guardar para el grupo» está desactivado hasta marcar «Entiendo que cambia
  al momento en N antros» (N cuenta los que siguen al grupo; con bloqueo,
  todos).
- Así lo dicen también la cabecera del SQL y la tabla de claves de este
  documento.

## 4. (Medio) El clon no copiaba toda la configuración de pago

**Qué pasaba.** Si el origen pagaba por día, su regla por reserva se
descartaba. Si pagaba por reserva, se descartaban sus tarifas por día.

**Arreglo.**
- Función pura nueva `entradaRpDeTextos` en `lib/domain/alta-club.ts`. La
  usan el asistente (`aEntradaRp` en `estado.ts`) y la prueba del clon.
- Lo del modo elegido viaja siempre. Lo del **otro** modo viaja si está
  completo y es válido (`admin_alta_club` del 10 ya aceptaba las dos cosas).
  Si está incompleto, no viaja: no tiene sentido marcar un error en un campo
  que el paso no muestra.
- La precarga del clon ya no inventa una regla a partir de las columnas
  viejas cuando el origen paga por día y no tiene regla nueva.
- Los avisos dicen «se copia igual, guardada por si el antro nuevo cambia de
  modo».
- El resumen del alta muestra una fila nueva, «También se guarda», con lo del
  otro modo.
- Esto también aplica a un alta normal: si el admin llenó la regla y luego
  cambió a «por día», la regla se guarda y el resumen lo muestra.

## 5. (Bajo) Errores mudos en las tarifas por día

En `components/reglas-pago-rp.tsx`:
- Agregar o borrar una tarifa ahora muestra el aviso de la base con
  `mensajeParaUsuario`. El error del borrado sale arriba de la lista; antes
  solo iba a la consola.
- `OrigenConfigAntro` avisa qué claves bloqueó el grupo (`onBloqueos`). Con
  el modo de pago bloqueado, se desactivan el selector, «Guardar modo de
  pago», el formulario de tarifas y «Eliminar», con el texto «El modo de
  pago y las tarifas por día los define el grupo «X»…».
- Agregar o borrar una tarifa recarga la tarjeta «del grupo / propio».

## SQL (sin archivos nuevos)

Se corrigieron los mismos dos archivos, `12-config-grupo.sql` y
`12-config-grupo-rollback.sql`. En el rollback, la firma de
`_config_aplicar_club` ahora lleva `boolean`. En dev quedó la versión nueva:
- se aplicó el rollback de la versión anterior (con la firma vieja, desde un
  archivo temporal que ya se borró);
- luego se aplicó el 12 nuevo.

El primer intento del rollback falló por un abrazo mortal con la actividad
de otro agente. Se reintentó y pasó. El orden para producción no cambia: 10,
11, 12.

## Pruebas automáticas (re-corridas, resultados reales en dev)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-config-grupo-carrera.mjs` (**nueva**: 2 conexiones, 6 carreras y «por reserva» sin regla) | **22/22** |
| `node scripts/dev/probar-config-grupo.mjs` | 105/105 |
| `node scripts/dev/probar-alta-club-dominio.mjs` (+9 casos de `entradaRpDeTextos`) | 88/88 |
| `node scripts/dev/probar-clonar-club.mjs --base=…:3021` (origen por reserva con tarifas → se copian; origen por día con regla → se copia) | 110/110 |
| `node scripts/dev/probar-alta-reglas.mjs --base=…:3021` | 77/77 |
| `node scripts/dev/probar-alta-club.mjs --base=…:3021` | 54/54 |
| `capturas-config-grupo.mjs` (+ confirmación del modo y modo bloqueado en el panel del dueño) | 61/61 |
| `capturas-clonar-club.mjs` (+ «También se guarda» en el resumen) | 54/54 |
| `capturas-alta-reglas.mjs` | 28/28 |
| `npx tsc --noEmit`, `npx eslint` (archivos tocados) | limpios |
| `next build` (`NEXT_DIST_DIR=.next-build`, llaves de dev) | compila; `tsconfig.json` sin cambios |

Notas honestas:
- **Corridas que fallaron y se repitieron.**
  - La primera corrida de `probar-alta-club` y `probar-alta-reglas` falló
    por el límite de inicios de sesión de Supabase Auth, que se comparte con
    los otros agentes. Se repitió 90 s después y pasó completa.
  - Una corrida de `probar-clonar-club` se cayó con «Connection terminated
    unexpectedly» del pooler. El proceso murió sin limpiar y dejó 2 antros, 1
    grupo y 6 cuentas `t_alta_…ef60bdd0`. Los borré a mano con la misma
    lógica de limpieza de la prueba; quedaron 0 restos de `T alta` y de
    `t_alta_`. La siguiente corrida pasó 110/110.
- **Limitación de la prueba de carrera.** No la corrí contra la versión
  vieja del SQL, porque la vieja no quedó guardada en ningún lado. Que la
  carrera existía lo demostró el revisor con el mismo escenario (caso 1).
- **Servidor.** `servidor-dev.mjs` no arranca en el worktree. Usé `next dev`
  sin turbopack en el puerto 3021, con las llaves de `.env.dev` (lanzador en
  el scratchpad), y lo detuve al terminar.
- **Capturas revisadas a ojo** (en `screenshots-b-alta/`):
  - `390-grupo-config-modo.png`: el aviso ámbar y la casilla.
  - `390-grupo-dueno-modo-bloqueado.png`: el selector y el botón
    desactivados, con la explicación.
  - `390-clon-resumen.png`: la fila «También se guarda: Tarifas por día: día
    1 $300».

## Prueba manual de las correcciones, clic a clic

1. **Modo de pago con confirmación.** Entra con el dueño de un grupo de
   prueba y abre `/grupo/configuracion` → «Cómo se paga a los RPs» →
   «Definir para el grupo».
   - «Guardar para el grupo» está gris y el texto ámbar dice que no espera
     al lunes.
   - Marca «Entiendo que cambia al momento en N antros» y guarda.
2. **Modo bloqueado en el antro.** Haz lo mismo con «Bloquear» marcado y
   entra como dueño de uno de esos antros, en `/dueno/panel`, «Reglas de pago
   a RPs».
   - El selector, «Guardar modo de pago», el formulario de tarifas y
     «Eliminar» están desactivados, con «los define el grupo «X»».
3. **Por reserva sin regla.** Usa un grupo sin regla de comisión y con un
   antro que pague por día y no tenga regla. En el grupo, guarda «Por
   reserva que consume».
   - Sale en rojo «Para pagar por reserva en «X» hace falta la regla de
     comisión…» y el antro sigue por día.
   - Define primero la regla del grupo y repite: el antro pasa a «por
     reserva» con la regla del grupo desde este lunes. En su panel, la regla
     ya no dice «anterior».
4. **Clon.** Entra como admin y en `/admin` → «Clonar» elige un antro que
   pague por reserva y tenga tarifas por día.
   - En el resumen aparece «También se guarda: Tarifas por día…».
   - Al darlo de alta, el antro nuevo tiene esas tarifas en «Reglas de
     pago».
   - Con un origen por día que tenga regla, el clon guarda también la regla.
5. **Error de tarifa visible.** Repite el paso 2 con el admin quitando el
   bloqueo (desde `/grupo/configuracion`, guardando sin «Bloquear»).
   - Borrar una tarifa ya funciona y el antro queda «Propio» en el modo de
     pago.
   - Si un error de red impide borrarla, el aviso sale arriba de la lista.
6. **Carrera.** No se puede probar a mano con fiabilidad; la cubre
   `probar-config-grupo-carrera.mjs`.

## Archivos tocados en las correcciones

- **SQL:** `sql/post-junta-2/12-config-grupo.sql` y
  `12-config-grupo-rollback.sql`.
- **Código:**
  - `lib/domain/alta-club.ts`: `entradaRpDeTextos` y los avisos de la
    precarga.
  - `lib/domain/config-grupo.ts`: el texto `CUANDO_APLICA.modo_pago`.
  - `components/admin/alta/estado.ts`: `aEntradaRp`.
  - `components/admin/alta/paso-resumen.tsx`: «También se guarda».
  - `components/grupo/config-grupo.tsx`: la confirmación del modo.
  - `components/grupo/origen-config-antro.tsx`: `onBloqueos`.
  - `components/reglas-pago-rp.tsx`: los errores de tarifas y el bloqueo.
- **Pruebas:**
  - `scripts/dev/probar-config-grupo-carrera.mjs` (nueva).
  - `scripts/dev/probar-alta-club-dominio.mjs`,
    `scripts/dev/probar-clonar-club.mjs`,
    `scripts/dev/capturas-config-grupo.mjs` y
    `scripts/dev/capturas-clonar-club.mjs`.
