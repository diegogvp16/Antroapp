# Noche 4, bloque 2 — PWA, caja y escáner sin señal

Rama `n4-pwa` (sobre `post-junta-3`). Todo probado contra antroapp-dev con un
build de producción (`NEXT_DIST_DIR=.next-build`, puerto 3052). Nada se tocó
en producción.

## 1. Qué se hizo

### 1.1 PWA de staff y RP (auditoría)

Lo que ya existía estaba bien y se dejó igual:

- **Manifests** (`public/staff.webmanifest`, `rp.webmanifest`,
  `dueno.webmanifest`, `manifest.webmanifest`): `start_url` dentro del
  `scope`, `display: standalone`, iconos `any` y `maskable`, `lang: es-MX`.
  Cada sección declara el suyo en su layout (`lib/app-instalable.ts`); el del
  cliente es estático en `app/layout.tsx` (lección de `app/manifest.ts`).
- **`scope: "/"` en las apps de trabajo es a propósito**: el login es
  `/cliente/login`; con un scope `/staff/` el login y el cierre de sesión
  saldrían de la app instalada al navegador.
- **Service worker** (`public/sw.js`): un solo SW para todo el sitio, se
  registra en `app/layout.tsx`. Solo intercepta navegaciones; sin red sirve
  `/offline.html`. **No guarda páginas, datos, `/api` ni Supabase**: lo único
  en caché es `/offline.html`. Actualización: `skipWaiting` + `clients.claim`
  y borrado de las cachés viejas; `sw.js` sale con `Cache-Control: max-age=0`,
  así que una versión nueva entra en la siguiente visita.

Cambios:

- `app/layout.tsx`: `<html lang="en">` → `lang="es-MX"` (lectores de pantalla
  y traductor de Chrome trataban la app como inglés).
- `public/offline.html` también cuenta las entradas de la puerta pendientes
  (solo el número; no crea la base local si no existe). `sw.js` sube a
  `antroapp-v5` para que se baje la página nueva.
- `scripts/dev/probar-instalable.mjs`: revisa cabeceras y contenido de
  `sw.js`, `start_url`/`scope`/`lang` de los 4 manifests y `lang` del HTML.
  Se corrigió una revisión vieja del boleto (el texto ahora dice "no garantiza
  el acceso").

### 1.2 Caja sin señal (B9) — verificada, sin cambios

`scripts/dev/probar-caja-sin-red.mjs` contra el build de producción: consumo y
cobro sin red, recarga sin red (sale `/offline.html` con el conteo), vuelve
la red y la base los tiene **una vez**, respuestas perdidas, dos pestañas y
dos teléfonos, rechazos, otra cuenta en el mismo teléfono. **41/41** antes y
después de los cambios de este bloque. No se encontró nada roto; no se tocó.

### 1.3 Escáner de respaldo (bandera `escaner_respaldo`)

Con la bandera **apagada** el panel usa el escáner de siempre, el boleto no
cambia y no se crea ninguna base local (probado). Con la bandera
**encendida**:

**a) Código a mano.** Debajo de la cámara: "¿No lee el QR? Escribe el código
del boleto". Acepta:

- el **código corto**: los 6 últimos caracteres del QR (`antro-<uuid>`), que
  el boleto muestra debajo del QR como `A3F 9C2` (solo con la bandera
  encendida). Con señal lo busca la base (`puerta_escanear_codigo`): solo
  reservas de **esta noche** y de **este antro**, solo staff con permiso de
  puerta, mínimo 6 caracteres hexadecimales (máximo 12), sin comodines. Si
  coinciden 2 a 5 reservas de esa noche, la base devuelve las opciones con el
  nombre recortado ("Ana G.", personas; sin QR ni teléfono) y el staff elige
  viendo la identificación; la elegida vuelve a pasar por la base, que revisa
  que coincida con el código, el antro y la noche. Con más de 5 pide más
  caracteres. Luego llama a `puerta_escanear`: **el mismo camino que la
  cámara**.
- el **código completo** o el **enlace del boleto** pegado (WhatsApp): va
  directo a `puerta_escanear`.

Por qué es seguro: 6 caracteres hex son 16.7 millones de combinaciones contra
unas cientos de reservas por noche; quien lo escribe es el staff del antro,
que ya puede ver todas las reservas de la noche en su panel (y ya podía
confirmar cualquiera con "Confirmar entrada sin cámara"); y quien muestra el
boleto ya tiene el QR completo, que dice más que el código corto.

**b) Sin señal.** Mientras hay señal el panel baja una **copia de la noche**
(`puerta_copia_noche`) al abrir, cada 5 min, al volver la red y al volver a
la pantalla, y deja el lector de QR (html5-qrcode) ya cargado. Sin señal:

- la cámara o el código corto se validan contra esa copia; la ficha dice
  "Sin señal: validada con la copia del teléfono" y el botón es "Confirmar
  entrada (sin señal)";
- la entrada queda **pendiente de enviar** en el teléfono; leer otra vez el
  mismo QR avisa "Ya la registraste en este teléfono…";
- contador visible arriba en todas las pantallas de staff ("Puerta: N
  entradas pendientes de enviar"), en `/offline.html` y aviso al cerrar sesión
  y al cerrar/recargar la pestaña (`beforeunload`);
- al volver la señal se envían solas (`puerta_entrada_diferida`, que llama a
  `puerta_escanear` + `puerta_confirmar_entrada`), con clave de
  idempotencia. Si otro teléfono u otra persona ya la había registrado, se
  muestra "Ya había entrado a las HH:MM: la registró otro teléfono u otra
  persona. No se contó dos veces." (no como error). Si la base la rechaza
  (por ejemplo, la noche ya cerró), se muestra con su motivo.

**Qué guarda el teléfono** (IndexedDB `antroapp-puerta`, nunca en el SW):

| Dato | Copia de la noche | Entrada pendiente |
|---|---|---|
| id de la reserva | sí | sí |
| QR | **no**: solo su huella SHA-256 y los 6 caracteres finales | no |
| nombre del cliente | solo de quien **falta por entrar** | sí (para la lista de pendientes) |
| personas, orgánica/RP, nombre del RP | sí (RP solo de quien falta) | personas |
| teléfono, consumo, ids de cliente/RP | **no** | no |

Cuándo se borra (barrido en `components/service-worker-register.tsx`, que
está en **todas** las pantallas, también las del cliente y el RP: al abrir la
app, en cada cambio de pantalla —entrar y salir de una cuenta cambian de
pantalla— y cada 10 min; si el escáner de respaldo nunca se usó en el
teléfono, solo pregunta si existe la base local):

- **Copia**: al cerrar sesión desde el panel; al salir de la cuenta en
  cualquier pantalla de staff; en el siguiente barrido después de las 08:00
  (hora que da la base); en el siguiente barrido con **otra** cuenta en el
  teléfono; y cuando la base confirma que la bandera está apagada. **No** se
  borra si la base no contesta (sin señal): justo entonces hace falta.
- **Entrada pendiente**: vence a las 08:00 + 2 h (o 12 h si se guardó sin
  copia). Vencida, la base ya no la aceptaría: si es de quien tiene la
  sesión pasa a "no se guardó" con ese motivo; si es de otra cuenta se borra.
  Una pendiente vigente de otra cuenta se queda (se envía cuando esa persona
  vuelva a entrar). **Sobrevive al cierre de sesión hasta que vence**, con el
  nombre del cliente (para la lista de pendientes).
- **Resueltas** (enviadas, ya registradas, rechazadas): con "Entendido", a
  las 24 h, o de inmediato si en el teléfono entra otra cuenta.
- Sin sesión que se pueda leer (sin red y con el token vencido) el barrido
  solo borra lo vencido.

## 2. Archivos

Nuevos:

- `sql/post-junta-3/20-escaner-respaldo.sql` y `-rollback.sql`
- `lib/domain/puerta-respaldo.ts` — reglas puras (código, copia, clasificación)
- `lib/puerta-respaldo.ts` — IndexedDB, envío con candado (Web Locks)
- `lib/use-puerta-respaldo.ts` — hooks (sesión, copia, entradas) y envío
- `components/puerta/escaner-respaldo.tsx` — el escáner con respaldo
- `components/puerta/respaldo-panel.tsx` — estado de la copia en el panel
- `components/puerta/envio-puerta.tsx` — envío y avisos en todo `/staff`
- `components/boleto/codigo-respaldo.tsx` — código corto en el boleto
- `scripts/dev/probar-puerta-respaldo-dominio.mjs`,
  `probar-escaner-respaldo-base.mjs`, `probar-escaner-respaldo.mjs`

Tocados (cambios mínimos):

- `app/staff/panel/page.tsx` (~35 líneas): `useEscanerRespaldo`,
  `<EscanerRespaldo>` en lugar del escáner de siempre solo con la bandera, el
  efecto de la cámara de siempre **no corre** con el escáner de respaldo
  (antes abrían dos cámaras sobre el mismo elemento) y se apaga cuando
  termina de arrancar (antes, cerrar a media arrancada dejaba la cámara
  prendida), `<RespaldoPuertaPanel>` debajo de "Escanear QR", aviso de
  entradas pendientes y borrado de la copia al cerrar sesión.
- `lib/funciones.ts` (compatible con los otros carriles): `useFunciones`
  ahora también da `error` (no se pudo preguntar; reintenta con espera
  creciente y al volver la red) y `respondio` (la base contestó para ese
  antro). `activa()` y `leerFunciones` funcionan igual; se agregó
  `leerFuncionesDetalle`. Antes, sin señal, "no se pudo preguntar" se veía
  igual que "apagada".
- `components/service-worker-register.tsx`: el barrido de privacidad.
- `app/staff/layout.tsx`: `<EnvioPuerta />` junto a `<EnvioColaStaff />`.
- `app/r/[codigo]/page.tsx`: `<CodigoRespaldo>` debajo del QR.
- `app/layout.tsx` (`lang`), `public/offline.html`, `public/sw.js`,
  `scripts/dev/probar-instalable.mjs`.

## 3. SQL

`sql/post-junta-3/20-escaner-respaldo.sql` — solo funciones nuevas, **no
redefine ninguna existente**. Requiere el `00-funciones-club.sql`.

| Función | Quién | Qué |
|---|---|---|
| `puerta_copia_noche(club)` | authenticated | copia mínima de la noche (ver tabla de arriba), `vence_en`, `total` y `truncada` |
| `puerta_escanear_codigo(club, código [, reserva])` | authenticated | código corto → `puerta_escanear`; con 2–5 coincidencias devuelve `{ambiguo, opciones}` |
| `puerta_entrada_diferida(club, reserva, clave, escaneado_en)` | authenticated | `puerta_escanear` + `puerta_confirmar_entrada`; `entro` / `ya_enviada` / `ya_entro` (+ `por_ti`, `hora_local`) |
| `boleto_muestra_codigo(qr)` | anon, authenticated | sí/no según la bandera del antro de ese QR |
| índice `caja_eventos_puerta_clave` | — | `(club_id, detalle->>'clave') where tipo = 'puerta_entrada_diferida'` |

Todas `security definer`, `search_path = ''`, autorización primero
(`caja_tiene_permiso(club, 'puerta')` en `coalesce(…, false)`), luego la
bandera (`Esta función no está activa para este antro.`), errores con
`P0001`. `revoke all … from public, anon, authenticated` y `grant execute`
explícito. La entrada diferida deja un evento `puerta_entrada_diferida` en
`caja_eventos` con la hora del teléfono (`escaneado_en`) y la de llegada
(`recibido_en`).

Detalles de `puerta_entrada_diferida`: la clave de idempotencia se busca
**después de la autorización y antes de la bandera** (si apagan la bandera
entre un envío cuya respuesta se perdió y su reintento, lo que sí se guardó
se reporta como guardado), con el índice propio, y está **atada a su
reserva y a su antro**: la misma clave con otra reserva da error ("Esa
clave de envío ya se usó con otra reserva.") y nunca devuelve datos de una
reserva de otro antro.

Copia: tope de 3,000 reservas por noche (unos 600 KB). Si se pasa, van
primero las que faltan por entrar y el panel y el escáner avisan "la noche
tiene N reservas y la copia trae 3,000".

**Orden en producción**: después de `00-funciones-club.sql`. Independiente de
los demás SQL de post-junta-3. Rollback: `20-escaner-respaldo-rollback.sql`
(antes, apagar la bandera en todos los antros).

**Rollback probado en dev** (versión final, con el índice): esquema antes =
esquema después del rollback (sin ninguna diferencia); aplicado = reaplicado
(idéntico); la diferencia entre aplicado y rollback son solo las 4 funciones,
sus GRANT y el índice. En dev queda aplicado. El rollback también quita la
firma `puerta_escanear_codigo(uuid, text)` del primer borrador, por si se
llegó a aplicar.

No se regeneró la noche demo (`scripts/demo-datos.mjs` no se corrió): las
pruebas crean sus propias reservas.

## 4. Pruebas (27/11/2026, build de producción contra dev)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-puerta-respaldo-dominio.mjs` (reglas puras) | 47/47 |
| `node scripts/dev/probar-escaner-respaldo-base.mjs` (base, sesiones de 7 roles, una transacción que se deshace) | 58/58 |
| `node scripts/dev/probar-escaner-respaldo.mjs` (Playwright, sin red) | 48/48 |
| `node scripts/dev/probar-caja-sin-red.mjs` | 41/41 |
| `node scripts/dev/probar-instalable.mjs` | 42/42 (antes 33/34) |
| `node scripts/dev/probar-escaner.mjs` (bandera apagada: el escáner de siempre) | 13/13 |

`probar-escaner-respaldo.mjs` cubre: bandera apagada (escáner igual que hoy,
sin código a mano, sin base local, boleto sin código); cámara sin red;
código a mano sin red y con red; enlace pegado; código que no existe;
repetir un QR ya guardado; contador; aviso al cerrar sesión y al recargar;
`/offline.html` con el conteo; envío al volver la red (la base tiene cada
entrada **una vez**, con la cuenta del staff); dos teléfonos con la misma
reserva (A sin red, B con red: A ve "ya había entrado", la base tiene una
sola entrada, la de B); la copia del teléfono no trae QR ni teléfonos;
cerrar sesión borra la copia; la lista del panel se recarga sola al llegar
las entradas; el boleto muestra el código con la bandera encendida. Además
(revisión independiente): **una sola cámara** (1 `getUserMedia`, 1 pista
viva, 1 `<video>`) y **un solo** `puerta_escanear` por QR con la bandera
apagada y encendida; la bandera que llega con el escáner ya abierto deja una
sola cámara viva; sin respuesta de las banderas la copia no se borra y el
escáner sigue siendo el de respaldo; código repetido con señal muestra la
lista con nombres recortados y escanea solo la elegida; barrido con otra
cuenta (cliente) en el teléfono. Una corrida intermedia falló por un
`statement timeout` de dev al cambiar la bandera mientras otro carril tenía
un `alter table` abierto (ver §6); la prueba ahora reintenta ese paso.

### Revisión independiente (8 hallazgos) — qué se cambió

| # | Hallazgo | Arreglo | Prueba |
|---|---|---|---|
| 1 ALTO | Con la bandera, dos lectores en el mismo `qr-reader`: dos cámaras, doble `puerta_escanear` | el efecto de siempre no corre con el respaldo; id propio `qr-reader-respaldo`; apagar después de arrancar | 3 revisiones de cámaras en Playwright |
| 2 MEDIO | Sin señal, `mis_funciones` fallaba = "apagada" y se borraba la copia | `useFunciones` con `error`/`respondio` y reintento; la copia solo se borra con "apagada" confirmada; con error y copia vigente se sigue usando | Playwright (banderas abortadas) |
| 3 BAJO | Clave no atada a la reserva (y fuga de `entrada_en` de otro antro) | clave = misma reserva; lectura filtrada por antro | base (3) |
| 4 BAJO/MEDIO | Búsqueda de la clave sin índice | `caja_eventos_puerta_clave` (parcial) | base (`explain`) |
| 5 BAJO | Bandera apagada entre envío y reintento = "no se guardó" | la clave se busca antes que la bandera | base (2) |
| 6 BAJO/MEDIO | Copia vencida se quedaba; pendientes sin vencimiento | barrido en todas las pantallas; pendientes vencen; doc corregido | dominio (11) + Playwright |
| 7 BAJO | Copia truncada en silencio a 3,000 | `total`/`truncada`, aviso; las que faltan por entrar van primero | base (1) + dominio |
| 8 BAJO | Código repetido con señal sin salida; botones de 40 px | lista para elegir (base); «Entendido» a 44 px | base (5) + Playwright (3) |

Capturas a 390×844 y 360×740 en `screenshots-n4-pwa/` (ignorada por Git).

Datos de prueba: reservas `t_n4_pwa …` borradas al final (0 restos). Los
eventos de `caja_eventos` de esas entradas no se pueden borrar (trigger
`caja_sin_borrar`), igual que en las demás pruebas de puerta: quedan 14
eventos `puerta_entrada_diferida` en dev (más los de escanear/confirmar). La
bandera `escaner_respaldo` se deja **apagada** en dev y sin valor propio en
Club Demo Dev (como estaba).

## 5. Decisiones para Diego

1. **Código corto de 6 caracteres** (hex, mostrado `A3F 9C2`). Alternativa:
   8 caracteres (menos coincidencias, más lento de dictar). Con 6, en una
   noche de 500 reservas la probabilidad de que dos coincidan es ~0.7 %;
   entonces la pantalla muestra las que coinciden para elegir viendo la
   identificación (con señal, con el nombre recortado que da la base; sin
   señal, con el de la copia).
2. **Nombre del cliente en la copia del teléfono** (solo de quien falta por
   entrar). Hace falta para comparar con la identificación sin señal. Si se
   prefiere, se puede guardar solo el nombre de pila.
3. **Hora de la entrada diferida**: `entrada_en` y `llegada_tarde` son la hora
   en que llegó a la base (las pone `puerta_confirmar_entrada`, que no se
   cambió), no la hora del teléfono. Si la señal vuelve horas después, la
   reserva puede quedar como "llegó tarde". La hora del teléfono queda en
   `caja_eventos`. Opción: usar la del teléfono si cae dentro de la misma
   noche y antes de llegar a la base (requiere tocar la entrada después de
   confirmarla).
4. **No se guarda la pantalla del panel para abrirla sin red.** Si se recarga
   o se abre la app sin señal sale `/offline.html` (con el conteo); el escáner
   sin señal funciona si el panel ya estaba abierto. Guardar el HTML del
   panel en el SW es posible (no tiene datos), pero cambia la regla de "el SW
   no guarda páginas".
5. **Bandera apagada a media noche**: las entradas pendientes que no se
   habían enviado se rechazan ("Esta función no está activa…") y se muestran
   con ese motivo; hay que confirmarlas desde la lista de la noche. Las que
   sí se guardaron y solo perdieron la respuesta se reportan como guardadas.
6. **Pendientes que sobreviven al cierre de sesión** (con el nombre del
   cliente) hasta las 10:00 del día siguiente, para no perder entradas. Si se
   prefiere, al cerrar sesión se pueden marcar como "no se guardó".

## 6. Riesgos

- **Teléfono perdido o robado** con la app abierta: tiene la copia de la noche
  (nombres de quien falta por entrar, personas, RP) hasta el primer barrido
  después de las 08:00 (con la app cerrada no corre ningún barrido: se borra
  al volver a abrirla). No tiene QR, teléfonos ni consumos. La sesión de
  Supabase del teléfono sigue siendo el riesgo mayor (igual que hoy).
- **Reloj del teléfono mal puesto**: la copia vence según el reloj del
  teléfono (con la hora de vencimiento que da la base). Un reloj atrasado la
  conserva más tiempo; uno adelantado la borra antes. La base revisa la noche
  al enviar, así que un reloj mal puesto no deja entrar una reserva de otra
  noche.
- **Sin señal no hay validación central**: dos teléfonos sin señal pueden
  dejar pasar la misma reserva; al volver la señal la base la registra una
  vez y el segundo teléfono ve "ya había entrado". Una reserva creada después
  de la última copia no aparece sin señal.
- **Navegador sin IndexedDB** (modo privado): la cola queda en memoria; la
  pantalla lo avisa ("si cierras la app se pierde lo guardado").
- **`crypto.subtle`** solo existe en https o localhost: en Vercel sí; en una
  prueba por IP de la red local la cámara sin red no podría validar (lo
  dice).
- **Dev compartido**: varias corridas de este carril chocaron con
  `statement timeout` cuando otro carril tenía un `alter table` abierto. No
  es del código; reintentar.

## 7. Lo que NO se hizo

- No se cambiaron `puerta_escanear` ni `puerta_confirmar_entrada`.
- El escáner de **asistencia de RP** no tiene respaldo sin señal.
- La pantalla de confirmación justo después de reservar
  (`/cliente/reservar`) no muestra el código corto; solo el boleto `/r/…`.
- La app del RP no tiene nada sin señal (solo es instalable).
- No se probó en un teléfono físico (iPhone/Android): solo Chromium de
  Playwright con cámara falsa y `setOffline`. En iOS, `beforeunload` no
  avisa al cerrar la app instalada; el contador y `/offline.html` sí.
