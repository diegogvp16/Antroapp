# Carril b-cliente

Rama `b-cliente`, creada desde `post-junta-2`. Todo se probó en
**antroapp-dev**; producción no se tocó (ni lectura ni escritura).

- **Etapa 1 (B6)**: boleto del cliente, estado del QR y cover. Abajo,
  primera parte de este documento.
- **Etapa 2 (B10)**: qué ve el RP y su cuota. Sección «Etapa 2» al final.

Los commits los hace el coordinador (a los subagentes el sistema de
permisos les bloquea `git commit`). La etapa 1 y el avance parcial de B10
quedaron en `b0640154`. Lo que terminó la etapa 2 (B10) y las correcciones
de la revisión (sección «Etapa 3» al final) siguen **solo en el working
tree**: falta que el coordinador los commitee en `b-cliente`.

# Etapa 1: boleto del cliente (B6)

24/11/2026 (en dev ya era la madrugada del 25).

## Qué se hizo, por función

### 1. Confirmación honesta al reservar (`/cliente/reservar`)

- El título decía «¡Reserva confirmada!», pero la reserva nace `pendiente`.
  Ahora dice **«Lugar apartado»**: «Para el martes 24 de noviembre en
  <antro>. Muestra este código en la puerta.»
- Muestra el QR y un bloque con el **antro y su dirección**, la **noche con
  fecha larga en español** (no ISO), las **personas** y a nombre de quién.
- Bloque **«En la puerta»** (`components/boleto/en-la-puerta.tsx`):
  - el cover informativo (`textoCover` de `lib/cover.ts`) con un aviso que
    **depende del modo** (corregido en la etapa 3): con «Monto», «El cover
    lo cobra el antro en la puerta, por su cuenta. AntroApp no te cobra
    nada.»; con «Entrada libre», «No hay cover en la puerta. AntroApp
    tampoco te cobra nada.»; con «Consultar», «Pregunta el cover al antro
    antes de ir. AntroApp no te cobra nada.»;
  - «Llega antes de» (de `clubs.tolerancia_hora`, p. ej. «1:30 a. m.»);
  - edad mínima y vestimenta;
  - siempre el recuadro **«El QR no garantiza el acceso.»** (derecho de
    admisión, código de vestimenta y edad mínima).
- Botones: **Ver mi boleto** (lleva a `/r/<qr>`), **Guardar o compartir
  enlace** (la hoja de compartir del teléfono; si no existe, copia el
  enlace; si tampoco se puede copiar, lo muestra para copiarlo a mano) y
  **Mandar por WhatsApp** (el mensaje ahora incluye el cover cuando el antro
  lo muestra).
- El botón del formulario dice «Apartar lugar» (antes «Confirmar reserva»)
  y la descripción completa «Apartar no tiene costo.» según el modo del
  cover («Cover $350 en la puerta: lo cobra el antro…», «Entrada libre en
  la puerta.» o «El cover pregúntalo al antro.»).
- **Un anónimo que recarga ya no pierde su QR**: al apartar **sin cuenta**,
  el boleto se guarda en el teléfono (`lib/boletos-guardados.ts`, `localStorage`, clave
  `antroapp.boletos.v1`). Al volver a `/cliente/reservar?club=…` (o a la
  ficha) aparece «Ya apartaste lugar para el martes 24 de noviembre · 2
  personas — Ver boleto →».
  - Qué se guarda: solo el código, el antro (id y nombre), la fecha y las
    personas. **Nunca el teléfono ni el nombre.**
  - Se lee sin confiar: lo que no tenga la forma exacta (código
    `antro-<uuid>`, uuid del antro, fecha ISO, 1–20 personas) se descarta y
    los campos de más se tiran.
  - Se purga solo cuando pasa su noche (corte 08:00 **en la zona del
    antro**, que se guarda con el boleto; los viejos sin zona, con la de
    CDMX) y guarda 10 como máximo.
  - Todo en `try/catch`: en modo privado o con datos bloqueados la página
    funciona igual, y la confirmación dice «No pudimos guardarlo en este
    teléfono. Guarda el enlace…».
  - Con cuenta **no se guarda nada** en el teléfono y la confirmación
    remite a «Mi perfil». Cerrar sesión en `/cliente/perfil` borra la lista
    (etapa 3).

### 2. Estado del QR en `/r/<codigo>`

- `obtener_reserva_por_qr` ahora devuelve `estado_boleto`, **calculado en la
  base**:
  - `usado`: status `usada`, `entrada_en` no nulo o `puerta_estado = 'entro'`
    (gana sobre «vencido»);
  - `vencido`: la fecha es anterior a la noche operativa del antro (hora
    local de `clubs.zona_horaria`, corte 08:00, igual que
    `club_fecha_operacion`);
  - `vigente`: lo demás. «En puerta» (`puerta_estado = 'en_puerta'`) sigue
    vigente porque todavía necesita el QR.
  - **No hay estado «cancelado»**: `reservations_status_check` solo admite
    `pendiente | confirmada | usada` y ninguna pantalla cancela.
- La página muestra una insignia (Vigente / Ya se usó / Vencido) y **solo
  pinta el QR si sigue vigente**, para que uno usado o vencido no parezca
  válido en la puerta. Con «usado» y «vencido» explica por qué y ofrece ver
  antros.
- «Boleto no encontrado» con texto correcto (antes decía «ninguna reserva
  activa», que era engañoso) y un estado de **error de red** con «Intentar
  de nuevo» («Tu código sigue siendo el mismo: este enlace te lleva al
  boleto cuando vuelva la señal»; antes decía «Tu lugar sigue apartado»,
  que no se podía saber sin red).
- **Compatibilidad**: si la base todavía tiene la función vieja (sin
  `estado_boleto`), la página calcula el estado con el status y la fecha
  (`estadoBoletoRespaldo`), así el código puede llegar a producción antes o
  después del SQL.

### 3. Cover informativo en la ficha y en el boleto

- Ficha (`/cliente/[clubId]`): debajo de «En la puerta: Cover $X», el aviso
  de que lo cobra el antro y la app no cobra nada, más «Llega antes de»
  cuando el antro tiene hora límite; y el aviso del boleto guardado arriba
  del botón «Reservar».
- Boleto `/r`: el bloque «En la puerta» con el cover, la hora, la edad y la
  vestimenta (solo si el antro está publicado, ver SQL).
- El depósito (`deposito_monto`) sigue sin mostrarse: la app no cobra.

### Extra pequeño

- `/cliente/perfil`: fecha legible y enlace **«Ver boleto →»** en cada
  reserva (el cliente ya podía leer su `qr_code` por RLS).
- `lib/domain/compartir.ts`: `mensajeReserva` acepta `cover` opcional. Es
  aditivo: el panel del RP no lo manda y su mensaje sale idéntico.
- El enlace «Inicia sesión para ver tu historial» del formulario medía 31 px
  de alto: ahora 40 px.

## SQL, en orden

| # | Archivo | Rollback |
|---|---|---|
| 40 | `sql/post-junta-2/40-boleto-estado.sql` | `sql/post-junta-2/40-boleto-estado-rollback.sql` |

- Cambia el tipo de retorno de `obtener_reserva_por_qr`, así que es `drop`
  + `create` en la misma transacción (sin ventana sin función). Las seis
  columnas de hoy quedan **iguales y en el mismo orden**; las nuevas van al
  final: `estado_boleto, club_direccion, cover_modo, cover_monto,
  tolerancia_hora, edad_minima, codigo_vestimenta`. El código viejo (y
  `scripts/dev/video-junta.mjs`) siguen funcionando.
- Datos de la puerta **solo de antros publicados** (verificado y con
  suscripción). De un borrador o de un antro sin suscripción sale solo el
  nombre, como hoy.
- Sigue **sin** teléfono, consumo, ids (reserva, antro, cliente, RP, mesa),
  `source` ni hora de entrada. Busca el código exacto (igualdad, una fila).
- `security definer` con `set search_path = ''` (la vieja tenía `'public',
  'pg_temp'`).
- GRANT igual que hoy: EXECUTE a `anon`, `authenticated` y `service_role`;
  nada a PUBLIC.
- El rollback restaura **la versión exacta** de hoy (cuerpo, search_path,
  GRANT). Probado en dev: huella del catálogo (definición + ACL + config +
  comentario) idéntica antes del SQL y después del rollback
  (`b5e5e671da071713`). Secuencia hecha: aplicar → rollback → aplicar. **Dev
  quedó con el 40 aplicado.**
- Va en el pase cuando toque. Orden: el SQL y el código son independientes
  (el código tiene respaldo para la función vieja).

## Pruebas automáticas (resultados reales)

`scripts/dev/probar-boleto-cliente.mjs` (crea antros «T cli …», un cliente
`t_cli_cliente_…@example.com` y sus reservas, y los borra en `finally`).

```
node scripts/dev/probar-boleto-cliente.mjs                    # dominio + base
PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/probar-boleto-cliente.mjs http://localhost:3024
```

- Dominio (sin base): 20/20. Respaldo del estado, corte 08:00, hora
  legible, renglones de la puerta, nunca «confirmada», boletos guardados
  (basura, campos alterados, teléfono descartado, purga, sin repetidos, tope
  de 10, solo códigos `antro-<uuid>`).
- Base (anónimo y cliente con sesión): 22/22. SECURITY DEFINER con
  search_path vacío, GRANT sin PUBLIC, tipo de retorno sin datos sensibles,
  los 8 casos de estado (vigente, futura, vencida, usada, entró por puerta,
  usada de ayer, en puerta, antro borrador), exactamente las 13 columnas,
  sin teléfono ni id, borrador sin dirección ni cover, código inexistente,
  vacío y «%» → nada, anónimo sin lectura directa de `reservations`.
- Pantallas (build de producción contra dev, 390×844 y 360×740): en la
  primera corrida completa **138 pasan, 2 fallan**. Las 2 eran el enlace
  «Inicia sesión para ver tu historial» de 31 px (ya corregido).
- **Corrida final, después del arreglo y con build nuevo: 140 pasan, 0
  fallan** (dominio 20, base 22, pantallas 98). Limpieza verificada: 0
  antros «T cli», 0 cuentas `t_cli_` y 0 reservas «T cli» en dev.
- Regresión: `scripts/dev/recorrido-roles.mjs` contra el mismo build:
  **35/35** (incluye anónimo en `/r/<código>` y cliente en reservar y
  perfil).
- `npx tsc --noEmit` y `npx eslint` de los archivos tocados: sin errores.
  `next build` (con `.next-build` y llaves de dev) compiló sin errores y no
  modificó `tsconfig.json`.
- No corrí `probar-rp-panel`: el único cambio que toca al RP es el
  parámetro opcional `cover` de `mensajeReserva`, que por defecto es nulo y
  deja el mensaje idéntico (revisado con tsc; ese archivo no se puede cargar
  en Node porque importa con «@/»).

Capturas (tema noche) en `screenshots-b-cliente/` (ignorada por git):
`confirmacion`, `reservar-con-boleto-guardado`, `r-vigente`, `r-usado`,
`r-vencido`, `r-borrador`, `r-no-encontrado`, `ficha`, `perfil`, cada una
en `-390` y `-360`. Revisadas a ojo.

## Pasos de prueba manual (clic a clic)

Necesitas un antro **publicado** con cover. En dev: Club Demo Dev, o pon
cover desde su dueño (`dev_dueno@example.com`, panel → datos del antro →
Cover: Monto 350; opcional «Llegada hasta» 01:30).

1. **Sin sesión** (ventana privada, teléfono o 390 px): abre
   `/cliente/reservar?club=0de70000-0000-4000-8000-000000000001`.
2. Revisa que la descripción diga «Cover $350 en la puerta: lo cobra el
   antro, la app no cobra nada.» Llena nombre, teléfono, fecha de hoy y
   pulsa **Apartar lugar**.
3. Debe decir **«Lugar apartado»** (no «confirmada»), la fecha como
   «Martes 24 de noviembre», el antro con su dirección, «En la puerta» con
   el cover y el recuadro «El QR no garantiza el acceso».
4. Pulsa **Guardar o compartir enlace**: en el teléfono abre la hoja de
   compartir; en la computadora dice «Enlace copiado».
5. **Recarga la página**: arriba del formulario aparece «Ya apartaste lugar
   para el … — Ver boleto →». Tócalo: abre `/r/antro-…` con la insignia
   **Vigente** y el QR.
6. Con `dev_staff@example.com`, en el panel de staff escanea o confirma la
   entrada de esa reserva. Vuelve a abrir el enlace del paso 5: debe decir
   **«Ya se usó»** y **sin QR**.
7. Abre el enlace de una reserva de una noche pasada (por ejemplo una de la
   semana demo del perfil de un cliente): **«Vencido»**, sin QR.
8. Abre `/r/antro-00000000-0000-4000-8000-000000000000`: **«Boleto no
   encontrado»**.
9. Con `dev_cliente@example.com` en `/cliente/login`: abre la ficha de Club
   Demo Dev (aviso del cover y «Llega antes de» si tiene hora límite) y
   **Mi perfil**: fecha legible y «Ver boleto →» en cada reserva.
10. Borra las reservas que hayas creado a mano si no las quieres en dev.

## Decisiones pendientes para Diego

1. **Datos de la puerta solo de antros publicados.** Si un antro pierde la
   suscripción, sus boletos ya emitidos siguen mostrando nombre y estado,
   pero ya no la dirección ni el cover. ¿Así, o mostrar la dirección a
   quien tenga un boleto vigente aunque el antro no esté publicado?
2. **No existe «cancelado».** Si se quiere que el cliente o el RP cancelen,
   hace falta el estado en la base (check, índice de una por noche, caja,
   rendimiento del RP) y una pantalla. El boleto ya está listo para mostrar
   un cuarto estado.
3. **La hoja de compartir** comparte solo el enlace (sin texto), para que
   sirva igual en WhatsApp, Mensajes o «Guardar en notas». El botón de
   WhatsApp sí lleva el mensaje completo.
4. «Llega antes de» se toma de `tolerancia_hora`. Hoy esa hora solo marca
   «llegada tarde» en la puerta; no le quita el lugar a nadie. Si el antro
   no respeta el lugar después de esa hora, el texto podría endurecerse
   («Después de esa hora el lugar ya no se respeta»).

## Riesgos y notas

- La función es pública (anon) y SECURITY DEFINER: cualquier columna que se
  le agregue después queda pública. Las pruebas comparan la lista exacta de
  13 columnas para que un cambio no pase sin verse.
- El boleto guardado es una comodidad del dispositivo: si alguien usa el
  teléfono de otro **después de que el primero reservó sin cuenta**, vería
  el enlace a esos boletos (nombre, fecha y personas en `/r`, que ya son
  públicos con el enlace). No guarda teléfono. Con cuenta ya no se guarda
  y cerrar sesión borra la lista (etapa 3).
- La purga local usa la zona del antro guardada con el boleto (etapa 3).
  El estado real siempre sale de la base con la zona del antro.
- **No pude levantar `servidor-dev` (Turbopack) en el worktree**:
  `node_modules` es un enlace a la carpeta principal y Turbopack lo rechaza
  («Symlink node_modules is invalid, it points out of the filesystem
  root»). Usé `PUERTO=3024 node scripts/dev/servidor-prod-dev.mjs` (build
  de producción en `.next-build` contra dev), que además cubre el
  `next build` final.
- `docs/legal/inventario-datos.md` no se tocó (lo integra el coordinador):
  conviene anotar que el navegador guarda localmente código, antro, fecha y
  personas del boleto (sin teléfono ni nombre).

## Archivos

Nuevos:
- `sql/post-junta-2/40-boleto-estado.sql` y `40-boleto-estado-rollback.sql`
- `lib/domain/boleto.ts` (puro, lo carga Node en las pruebas)
- `lib/boletos-guardados.ts`
- `components/boleto/en-la-puerta.tsx`, `datos-boleto.tsx`,
  `compartir-boleto.tsx`, `aviso-boleto-guardado.tsx`
- `scripts/dev/probar-boleto-cliente.mjs`
- este documento

Modificados:
- `app/cliente/reservar/page.tsx`, `app/r/[codigo]/page.tsx`,
  `app/cliente/[clubId]/page.tsx`, `app/cliente/perfil/page.tsx`
- `lib/domain/compartir.ts` (parámetro `cover` opcional)
- `types/index.ts` (`Club.tolerancia_hora` opcional)

---

# Etapa 2: qué ve el RP y su cuota (B10)

25/11/2026. Las reglas de comisión con cuota y la visibilidad por antro ya
existían (`sql/post-junta/07-config-rp.sql`: `reglas_comision`,
`club_config_rp`, «Qué ven tus RPs»). Esta etapa cerró la fuga, hizo real el
nivel «estado, monto y botellas» y probó la cuota con sus bordes.

El avance parcial que dejó el corte de las 23:40 (commit `b0640154`: SQL 41,
pantallas y prueba) se revisó esta mañana contra la base y el código. Luego
se repitió el ciclo aplicar → rollback → aplicar y se corrieron todas las
pruebas.

Lo único que cambió hoy fue la prueba: tropezaba con el límite de inicios de
sesión de Supabase Auth, que comparten los 6 agentes.

## Qué se hizo, por función

### (a) Fuga «solo el estado» (media): cerrada

El problema: con «solo el estado», el RP leía el consumo de sus clientes
directo de la tabla, con la anon key y su sesión
(`supabase.from('reservations').select('consumo_monto')`). Dos cosas lo
dejaban pasar: la política permisiva `reservations_select_rp_own`
(`rp_id = auth.uid()`) le abría la fila completa, y el GRANT de tabla
incluye `consumo_monto`.

**Decisión: el RP ya no lee `reservations` directo.** Todo lo suyo sale de
`rp_mis_reservas` (security definer), que aplica el nivel de su antro.

Por qué no privilegios por columna: valen por rol de base, y staff, gerente,
dueño, admin y cliente comparten `authenticated` con el RP. Quitar
`consumo_monto` se la quitaría a todos y rompería la caja, el panel de staff
y el admin.

Cambios:

- **Política**: se borra `reservations_select_rp_own`. El RP sigue creando
  reservas (`reservations_insert_rp` no cambia: el insert del panel no pide
  la fila de regreso).
- **Panel del RP**: «Lo que llevas ganado» (pestaña Perfil de
  `app/rp/panel/page.tsx`) ya no lee `reservations` ni `commissions`. Usa
  `rp_mis_reservas`, y `desdeMisReservas` (`lib/rp-rendimiento.ts`) arma las
  reservas y las comisiones del resumen:
  - «Entró» es «consumió» o «llegó sin consumo», igual que en la pestaña
    Reservas.
  - La comisión es la de cada reserva, con su noche.
- **`rp_nivel_visibilidad(club)`** pierde el EXECUTE de `authenticated`.
  Antes, cualquier usuario con sesión preguntaba la configuración de
  cualquier antro. Solo la llaman funciones security definer, que corren
  como su dueño y no cambian.
- **Otras tablas con dinero**: se revisaron y el RP no las lee.
  - `caja_consumos`, `mesa_cuentas`, `mesa_sesiones`, `caja_pagos` y
    `caja_cuadres` pasan por `caja_puede_ver`: solo admin, dueño, dueño de
    grupo y staff o gerente activos.
  - `consumption_entries` no tiene política para el RP.
  - `grupo_rendimiento_rp` y `config_rp_*` son solo para gerente, dueño o
    admin.
- **Lo que el RP sí sigue viendo**: su propia comisión (`commissions` y
  `nomina_semana_mia`).
  - Con una regla de porcentaje, de ahí se deduce el consumo. Es inevitable
    (el RP tiene que ver lo que gana), así que el dueño ve un aviso al
    elegir «solo el estado» con porcentaje (`avisoVisibilidad`,
    `lib/domain/config-rp.ts`).
  - El embed `commissions → reservations(consumo_monto)` sale vacío
    (probado).

### (b) «Estado, monto y botellas»

Antes, los «renglones» eran cada `caja_consumos.concepto` libre, sin
producto, cantidad ni categoría. Ahora `rp_mis_reservas` (SQL 41) se porta
así:

- **Con este nivel y el catálogo de la fase 2 en la base** (`productos` y
  `caja_consumos.producto_id`, revisados al correr):
  - Los renglones son **solo los consumos del catálogo**, agrupados por
    producto, con cantidad, categoría y monto, y sin anulados.
  - Lo que se capturó como concepto libre se suma aparte en la columna
    nueva `otros_centavos` («Otros consumos»).
  - El catálogo se lee con SQL dinámico con parámetros (`execute … using`),
    así la función se crea y corre igual en una base **sin** la fase 2.
- **Sin la fase 2 en la base**: no hay renglones (`renglones` y
  `otros_centavos` nulos). El nivel se ve exactamente igual que «estado y
  monto». Se probó renombrando `productos` dentro de una transacción que se
  deshace.
- **Bandera de la pantalla (`NEXT_PUBLIC_FASE2`)**: el detalle del RP
  (`components/rp/detalle-reserva-rp.tsx`, `botellasParaRp`) solo muestra
  «Botellas y productos» con la bandera encendida. Con la bandera apagada,
  el RP ve el monto y nada más, aunque la base mande renglones.
- **Panel del dueño**: si elige «botellas» con la fase 2 apagada, ve el
  aviso «todavía no está encendido: por ahora tus RPs lo ven igual que
  "Estado y monto"».
- **Compatibilidad**: el tipo de retorno cambia, así que es `drop` + `create`
  en la misma transacción.
  - Las 17 columnas de hoy quedan iguales y en el mismo orden;
    `otros_centavos` va al final.
  - Cada renglón conserva `concepto` («3 × Buchanan's») y `monto_centavos`,
    para que el código viejo lo siga leyendo.
- **Texto de la regla** (`describirRegla`): la regla anterior de porcentaje
  con desbloqueo decía «… $0 cada una». Ahora dice «… 10 % del consumo cada
  una».

### (c) Cuota con bordes: probada, sin cambios en la base

Hay dos maneras de decir la cuota, y las dos se probaron:

- **Regla anterior** (`clubs.comision_desbloqueo_reservas = D`): **la
  D-ésima reserva que consume ya paga**. Con D = 0 o D = 1, paga desde la
  primera y el panel dice «sin cuota».
- **Regla nueva** (`reglas_comision`, tipo `cuota`, N): las primeras N no
  pagan y paga **desde la N+1**. El panel muestra cuota = N+1, o sea, lo
  mismo que D = N+1. La cuota 0 se rechaza: para eso está «monto fijo».

La semana se toma de la **noche** de la reserva (`reservations.fecha`), no de
la hora del cuadre:

- Va de lunes a domingo, con corte a las 08:00 en la **zona del antro**.
- La madrugada del lunes (00:00–07:59) es todavía la noche del domingo. La
  semana nueva empieza con la noche del lunes.
- Con un antro en Tijuana, a las 08:00 de CDMX todavía es domingo. A las
  10:00 de CDMX (las 08:00 allá) ya es lunes.

Reglas nuevas y programadas:

- Una regla nueva se programa para **el lunes siguiente**. Lo que falta de
  la semana sigue con la vigente: no es retroactiva.
- Reprogramar reemplaza a la programada.
- La regla propia de un RP (`rp_comision_overrides`) gana sobre la del
  antro.

## SQL, en orden

| # | Archivo | Rollback |
|---|---|---|
| 41 | `sql/post-junta-2/41-rp-visibilidad.sql` | `sql/post-junta-2/41-rp-visibilidad-rollback.sql` |

- **Requiere**:
  - el pase 1 (`rp_mis_reservas`, `soy_rp_dado_de_baja`);
  - `sql/post-junta/07-config-rp.sql` (`club_config_rp`,
    `rp_nivel_visibilidad` configurable).

  La fase 2 es **opcional**.
- **Orden en el pase: DESPUÉS del código nuevo.**
  - El panel viejo del RP lee `reservations` directo para su resumen. Con el
    41 aplicado, su «lo que llevas ganado» saldría en ceros, sin error.
  - El código nuevo funciona con o sin el 41.
- **`rp_mis_reservas`**:
  - `security definer` con `set search_path = ''`;
  - `revoke all … from public, anon` y EXECUTE solo a `authenticated`;
  - la función exige rol `rp` (con `is distinct from`, sin hueco de NULL),
    club no nulo y cuenta activa.
- **Rollback**:
  - Vuelve a crear la política, el EXECUTE de `rp_nivel_visibilidad` y la
    función de hoy.
  - El cuerpo de la función es idéntico, línea por línea, al de
    `sql/2026-11-21-rp-panel.sql` (comparado con `diff`).
  - **Vuelve a abrir la fuga.**
  - Va antes del rollback de 07.
- **Ciclo en dev (25/11)**: aplicar → rollback → aplicar. La huella del
  catálogo (definición y ACL de las dos funciones, políticas de
  `reservations` y ACL de la tabla) quedó así:

  | Momento | Huella |
  |---|---|
  | Con el 41 | `e41d1fd80f20d935` |
  | Después del rollback | `937fffd86707603c` |
  | Con el 41 otra vez | `e41d1fd80f20d935` (idéntica) |

  **Dev quedó CON el 41 aplicado.**

## Pruebas automáticas (resultados reales, 25/11)

`scripts/dev/probar-rp-visibilidad.mjs`:

- Crea antros «T cli …» y cuentas `t_cli_…@example.com`, y los borra en
  `finally`.
- Solo lee Club Demo Dev (`dev_rp`, `dev_admin`).
- Las noches de otras semanas las arma con SQL y las liquida con la función
  real `caja_liquidar_cuenta`.
- Hoy: reintenta el inicio de sesión si topa con el límite de Supabase Auth,
  y solo abre sesión en las cuentas que la usan (de 19 a 13 inicios).

Corridas:

| Corrida | Resultado |
|---|---|
| Base, sin pantallas (primera vez) | 39 pasan, 1 falla: el límite de inicios de sesión de Auth (dev compartido) cortó la sección de cuota |
| Base, con el arreglo | **59/59** |
| Pantallas, build de producción, `NEXT_PUBLIC_FASE2` apagada | **73/73** |
| Pantallas, build de producción, `NEXT_PUBLIC_FASE2=1` (`--fase2`) | **75/75** |

En cada corrida, la limpieza verificó 0 antros y 0 cuentas de prueba
restantes.

Qué cubre cada bloque:

- **Dominio (10)**:
  - botellas con y sin fase 2, y renglones de la versión anterior;
  - rendimiento desde `rp_mis_reservas` (lo anulado no suma);
  - textos de la regla y los dos avisos.
- **Fuga (21)**:
  - ya no existe la política, y `rp_nivel_visibilidad` no tiene EXECUTE
    para `authenticated` ni `anon`;
  - con la sesión real del RP y la anon key, `select('consumo_monto')`,
    `select('*')` y `count` dan 0; el embed desde `commissions` sale vacío;
  - `rp_mis_reservas` con «solo estado» da «consumió» sin monto;
  - el RP sigue creando reservas y las ve «por llegar»;
  - staff, gerente, dueño y admin siguen leyendo la reserva con su consumo,
    y el cliente la suya con `select('*')`;
  - `dev_rp` en Club Demo Dev: 0 filas directas, y su RPC funciona.
- **Botellas (8)**:
  - 3 × Buchanan's agrupado (2 + 1), con categoría y monto;
  - el Don Julio anulado no sale;
  - «otros» de $200 aparte, sin cambiar el total;
  - reserva sin consumo: renglones vacíos;
  - sin la fase 2 en la base: sin renglones, con monto.
- **Cuota (20)**:
  - D=0 y D=1;
  - D=3: la 3.ª paga y la 4.ª también; el panel dice «llevas 2 de 3, la
    siguiente paga»;
  - D=2 de domingo a lunes: la semana se reinicia;
  - corte de las 08:00 en CDMX y en Tijuana; el domingo cuenta en la semana
    del lunes anterior;
  - cuota N=1: paga la 2.ª;
  - programar, reprogramar, no retroactiva, regla nueva desde el lunes;
  - regla propia del RP con D=2.
- **Pantallas** (390×844 y 360×740; 7 por ancho, 8 con la fase 2):
  - detalle del RP con y sin botellas; renglones ≥ 40 px; sin scroll
    horizontal;
  - «lo que llevas ganado» = $100, «1 de 2 entraron», desde la RPC;
  - sin errores de consola ni HTTP;
  - avisos del dueño: catálogo apagado o encendido, y porcentaje con «solo
    el estado».

Regresión contra los mismos builds:

| Prueba | Resultado | Detalle |
|---|---|---|
| `scripts/dev/probar-config-rp.mjs` | **28/28** | |
| `scripts/dev/probar-rp-panel.mjs` | **40/40** | Build con fase 2; `demo_mariana` y `demo_diego`, solo lectura. «La consulta no trae reservas de otros RPs»: 35 y 29 reservas, 0 ajenas. |
| `scripts/dev/recorrido-roles.mjs` | **35/35** | Build con fase 2 |

Compilación:

- `npx tsc --noEmit` y `npx eslint` de los archivos de B10: sin errores.
- `next build` con las llaves de dev compiló sin errores las dos veces:
  - `NEXT_DIST_DIR=.next-build`, fase 2 apagada;
  - `NEXT_DIST_DIR=.next-build-f2`, con `NEXT_PUBLIC_FASE2=1`.
- El build con fase 2 agregó `.next-build/types` a `tsconfig.json`. Se
  revirtió con `git checkout -- tsconfig.json`.

Capturas (revisadas a ojo) en `screenshots-b-cliente/`, que git ignora:
`rp-detalle-{fase2,sinfase2}-{390,360}`, `rp-perfil-…` y
`dueno-visibilidad-{botellas,estado}-…`.

Contra `next dev` (sin Turbopack, en el worktree), la prueba de pantallas
falló a 360 px: el indicador de desarrollo de Next tapa el botón «Perfil»
de la barra inferior. Es un artefacto de `next dev`; con el build de
producción pasa.

## Pasos de prueba manual (clic a clic)

Se hace en dev, en Club Demo Dev, con dos usuarios:

- `dev_dueno@example.com` (o `dev_gerente`);
- `demo_mariana@example.com` (RP con reservas de esta semana).

La contraseña está en `backups/dev-credenciales.json`. **Ojo:** dev lo
comparten otros. Al terminar, deja Club Demo Dev en el nivel que tenía (hoy
«Estado y monto»).

1. **Dueño**: entra en `/cliente/login` con `dev_dueno`, ve a
   `/dueno/panel` y baja a «Qué ven tus RPs de sus clientes».
2. Elige **Solo el estado**. Si la regla del antro es un porcentaje, aparece
   el aviso «el RP puede calcular cuánto consumió su cliente». Pulsa
   **Guardar**.
3. **RP** (en otra ventana privada): entra en `/cliente/login` con
   `demo_mariana`.
   - En la pestaña **Reservas**, toca una reserva «Consumió». El detalle
     dice «Consumió», **sin monto** y sin botellas.
   - En la pestaña **Perfil**, «Esta semana $… · N de M entraron» carga sin
     error.
4. **La fuga**: en la ventana del RP abre las herramientas del navegador
   (F12), pestaña **Red**, y recarga el panel. No debe aparecer ningún
   `GET /rest/v1/reservations`; solo `POST /rest/v1/rpc/rp_mis_reservas`.
   La lectura directa con la sesión real del RP ya la cubre la prueba
   automática (0 filas).
5. **Dueño**: elige **Estado y monto** y pulsa Guardar.
   **RP**: recarga; el detalle muestra «Consumo $…».
6. **Dueño**: elige **Estado, monto y botellas**. Con la app sin
   `NEXT_PUBLIC_FASE2=1`, aparece el aviso «todavía no está encendido». En
   el RP se ve igual que «Estado y monto».
7. **Con la fase 2 encendida** (servidor con `NEXT_PUBLIC_FASE2=1` y el SQL
   de la fase 2 en la base):
   - el staff registra en `/staff/caja`, desde el catálogo, 2 botellas para
     una reserva de `demo_mariana`, más un consumo libre;
   - en el RP, el detalle muestra «Botellas y productos» con «2 ×
     <botella>», su categoría y monto, y «Otros consumos $…».
8. **Cuota**: en «Reglas de pago», el dueño elige «Cuota», 2, $200, y pulsa
   Guardar.
   - Debe decir que vale **desde el lunes siguiente**, no hoy.
   - El RP sigue viendo la regla de esta semana en su tarjeta de cuota.
9. Regresa Club Demo Dev a como estaba (nivel y regla). Para quitar la
   regla programada, programa otra vez la de antes: la reemplaza.

## Decisiones pendientes para Diego

1. **Porcentaje con «solo el estado»**: con regla de porcentaje, el RP
   deduce el consumo de su propia comisión. Hoy solo se avisa al dueño. Hay
   dos caminos:
   - impedir esa combinación;
   - dejarlo así: el RP tiene derecho a saber de dónde sale lo que gana.
2. **Las botellas salen solo del catálogo**: los conceptos libres que el
   staff escribe a mano («Botella Tequila») van a «Otros consumos», sin
   nombre. Es a propósito: el texto libre puede traer cualquier cosa
   (nombres, notas). Si se quiere mostrarlos, sería otro nivel u opción.
3. **Dos maneras de decir la cuota**: la regla anterior paga desde la
   D-ésima; la nueva, desde la N+1. En pantalla es coherente (el panel del
   RP siempre muestra el número de la que paga), pero en la junta conviene
   hablar de una sola: «desde la 5.ª».
4. **Texto de la tarjeta de cuota** (ya existía, no lo toqué): dice «3 de 10
   reservas que consumen · faltan 6 para que empiecen a pagar». Con D=10,
   después de 6 más la siguiente (la 10.ª) paga. Se entiende, pero «la 10.ª
   ya paga» sería más claro.

## Riesgos

- **Orden en el pase**: el SQL 41 va **después** del código. Al revés, el
  resumen del RP sale en ceros y sin error visible.
- **Pantallas nuevas del RP**: cualquiera (de otro carril) que lea
  `reservations` directo verá 0 filas, sin error. Tiene que usar
  `rp_mis_reservas`.
  - Lo mismo con las pruebas que hagan `insert(...).select()` como RP:
    fallarían.
  - Revisé `scripts/`: solo hay inserts sin `select()`.
- **Columnas nuevas en `rp_mis_reservas`**: es security definer y la llama
  cualquier RP con sesión, así que lo que se le agregue queda visible para
  todos los RPs. Las pruebas revisan monto, renglones y otros por nivel.
- **Base con fase 2 y bandera apagada**: la base sí manda los renglones del
  catálogo, y el RP podría verlos llamando la RPC desde la consola. En la
  práctica van vacíos, porque con la bandera apagada nadie vende del
  catálogo. Si se quiere un candado duro, `club_config_rp` necesitaría una
  bandera de fase 2 por antro (configurable, no código a la medida).

## Archivos de la etapa 2

- `sql/post-junta-2/41-rp-visibilidad.sql` y
  `41-rp-visibilidad-rollback.sql`.
- `scripts/dev/probar-rp-visibilidad.mjs` (nuevo; hoy se le agregó el
  reintento de inicio de sesión y las sesiones solo donde hacen falta).
- `app/rp/panel/page.tsx`, `lib/rp-rendimiento.ts`,
  `lib/domain/rp-reservas.ts`, `components/rp/detalle-reserva-rp.tsx`,
  `lib/domain/config-rp.ts` y `components/config-rp/config-rp-antro.tsx`.
- `scripts/dev/probar-config-rp.mjs`: la expectativa de botellas cambió, y
  un concepto libre ahora va a «otros».

---

# Etapa 3: correcciones de la revisión adversarial (25/11)

El revisor del carril encontró 5 defectos. Los verifiqué uno por uno contra
el código: los 5 son reales. Cuatro se arreglaron en código; el quinto
(cambios sin commit) le toca al coordinador. **No hay SQL nuevo**: el 40 y
el 41 siguen igual, y dev sigue con los dos aplicados.

## Qué se corrigió, por defecto

### 1. (Medio) El aviso «lo cobra el antro» salía con «Entrada libre» y «Consultar»

Real: la ficha, «En la puerta» (confirmación y `/r`), el formulario y el
mensaje de WhatsApp pintaban la frase de cobro con cualquier texto de
`textoCover`, también con «Entrada libre» («Entrada libre en la puerta (lo
cobra el antro…)») y con «Consultar» («Cover: consultar con el antro en la
puerta (lo cobra el antro…)»).

Arreglo: las frases dependen de `cover_modo` y viven en un solo lugar,
`lib/domain/boleto.ts` (puro, lo prueba Node):

| Modo | Ficha y «En la puerta» (`avisoCover`) | Formulario (`frasePuertaFormulario`) | WhatsApp (`lineaCoverMensaje`) |
|---|---|---|---|
| `monto` | «El cover lo cobra el antro en la puerta, por su cuenta. AntroApp no te cobra nada.» | «Cover $350 en la puerta: lo cobra el antro, la app no cobra nada.» | «Cover $350 en la puerta (lo cobra el antro; la app no cobra nada).» |
| `libre` | «No hay cover en la puerta. AntroApp tampoco te cobra nada.» | «Entrada libre en la puerta.» | «Entrada libre en la puerta (la app tampoco cobra nada).» |
| `consultar` | «Pregunta el cover al antro antes de ir. AntroApp no te cobra nada.» | «El cover pregúntalo al antro.» | «El cover pregúntalo al antro (la app no cobra nada).» |
| `oculto` | nada | nada | nada |

- `EnLaPuerta` recibe `coverModo` además del texto.
- `mensajeReserva` ahora recibe `cover: { modo, texto }`. El panel del RP no
  lo manda y su mensaje sigue idéntico.

### 2. (Bajo) «Tu lugar sigue apartado» en el error de red de `/r`

Real: sin red la página no sabe si el boleto está vigente, usado o vencido.
Ahora dice: «Revisa la señal e intenta de nuevo. Tu código sigue siendo el
mismo: este enlace te lleva al boleto cuando vuelva la señal.»

### 3. (Bajo) Purga y respaldo con la noche de CDMX en vez de la del antro

Real: en un antro de Tijuana, a las 08:00 de CDMX (06:00 allá) el aviso «Ya
apartaste lugar…» desaparecía 2 horas antes de que terminara la noche.

- Nueva `nocheOperativaEn(zona, ahora)` en `lib/fechas.ts`: el reloj de
  pared de la zona menos 8 horas, igual que la base
  (`club_fecha_operacion`, `obtener_reserva_por_qr`). Sin zona, o con una
  que el navegador no conoce, la de CDMX.
- El boleto guardado lleva `zona` (sale de `clubs.zona_horaria` al
  reservar; se agregó `zona_horaria?` a la interfaz `Club`). Su forma se
  valida al leer (`esZonaGuardable`): una zona alterada descarta el boleto.
  Cada boleto se purga con la noche de su zona. Los guardados antes de este
  cambio, sin zona, se purgan con la de CDMX, como antes.
- `/r`: el respaldo (solo con la función vieja, que no trae la zona) usa la
  noche de `America/Tijuana`, la zona más al oeste. Así nunca marca
  «vencido» antes que la base. Con el 40 aplicado, el estado lo da la base
  y el respaldo no se usa.

### 4. (Bajo) Boleto guardado en el teléfono también con sesión, y nadie lo borraba

Real: se guardaba sin mirar `clienteId`, y ningún cierre de sesión borraba
`antroapp.boletos.v1`. En un teléfono compartido, el siguiente veía el
boleto (con el nombre) del anterior.

- `/cliente/reservar` solo guarda si **no** hay sesión. Con sesión, sus
  boletos están en Mi perfil.
- «Cerrar sesión» en `/cliente/perfil` llama a `olvidarBoletos()` (nuevo,
  en `lib/boletos-guardados.ts`), que borra la clave.
- Lo que queda: si alguien reserva **sin cuenta** y presta el teléfono, el
  siguiente ve ese boleto. Es lo que se pidió (recordar el boleto del
  anónimo) y no hay sesión que cerrar. Ver la decisión 1 abajo.
- No toqué los cierres de sesión de RP, staff, dueño ni admin (otros
  carriles tocan esas páginas). Como ya no se guarda nada mientras hay
  sesión, no hace falta.

### 5. (Bajo) La etapa 2 sin commit

Real: `scripts/dev/probar-rp-visibilidad.mjs` (reintento ante el límite de
Auth y menos sesiones) y la documentación de B10 siguen sin commit; HEAD
(`b064015`) dice «avance PARCIAL de B10». No lo puedo arreglar yo: el
sistema bloquea `git commit` a los subagentes. **Para el coordinador**:
commitear en `b-cliente` todo el working tree de este carril (lista abajo),
con un mensaje que cierre B10 y las correcciones de la revisión.

## Archivos tocados en la etapa 3

- `lib/domain/boleto.ts`: `avisoCover`, `frasePuertaFormulario`,
  `lineaCoverMensaje`, `AVISO_COVER_LIBRE`, `AVISO_COVER_CONSULTAR`; boletos
  con `zona`, `esZonaGuardable` y purga por zona (`NochePorZona`).
- `lib/fechas.ts`: `nocheOperativaEn` y `ZONA_MAS_TARDIA_MEXICO`.
- `lib/boletos-guardados.ts`: purga por zona, guarda la zona y
  `olvidarBoletos`.
- `lib/domain/compartir.ts`: `cover` pasa a `{ modo, texto }`.
- `components/boleto/en-la-puerta.tsx`: prop `coverModo` y
  `data-prueba="aviso-cover"`.
- `app/cliente/reservar/page.tsx`, `app/cliente/[clubId]/page.tsx`,
  `app/r/[codigo]/page.tsx` y `app/cliente/perfil/page.tsx`.
- `types/index.ts`: `Club.zona_horaria?`.
- `scripts/dev/probar-boleto-cliente.mjs`: casos nuevos (abajo).

Working tree completo del carril sin commit (etapa 2 + etapa 3): los de
arriba, más `docs/post-junta-2/b-cliente.md` y
`scripts/dev/probar-rp-visibilidad.mjs`.

## Pruebas automáticas (resultados reales, 25/11)

Casos nuevos en `probar-boleto-cliente.mjs`:

- **Dominio (+16)**:
  - aviso, formulario y WhatsApp para `monto`, `libre`, `consultar` y
    `oculto`: solo `monto` dice «lo cobra el antro»;
  - `nocheOperativaEn`:
    - a las 08:30 de CDMX, en Tijuana sigue la noche anterior;
    - las 08:00 de Tijuana ya cambian la noche;
    - Cancún va adelante y Tijuana respeta su horario de verano;
    - zona nula o inventada → CDMX;
  - la noche de Tijuana nunca va adelante de las otras 8 zonas de México,
    en 3 fechas (invierno, verano y hoy);
  - purga por zona: a las 08:30 de CDMX sigue el boleto de Tijuana y se van
    el de CDMX y el que no tiene zona; una zona alterada se descarta.
- **Pantallas (a 390 y a 360)**:
  - dos antros nuevos publicados: uno con «Entrada libre» en
    `America/Tijuana` y otro con «Consultar»;
  - formulario, confirmación, aviso de «En la puerta», mensaje de WhatsApp
    (leído del `href`), `/r` y ficha: ninguno dice «lo cobra el antro» y
    cada uno trae la frase de su modo;
  - el boleto guardado del antro de Tijuana lleva su zona;
  - el `/r` de $350 sí dice «lo cobra el antro»;
  - `/r` sin red (Playwright corta la RPC): «No pudimos cargar tu boleto»,
    sin «sigue apartado» y con «Intentar de nuevo»;
  - con sesión, la reserva no se guarda en el teléfono y la ficha no
    muestra «Ya apartaste lugar»;
  - «Cerrar sesión» en Mi perfil borra la lista guardada.
- La limpieza también borra las filas de `reserva_intentos` de sus antros.
  El antiabuso de reservas sin cuenta ya está en dev y cuenta 20 por IP por
  hora, y todos los agentes salen por la misma IP.

Corridas:

| Prueba | Contra | Resultado |
|---|---|---|
| `probar-boleto-cliente.mjs` (primera) | `next dev` sin Turbopack | 208/210. Las 2 que fallaron eran de la prueba: la regex buscaba «Consultar con el antro» con mayúscula, y la ficha dice «Cover: consultar con el antro». Se corrigió la prueba; la app estaba bien. |
| `probar-boleto-cliente.mjs` | `next dev` | **210/210**, y **212/212** con el caso sin red |
| `probar-boleto-cliente.mjs` | build de producción (`.next-build`) | **212/212** |
| `probar-rp-visibilidad.mjs` (base) | dev | **59/59** |
| `probar-rp-visibilidad.mjs` con pantallas | build de producción, fase 2 apagada | **73/73** |
| `probar-rp-visibilidad.mjs --fase2` con pantallas | build de producción con `NEXT_PUBLIC_FASE2=1` (`.next-build-f2`) | **75/75** |
| `probar-config-rp.mjs` | dev | **28/28** |
| `probar-rp-panel.mjs` | build de producción | **40/40**, sin errores de consola ni de red |
| `recorrido-roles.mjs` | build de producción | **35/35** |

- `npx tsc --noEmit`: sin errores.
- `npx eslint` de `lib`, `types`, `components/boleto`, `app/cliente`,
  `app/r` y la prueba: sin errores.
- `next build` con las llaves de dev compiló sin errores las dos veces:
  `.next-build` y `.next-build-f2` (con fase 2). El de fase 2 agregó
  `.next-build/types` a `tsconfig.json`; se revirtió con
  `git checkout -- tsconfig.json`.
- Limpieza verificada al final en dev: 0 antros «T cli», 0 cuentas `t_cli_`
  y 0 reservas «T cli».
- Servidor: `servidor-dev.mjs` no arranca en el worktree (Turbopack no
  acepta el enlace de `node_modules`). Usé `next dev` sin Turbopack y
  `next start` sobre los builds, en el puerto 3024 y con las llaves de
  `.env.dev`. Los dos quedaron detenidos.

Capturas nuevas (revisadas a ojo) en `screenshots-b-cliente/`:
`ficha-libre`, `ficha-consultar`, `confirmacion-libre`,
`confirmacion-consultar`, `r-libre`, `r-consultar` y `r-sin-red`, cada una
en `-390` y `-360`.

## Pasos de prueba manual (clic a clic)

Necesitas un antro publicado en dev cuyo cover puedas cambiar: Club Demo
Dev con `dev_dueno@example.com` (panel → datos del antro → Cover). Al
terminar, déjalo como estaba.

1. **Entrada libre.** Como `dev_dueno`, pon Cover: «Entrada libre» y
   guarda. Cierra sesión.
2. En una ventana privada (sin sesión), abre
   `/cliente/reservar?club=0de70000-0000-4000-8000-000000000001`. La
   descripción dice «Apartar no tiene costo. Entrada libre en la puerta.» y
   **no** dice «lo cobra el antro».
3. Aparta lugar. En «En la puerta»: Cover «Entrada libre» y debajo «No hay
   cover en la puerta. AntroApp tampoco te cobra nada.»
4. Pulsa **Mandar por WhatsApp** (o copia ese enlace): el mensaje dice
   «Entrada libre en la puerta (la app tampoco cobra nada).»
5. Pulsa **Ver mi boleto**: en `/r` sale lo mismo que en el paso 3.
6. **Consultar.** Repite los pasos 1 a 5 con Cover: «Consultar con el
   antro». Debe decir «El cover pregúntalo al antro.», «Pregunta el cover
   al antro antes de ir. AntroApp no te cobra nada.» y, en WhatsApp, «El
   cover pregúntalo al antro (la app no cobra nada).»
7. **Monto.** Con Cover: Monto 350, el aviso sí dice «El cover lo cobra el
   antro en la puerta…».
8. **Sin red.** Abre el enlace de un boleto, activa el modo avión y recarga
   (en la computadora: DevTools → Network → Offline). Debe decir «No
   pudimos cargar tu boleto», sin «Tu lugar sigue apartado». Quita el modo
   avión y pulsa «Intentar de nuevo».
9. **Con sesión no se guarda.** Entra con `dev_cliente@example.com` y
   aparta lugar en Club Demo Dev: la confirmación remite a Mi perfil.
   Vuelve a la ficha: no aparece «Ya apartaste lugar…».
10. **Cerrar sesión borra.** Cierra sesión y aparta un lugar **sin** cuenta
    (al recargar aparece «Ya apartaste lugar…»). Entra con `dev_cliente`,
    ve a Mi perfil y pulsa **Cerrar sesión**. Vuelve sin sesión a
    `/cliente/reservar?club=…`: el aviso ya no aparece.
11. **Zona del antro** (opcional, difícil a mano): solo se nota entre las
    08:00 de CDMX y las 08:00 del antro. Lo cubre la prueba automática.
12. Regresa el cover de Club Demo Dev a como estaba y borra las reservas
    que creaste a mano.

## Decisiones pendientes para Diego

1. **Teléfono compartido sin cuenta.** El boleto de quien reserva sin
   cuenta se queda en el teléfono hasta que pasa su noche (o hasta que un
   cliente cierra sesión en ese teléfono). Quien use el teléfono después lo
   ve, con el nombre. ¿Basta así, o se agrega un «Olvidar este boleto»
   junto al aviso?
2. **Redacción de «Entrada libre» y «Consultar».** Los textos de la tabla
   de arriba son propuestas. Se cambian en un solo lugar
   (`lib/domain/boleto.ts`).

## Riesgos

- `nocheOperativaEn` depende de que el navegador conozca la zona (`Intl`).
  Si no la conoce, usa la de CDMX: en el peor caso el aviso local se va
  antes, como antes del arreglo. El estado del boleto lo sigue dando la
  base.
- El respaldo de `/r` con la zona de Tijuana puede dejar «vigente» hasta 3
  horas de más un boleto de Cancún. Solo pasa si la base todavía tiene la
  función vieja, sin el 40.
