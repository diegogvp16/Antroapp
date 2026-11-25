# Carril b-cliente, etapa 1: boleto del cliente (B6)

24/11/2026 (en dev ya era la madrugada del 25). Rama `b-cliente`, creada
desde `post-junta-2`. Todo se probó en **antroapp-dev**; producción no se
tocó.

> **Sin commits.** El clasificador de permisos de esta sesión rechazó
> `git commit` (CLAUDE.md, §8: nada de commits sin que Diego lo pida). Todo
> quedó en el working tree del worktree para que lo revises. Archivos al
> final.

## Qué se hizo, por función

### 1. Confirmación honesta al reservar (`/cliente/reservar`)

- El título decía «¡Reserva confirmada!», pero la reserva nace `pendiente`.
  Ahora dice **«Lugar apartado»**: «Para el martes 24 de noviembre en
  <antro>. Muestra este código en la puerta.»
- Muestra el QR y un bloque con el **antro y su dirección**, la **noche con
  fecha larga en español** (no ISO), las **personas** y a nombre de quién.
- Bloque **«En la puerta»** (`components/boleto/en-la-puerta.tsx`):
  - el cover informativo (`textoCover` de `lib/cover.ts`) con el aviso «El
    cover lo cobra el antro en la puerta, por su cuenta. AntroApp no te
    cobra nada.»;
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
  y la descripción aclara que el cover lo cobra el antro.
- **Un anónimo que recarga ya no pierde su QR**: al apartar, el boleto se
  guarda en el teléfono (`lib/boletos-guardados.ts`, `localStorage`, clave
  `antroapp.boletos.v1`). Al volver a `/cliente/reservar?club=…` (o a la
  ficha) aparece «Ya apartaste lugar para el martes 24 de noviembre · 2
  personas — Ver boleto →».
  - Qué se guarda: solo el código, el antro (id y nombre), la fecha y las
    personas. **Nunca el teléfono ni el nombre.**
  - Se lee sin confiar: lo que no tenga la forma exacta (código
    `antro-<uuid>`, uuid del antro, fecha ISO, 1–20 personas) se descarta y
    los campos de más se tiran.
  - Se purga solo cuando pasa su noche (noche operativa de México, corte
    08:00) y guarda 10 como máximo.
  - Todo en `try/catch`: en modo privado o con datos bloqueados la página
    funciona igual, y la confirmación dice «No pudimos guardarlo en este
    teléfono. Guarda el enlace…».
  - Con cuenta, la confirmación remite a «Mi perfil».

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
  de nuevo» («Tu lugar sigue apartado»).
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
  teléfono de otro, vería el enlace a sus boletos (nombre, fecha y personas
  en `/r`, que ya son públicos con el enlace). No guarda teléfono.
- La purga local usa la noche de México; para un antro en otra zona horaria
  la purga puede ir unas horas antes o después. El estado real siempre sale
  de la base con la zona del antro.
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
