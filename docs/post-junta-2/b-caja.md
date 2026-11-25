# Carril b-caja — B9: caja que no pierde nada sin internet

Rama `b-caja` (desde `post-junta-2`), etapas 1 y 2. Todo probado en
**antroapp-dev**. Producción no se tocó (ni lectura de datos ni escritura).
La etapa 2 (segunda pasada, 25/11/2026) está al final: [Etapa 2](#etapa-2-segunda-pasada-con-mala-señal-25112026).

## Qué problema resuelve

Antes, lo capturado sin señal vivía en la memoria de la hoja abierta: si el
staff cerraba la hoja, recargaba, el sistema mataba la PWA o se acababa la
batería, se perdía. Y con la red caída los botones decían "Sin conexión" y
no dejaban guardar.

Ahora **consumos y cobros se guardan primero en el teléfono** (IndexedDB) y
de ahí se mandan a la base. Sin señal se quedan en una cola y se mandan
solos al volver.

## Qué hice, por función

### 1. Cola persistente (`lib/caja-cola.ts`, `lib/domain/caja-cola.ts`)

- **Patrón "primero al teléfono"**: cada consumo (con o sin catálogo) y cada
  cobro se escribe en IndexedDB (`antroapp-caja`, almacén `pendientes`) antes
  de llamar a la base. Si la app muere a medio envío, el movimiento sigue ahí.
- **Qué se guarda por movimiento**: clave (= `p_clave`), usuario que lo
  capturó, antro, mesa, sesión, tipo, argumentos de la función (ids, montos,
  concepto y, en tarjeta, la referencia que escribió el staff), monto para
  mostrar, descripción ("2 × Cerveza", "Cobro en efectivo"), hora de captura,
  intentos, estado y motivo de rechazo.
- **Qué NO se guarda**: nombres ni teléfonos de clientes, correos, tokens ni
  la sesión. La prueba lo revisa sobre el contenido real de IndexedDB.
- **Solo se encolan las 3 funciones idempotentes**: `caja_registrar_consumo`,
  `caja_registrar_consumo_producto` (fase 2) y `caja_registrar_pago`. Abrir
  mesa, sentar, cerrar, cuadrar, anular, reabrir y cerrar la noche **siguen
  necesitando señal** (dependen del estado fresco de la mesa).
- **Por usuario**: solo se manda lo que capturó quien tiene la sesión. Otra
  persona que entre en el mismo teléfono no lo manda ni lo ve; cuando la
  primera vuelve a entrar, se manda.
- **Si el navegador no deja usar IndexedDB** (modo privado, almacenamiento
  bloqueado): cae a memoria y la caja avisa "no cierres la app hasta que se
  envíen".
- **Limpieza**: lo rechazado se borra al tocar "Entendido" o solo, a las 72 h.
  **Lo pendiente nunca se borra solo.**

### 2. Envío (`lib/use-cola-caja.ts`)

- Cuándo: al abrir la caja, al volver la red (`online`), al volver a la
  pantalla (`visibilitychange`), cuando la caja vuelve a leer bien después de
  un fallo (wifi sin salida) y con **espera creciente** si la red sigue
  fallando: 2 s, 4 s, 8 s… hasta 60 s, ±20 % al azar.
- **Uno a la vez en todo el navegador**: Web Locks (`navigator.locks`) entre
  pestañas, y candado en memoria dentro de la pestaña. Las pestañas se avisan
  por `BroadcastChannel`.
- **En orden de captura**: los consumos de una mesa entran antes que su cobro
  (así el saldo esperado del cobro cuadra).
- Para en el primer error de red o de sesión vencida (lo demás fallaría
  igual) y reintenta después. Solo manda con la sesión de quien capturó
  (`getSession`, sin red); si la sesión venció, la renueva antes.
- Al llegar algo a la base, la caja **vuelve a leer la noche antes de quitarlo
  de la vista**, para que el saldo no brinque.

### 3. Pantalla

- **Agregar consumo / Cobrar sin señal**: el botón dice "Guardar en el
  teléfono · $X" / "Guardar cobro $X" con la nota "Sin señal: se guarda en
  este teléfono y se envía solo al volver la señal". Al tocarlo se cierra la
  hoja con "Guardado en este teléfono. Se envía solo al volver la señal; no
  lo captures otra vez."
- **Respuesta perdida con señal** (la base guardó pero el teléfono no se
  enteró): igual, queda en la cola y se reintenta solo con la misma clave. Ya
  no hay que volver a tocar el botón.
- **Rechazo al momento** (con señal): el motivo se queda en la hoja, como
  antes (p. ej. "La mesa ya quedó pagada" del cobro doble).
- **Mesa**: los renglones pendientes salen con "· por enviar"; el saldo,
  consumo y cobrado de la mesa, y los totales de la noche, **incluyen lo
  pendiente** (es lo que el staff tiene enfrente y el saldo esperado de un
  cobro sin señal).
- **Mapa**: cada mesa marca "N por enviar" (ámbar) o "N sin guardar" (rojo).
- **Global**: "N movimientos por enviar" con el estado (guardados / enviando /
  reintentando) y "Enviar ahora".
- **Rechazos al sincronizar**: tarjeta roja "N movimientos no se guardaron"
  con mesa, movimiento, monto, hora de captura y motivo, más "Ver mesa" y
  "Entendido". **No se reintentan.** Motivos en palabras del piso: "La mesa ya
  está cuadrada.", "La mesa ya está cerrada (falta cuadrarla).", "La noche ya
  está cerrada.", "El saldo de la mesa cambió mientras cobrabas (ahora es
  $…)", "No tienes permiso para …: te lo quitaron o tu cuenta fue dada de
  baja.", "El cliente ya no está en esa mesa."
- **Sin conexión** (aviso de arriba): explica qué sí se puede hacer sin señal.
- **/offline.html** (al recargar o abrir la app sin señal): "Hay N
  movimientos de caja guardados en este teléfono. Se envían solos en cuanto
  vuelva la señal; no los captures otra vez." Solo lee el número; si la base
  local no existe, no la crea. Se recarga sola al volver la red y la caja
  manda la cola.
- **Cerrar sesión** en el panel de staff con pendientes: pregunta antes
  (los pendientes se quedan con ese usuario).

### 4. Service worker (`public/sw.js`)

Revisado: sigue **sin guardar en caché páginas, datos ni llamadas** a
Supabase o `/api`; solo `/offline.html`. Subí la versión a `antroapp-v3`
para que los teléfonos tomen la página sin conexión nueva.

### 5. Idempotencia en la base (comprobada, sin SQL nuevo)

Leí las funciones vigentes en dev (`pg_get_functiondef`) y lo comprobé con
sesiones reales:

- La clave se busca **antes** de revisar el estado de la mesa y los permisos:
  un reintento de algo que ya entró devuelve el mismo id aunque después la
  mesa se haya cuadrado (probado).
- Misma clave con otro monto: rechazo P0001 (probado).
- Dos envíos idénticos a la vez: el índice único `(registrado_por,
  clave_cliente)` y el `exception when unique_violation` devuelven el primero
  (probado con dos pestañas).
- La clave es por usuario: la de otro staff no estorba.

**No hice SQL** (los números 50–59 quedan libres): no hacía falta.

## SQL

Ninguno. Nada que aplicar en producción ni rollback.

Opcional (decisión 3 abajo): guardar la hora real de captura.

## Archivos

| Archivo | Qué |
|---|---|
| `lib/domain/caja-cola.ts` (nuevo) | Reglas puras: crear, ordenar, clasificar respuestas, motivos, espera, montos con pendientes |
| `lib/caja-cola.ts` (nuevo) | IndexedDB (con caída a memoria), candado, envío, avisos entre pestañas |
| `lib/use-cola-caja.ts` (nuevo) | Hook: cuándo mandar, enviar desde la hoja, descartar |
| `components/caja/cola-caja.tsx` (nuevo) | Aviso global y de la mesa |
| `app/staff/caja/page.tsx` | Cola, montos con pendientes, `clave_cliente` en las lecturas, aviso global |
| `components/caja/detalle-mesa.tsx` | Consumo y cobro por la cola; renglones por enviar; acciones que sí van sin señal |
| `components/caja/hojas-mesa.tsx` | "Guardar en el teléfono" sin señal |
| `components/caja/mapa-noche.tsx` | Marca por mesa |
| `components/caja/accion.tsx` | `fallar(mensaje)` para rechazos de la cola |
| `lib/domain/caja.ts` | `clave_cliente` opcional en consumos y pagos |
| `app/staff/panel/page.tsx` | Aviso al cerrar sesión con pendientes |
| `public/offline.html`, `public/sw.js` | Conteo de pendientes; versión v3 |
| `scripts/dev/probar-caja-cola-dominio.mjs` (nuevo) | Pruebas puras |
| `scripts/dev/probar-caja-sin-red.mjs` (nuevo) | Pruebas en navegador |
| `scripts/dev/probar-caja-multi.mjs` | Ajustado al comportamiento nuevo; datos `t_caja_` |

## Pruebas automáticas (resultados reales, 24/11/2026)

| Prueba | Contra | Resultado |
|---|---|---|
| `node scripts/dev/probar-caja-cola-dominio.mjs` | sin base | **37/37** |
| `probar-caja-sin-red.mjs` | `next dev` (webpack) + dev | **33/33** |
| `probar-caja-sin-red.mjs --fase2` | `next dev` con `NEXT_PUBLIC_FASE2=1` | **34/34** (2 de 3 corridas; ver abajo) |
| `probar-caja-multi.mjs` (ajustado) | `next dev` + dev | **16/16** |
| `probar-caja-sin-red.mjs` | **build de producción** (`servidor-prod-dev.mjs`) + dev | **33/33** |
| `probar-caja-multi.mjs` | **build de producción** + dev | **16/16** |
| `NEXT_DIST_DIR=.next-build npx next build` (llaves de dev) | — | **en verde**; `tsconfig.json` sin cambios |

Qué cubre `probar-caja-sin-red.mjs` (crea "T caja …", 4 cuentas
`t_caja_…@example.com`, 6 mesas; lo borra todo al final y confirma 0 restos):

1. Sin red: consumo y cobro se guardan en el teléfono; el saldo incluye lo
   pendiente; el cobro lleva `p_saldo_esperado` con lo pendiente; nada en la
   base; sin nombres, tokens ni correos en IndexedDB; aviso global y marca en
   el mapa.
2. **Recargar sin red**: sale `/offline.html` con "Hay 2 movimientos…"; la
   cola sigue.
3. **Vuelve la red**: se aplica **una sola vez** (2 consumos y 1 cobro) y 5 s
   después sigue igual.
4. Base: misma clave → mismo id; misma clave con otro monto → rechazo.
5. Respuesta perdida a mitad del envío → reintento automático → una vez.
6. **Dos pestañas** del mismo teléfono con la misma cola → una vez (1 envío).
7. **Dos teléfonos** sin red a la vez → cada consumo una vez.
8. **Mesa cuadrada** mientras no había señal → "La mesa ya está cuadrada.",
   no se guarda, **1 solo envío en 8 s** (sin bucle), queda "rechazado";
   "Entendido" lo quita.
9. Reintento de algo ya guardado **después de cuadrar** → devuelve el mismo.
10. **Saldo cambiado** (otro staff cobró) → rechazo con el saldo nuevo, 1
    solo envío, nunca con otro saldo.
11. **Permiso retirado** y **cuenta dada de baja** → rechazo con motivo, no se
    guarda.
12. **Otra persona** en el mismo teléfono no manda ni ve lo de la primera; al
    volver la primera, se manda una vez.
13. (`--fase2`) consumo del catálogo y cobro con propina sin red: una vez
    cada uno, existencias bajan una vez.

Capturas (390×844 y 360×740) en `screenshots-b-caja/` (ignorada por Git).

**Una falla intermitente**: en la primera corrida con `--fase2`, recién
levantado el servidor, al volver la red la cola no se mandó en 40 s (la
segunda y tercera corrida pasaron completas). No pude reproducirla. La prueba
ahora guarda `diag-vuelve-red.png` y la URL si vuelve a pasar. Sospecha: la
primera compilación de `next dev` tras reiniciar; queda como riesgo a vigilar.

**Una corrida interrumpida** (contra el build de producción, la primera) no
imprimió nada y dejó su antro y 4 cuentas `t_caja_` en dev: el proceso murió
sin llegar al `finally`. Los borré a mano y agregué
`node scripts/dev/probar-caja-sin-red.mjs --limpiar-restos` (borra solo antros
"T caja …" y cuentas `t_caja_…@example.com`). Dev quedó con 0 restos.

No corrí `probar-caja.mjs` (167), `probar-caja-concurrencia.mjs` (29) ni
`probar-carga-caja.mjs`: los dos primeros son de base y no cambié SQL; el de
carga no lo medí (el cálculo nuevo por mesa es una pasada lineal sobre la
cola, normalmente vacía). Los tres crean datos sin prefijo `t_caja_`.

## Pasos de prueba manual (clic a clic)

Usuario: `dev_staff@example.com` (contraseña en
`backups/dev-credenciales.json`) en la vista previa de esta rama o en local.
Esto escribe en la caja de Club Demo Dev: hazlo en una mesa de prueba.

**En el celular (lo más real):**

1. Entra con `dev_staff`, abre **Caja** y una mesa **abierta** con cliente.
2. Pon el teléfono en **modo avión**. Arriba sale "Sin conexión ·
   reconectando…".
3. Toca **Agregar consumo**, captura "Prueba sin red" a $10 y toca
   **Guardar en el teléfono · $10**. La hoja se cierra con "Guardado en este
   teléfono…" y el renglón dice "· por enviar". El saldo sube $10.
4. Toca **Cobrar $…** y luego **Guardar cobro $…**. Sale "· por enviar" en
   Cobros.
5. Regresa a las mesas: arriba "2 movimientos por enviar"; la mesa dice
   "2 por enviar".
6. **Cierra la app** por completo (quítala de recientes) y vuelve a abrirla,
   aún en modo avión: sale "Sin conexión" con "Hay 2 movimientos de caja
   guardados en este teléfono…".
7. Quita el modo avión. La página se recarga sola, abre la caja y en unos
   segundos desaparece "por enviar". Revisa la mesa: el consumo y el cobro
   están **una sola vez**.

**Rechazo por mesa cuadrada** (dos dispositivos: `dev_staff` en el
celular y `dev_gerente@example.com` en la compu):

1. Celular en modo avión, agrega un consumo a una mesa sin consumo previo.
2. En la compu, el gerente **cuadra** esa mesa (Cuadrar mesa).
3. Quita el modo avión. En el celular sale en rojo "1 movimiento no se
   guardó · La mesa ya está cuadrada." con **Ver mesa** y **Entendido**. En la
   base no entró. Toca **Entendido**.

**En la compu (Chrome)**: F12 → Network → "Offline" hace lo mismo que el
modo avión (paso 6: recargar con F5 estando en Offline).

## Decisiones pendientes para Diego

1. **Abrir la app sin señal**: hoy sale `/offline.html` (con el conteo) y no
   se puede seguir capturando hasta que vuelva la señal; lo ya capturado no
   se pierde. Para capturar con la app recién abierta sin señal habría que
   guardar en el teléfono la pantalla y los datos de la noche (mesas y
   nombres de clientes), lo que hoy `sw.js` prohíbe a propósito. Mi
   recomendación: dejarlo así.
2. **Cobros sin señal**: los dejé encolar (el efectivo ya está en la mano).
   Si otro staff cobra mientras tanto, la base lo rechaza por saldo y se
   muestra; nunca se cobra doble. ¿Prefieres que sin señal solo se permitan
   consumos?
3. **Hora real de captura**: lo que llega tarde queda con la hora del
   servidor (`registrado_en`), no la del teléfono. Si importa para la
   bitácora, propongo SQL aditivo (parámetro `p_capturado_en` guardado en
   `caja_eventos`, con su rollback). No lo hice: cambia la firma de las tres
   funciones de dinero.
4. **Fase 2, precio del catálogo**: un consumo del catálogo capturado sin
   señal se cobra con el precio que tenga el producto **al llegar** a la
   base. Si el precio cambió entre medio, el saldo esperado del cobro no
   cuadra y ese cobro se rechaza (visible). ¿Así está bien?
5. **Pendientes de una cuenta dada de baja** pasan a rechazados ("No se
   envió: tu cuenta fue dada de baja.") y vencen a las 72 h. Esto vale tanto
   si la baja llega con la caja abierta (la base rechaza el envío) como si
   la persona vuelve a abrir la app después (se marcan antes de cerrarle la
   sesión; corregido en la etapa 3, ver abajo). Nadie más los puede mandar.

## Riesgos

- **Archivos compartidos con otros carriles**: `detalle-mesa.tsx`,
  `hojas-mesa.tsx`, `app/staff/caja/page.tsx`, `mapa-noche.tsx`,
  `accion.tsx`, `app/staff/panel/page.tsx` (solo `handleLogout` y un import).
  Al integrar, revisar choques.
- **Comportamiento distinto en respuesta perdida**: antes la hoja se quedaba
  abierta con "No hubo respuesta…"; ahora se cierra y se reintenta sola. La
  prueba `probar-caja-multi.mjs` se ajustó a eso.
- **Teléfono sin IndexedDB** (modo privado de algunos navegadores): la cola es
  solo de memoria; se avisa en pantalla.
- **Falla intermitente** descrita arriba (1 de 3 corridas con servidor recién
  levantado).
- La lectura de la caja ahora pide `clave_cliente` (existe en producción
  desde el pase 1, paso 7b). **Desde b-caja, el rollback del paso 7b
  (`sql/2026-11-21-caja-idempotencia-rollback.sql`) exige revertir también el
  código** (ver "Etapa 3", punto 10).

## Notas de entorno

- En este worktree `node_modules` es un enlace a la carpeta principal y
  **Turbopack se niega a arrancar** ("Symlink node_modules is invalid").
  `scripts/dev/servidor-dev.mjs` falla aquí; usé el mismo arranque sin
  `--turbopack` (webpack) desde un script en el scratchpad. No cambié
  `servidor-dev.mjs`.

---

## Etapa 2: segunda pasada con mala señal (25/11/2026)

Revisé mi propia cola pensando en un staff en plena noche: batería baja,
cambiar de app, dos staff sobre la misma mesa, reloj del teléfono mal, sesión
que vence o se cierra con pendientes, cerrar sesión con pendientes y otra
persona usando el mismo teléfono. La etapa se cortó a las 23:40 por el límite
de uso. Revisé el commit PARCIAL que hizo el coordinador
(`3bf5d61`), lo probé y lo completé. **Sin SQL nuevo** (50–59 siguen libres).

### Qué encontré y qué cambié, por caso

| Caso | Qué pasaba | Qué hace ahora | Dónde |
|---|---|---|---|
| **Cerrar o cuadrar con movimientos aún en el teléfono** (el más grave) | El saldo de la mesa ya incluye lo pendiente. Con un consumo y su cobro todavía en el teléfono, el saldo daba $0 y aparecía "Cuadrar mesa". La base cerraba la mesa sin ellos y al llegar los rechazaba: **un consumo que nunca se cobra o un cobro que no aparece** | Mientras el grupo tenga algo por enviar desde este teléfono, en lugar de "Cuadrar/Cerrar mesa" sale "Para cerrar o cuadrar, primero tiene que llegar a la base…" con **Enviar ahora · N movimientos por enviar**. "Solo cerrar" no aparece. `cerrarMesa()` y `cuadrar()` también lo revisan | `detalle-mesa.tsx` |
| **Reloj del teléfono desfasado** | El orden de envío salía del reloj. Si el reloj se atrasaba entre el consumo y el cobro, el cobro salía primero y la base lo rechazaba por saldo | El orden nunca baja: es el mayor entre el reloj y lo último de la cola, más uno (`ordenDeCaptura`, del commit parcial). Probado con el reloj del navegador 2 h adelantado y luego corregido | `lib/domain/caja-cola.ts` |
| **Otra cuenta en otra pestaña con pendientes** | El commit parcial ya mandaba la cola con el token fijo de quien capturó y revisaba la sesión antes de cada envío. **Pero la pantalla no lo usaba**: la caja seguía abierta con la sesión de la otra persona (sus lecturas y botones de abrir, cerrar o cuadrar irían a su nombre) | La caja se tapa con "Entró otra cuenta en este teléfono", dice cuántos movimientos tuyos siguen guardados y ofrece "Abrir la caja con la cuenta de ahora". La otra cuenta ve solo el número: "Hay N movimientos de caja de otra cuenta…" | `page.tsx`, `cola-caja.tsx` (`AvisoSesionCaja`) |
| **La sesión se cierra o vence sin poder renovarse, con pendientes** | Salía "No pudimos cargar la caja. Revisa tu conexión" y la cola reintentaba en silencio | Tarjeta "Tu sesión se cerró" con el número de movimientos guardados y "Entrar otra vez". Lo pendiente sigue *pendiente* (no se rechaza ni se borra) y se manda al volver a entrar | `page.tsx`, `cola-caja.tsx` |
| **Token vencido a media cola** (401) | Del commit parcial: renueva el token y reintenta | Sin cambios; ahora probado (se renueva, entra una vez, no dice "sesión cerrada") | `use-cola-caja.ts` |
| **Cerrar sesión con pendientes** | Ya preguntaba antes (etapa 1) | Igual, probado. Con señal mala, `getSession` y `signOut` tienen un límite (3 s y 8 s) para que el botón no se quede colgado. Comprobé que auth-js 2.110 borra la sesión del teléfono aunque el servidor no conteste (probado sin red) | `app/staff/panel/page.tsx` |
| **Dos staff sobre la misma mesa** | El rechazo decía solo el motivo ("La mesa ya está cuadrada.") | Además: "No quedó en la cuenta de la mesa. Avísale a tu gerente antes de volver a capturarlo o de cobrarlo." | `cola-caja.tsx` |
| **Batería baja / cambiar de app** | Del commit parcial: IndexedDB reabre la conexión si el sistema la cierra (iOS), escrituras `durability: "strict"` y `navigator.storage.persist()` | Además se reintenta al volver del caché de atrás/adelante (`pageshow`) y cuando Chrome descongela la pestaña (`resume`) | `use-cola-caja.ts` |
| **Mala señal que no contesta** | Del commit parcial: cada envío se corta a los 15 s; la hoja espera 8 s y se cierra con "guardado en el teléfono" | Sin cambios; cubierto por las pruebas | `use-cola-caja.ts` |
| **Rendimiento con la cola llena** | Cada reintento fallido reescribe la cola (`intentos + 1`) y la caja volvía a pintar las 50 mesas. Con 40 pendientes y la señal fallando, buscar una mesa tardaba 1,092 ms (contra 299 ms con la cola vacía) y capturar sin red 697 ms | La caja solo se vuelve a pintar si cambia algo visible de la cola (firma por clave, estado y motivo). El mapa de mesas está en `memo`. Con 40 pendientes, buscar tarda 178–220 ms y capturar sin red 147–181 ms | `use-cola-caja.ts`, `mapa-noche.tsx` |
| Marca del mapa a 360 px | "Mesa 2 ⚠ 1 sin guardar" partía el nombre de la mesa en dos renglones | El nombre de la mesa no se parte; la marca se recorta con "…" (el nombre accesible la trae completa) | `mapa-noche.tsx` |

### SQL

Ninguno. Nada que aplicar en producción ni rollback.

### Pruebas automáticas (resultados reales, 25/11/2026)

| Prueba | Contra | Resultado |
|---|---|---|
| `node scripts/dev/probar-caja-cola-dominio.mjs` (+15 casos: reloj, sesión, tiempo límite) | sin base | **52/52** |
| `probar-caja-noche-mala.mjs` (nueva) | `next dev` (webpack) + dev | **21/21** |
| `probar-caja-noche-mala.mjs` | **build de producción** + dev | **21/21** |
| `probar-caja-sin-red.mjs` (regresión) | `next dev` + dev | **33/33** |
| `probar-caja-sin-red.mjs` | build de producción + dev | **33/33** |
| `probar-caja-multi.mjs` (regresión) | `next dev` + dev | **16/16** |
| `probar-caja-multi.mjs` | build de producción + dev | **16/16** |
| `probar-carga-caja-cola.mjs` (nueva, 3 corridas) | build de producción + dev | 41/41 entran una vez; medidas abajo; `verificar-cuadre` sin diferencias |
| `npx tsc --noEmit`, `npx eslint` de lo tocado | — | limpios |
| `NEXT_DIST_DIR=.next-build npx next build` (llaves de dev) | — | **en verde**; `tsconfig.json` sin cambios |

Qué cubre `probar-caja-noche-mala.mjs` (crea "T caja …" y 4 cuentas
`t_caja_…`; borra todo al final, 0 restos):

1. Reloj 2 h adelantado al capturar el consumo y corregido antes del cobro:
   el cobro queda después en la cola; al volver la señal entran los dos, una
   vez, y el cobro (con su saldo esperado) no se rechaza.
2. Dos staff sobre la misma mesa: B cobra y el gerente cuadra mientras A no
   tiene señal; A ve "1 movimiento no se guardó" con motivo y "Avísale a tu
   gerente"; no entra.
3. Gerente con un cobro en el teléfono: no aparece "Cuadrar mesa" ni "Solo
   cerrar", sin señal ni con la señal fallando; sí "Enviar ahora". Se ve
   "Enviando…". Cuando llega, aparece "Cuadrar mesa". **0 llamadas** a cerrar
   o cuadrar mientras tanto.
4. 401 "JWT expired" en el primer envío: 1 renovación, entra una vez, sin la
   tarjeta de sesión cerrada.
5. Otra cuenta (D) entra en otra pestaña: la caja de A se tapa; **0 envíos**
   con la sesión de D; al reabrir, D ve solo "Hay 1 movimiento de caja de
   otra cuenta"; cuando A vuelve, entra una vez y a nombre de A.
6. Sesión cerrada con pendientes: tarjeta "Tu sesión se cerró" con el número;
   el movimiento sigue *pendiente*; al volver a entrar, una vez.
7. Cerrar sesión con pendientes: pregunta; "Cancelar" no cierra; "Aceptar"
   cierra y lo pendiente se queda; se manda al volver. **Sin señal**, cerrar
   sesión sí borra la sesión del teléfono (0 cookies de sesión).
8. Pestaña "congelada" (CDP `Page.setWebLifecycleState`) mientras vuelve la
   señal: entra una vez. **Ojo:** el Chromium de prueba no congeló de verdad
   una pestaña visible (mandó antes de "despertarla"), así que esto solo
   prueba que no se duplica, no el evento `resume`.

**Medidas con CPU 4× (build de producción, 50 mesas, 1,150 movimientos)**,
`probar-carga-caja-cola.mjs`. Antes = primera corrida, antes de la firma y el
`memo`; después = dos corridas con los cambios.

| | Cola vacía (después) | 40 por enviar, antes | 40 por enviar, después |
|---|---|---|---|
| Carga de /staff/caja | 3.7–5.3 s | 4.1 s | 3.7–7.7 s (variación de red: la otra corrida dio 3.7 s, igual que vacía) |
| Abrir una mesa | 134–149 ms | 299 ms | 111–136 ms |
| Volver al mapa | 107–137 ms | 298 ms | 117–167 ms |
| Cambiar filtro | 114–121 ms | 207 ms | 111–132 ms |
| Búsqueda (sin contar el tecleo) | 145–149 ms | **1,092 ms** | 178–220 ms |
| Tareas largas al interactuar (máx.) | 1 (55–71 ms) | 4 (151 ms) | 1–2 (59–69 ms) |
| Scroll del mapa | 16 ms/cuadro, 0 lentos | igual | igual |
| Revisión periódica (12 s) | 0–1 consulta | 1 | 1 |
| Capturar un consumo sin red (tocar "Guardar" → hoja cerrada) | — | 697 ms | 147–181 ms |
| Vaciar 41 al volver la señal | — | 6.2 s | 5.0–5.3 s (~125 ms por movimiento, uno a la vez, 0 tareas largas) |

Capturas a 360 px en `screenshots-b-caja/` (ignorada por Git, lo comprobé
con `git check-ignore`). Las revisé todas:

- Sin red: `10-sin-red-mesa-360.png` (mesa con "· por enviar" y el aviso de
  que no se puede cuadrar todavía) y `11-sin-red-mapa-360.png`.
- Sincronizando: `13-cuadrar-espera-envio-360.png` ("Enviar ahora · 1
  movimiento por enviar") y `14-sincronizando-mapa-360.png` ("Enviando…").
- Rechazado: `12-rechazado-mapa-360.png` (con "Avísale a tu gerente").
- Sesión: `15-otra-cuenta-360.png`, `16-pendientes-de-otra-cuenta-360.png` y
  `17-sesion-cerrada-360.png`.
- Carga: `20-…-390.png` y `20b-carga-50-mesas-40-por-enviar-360.png`.

**No volví a correr** `probar-caja-sin-red.mjs --fase2` (necesita el servidor
con `NEXT_PUBLIC_FASE2=1`). Lo que cambié no toca el catálogo ni la propina,
pero no está comprobado con la bandera prendida.

### Pasos de prueba manual (etapa 2)

Usuarios: `dev_staff@example.com` y `dev_gerente@example.com` (contraseña en
`backups/dev-credenciales.json`), en la vista previa de la rama o en local.
Escribe en la caja de Club Demo Dev: usa una mesa de prueba.

**No deja cuadrar con algo en el teléfono** (gerente, en el celular):

1. Entra con `dev_gerente`, abre **Caja** y una mesa abierta con consumo.
2. Modo avión. Toca **Cobrar $…** → **Guardar cobro $…**.
3. El saldo queda en $0, pero abajo **no** sale "Cuadrar mesa". Sale "Para
   cerrar o cuadrar, primero tiene que llegar a la base el movimiento…" y el
   botón gris "Sin conexión · 1 movimiento por enviar". En "⋯" no está "Solo
   cerrar".
4. Quita el modo avión. En unos segundos el cobro pierde "· por enviar" y
   aparece **Cuadrar mesa**.

**Otra cuenta en el mismo teléfono** (Chrome en la compu, dos pestañas):

1. Pestaña 1: entra con `dev_staff`, abre Caja y una mesa.
2. F12 → Network → **Offline**. Agrega un consumo ($10): "Guardado en este
   teléfono".
3. Pestaña 2: abre `/cliente/login` y entra con `dev_gerente`.
4. Pestaña 1: quita Offline. Sale "Entró otra cuenta en este teléfono" con
   "Tienes 1 movimiento de caja guardado…". En la base **no** entra (revisa
   la mesa en la pestaña 2).
5. Toca "Abrir la caja con la cuenta de ahora": la caja del gerente dice "Hay
   1 movimiento de caja de otra cuenta…".
6. Cierra sesión y entra otra vez con `dev_staff`, abre Caja: el consumo
   entra una vez, a nombre de `dev_staff`.

**Sesión cerrada con pendientes:**

1. Con `dev_staff` en Caja, Offline, agrega un consumo.
2. F12 → Application → Cookies → borra las `sb-…-auth-token`.
3. Quita Offline: sale "Tu sesión se cerró" con "Tienes 1 movimiento…".
4. "Entrar otra vez", entra con `dev_staff`, abre Caja: entra una vez.

**Reloj** (opcional, en el celular): con un consumo sin enviar, cambia la hora
del teléfono una hora atrás, cobra sin señal y regresa la hora automática;
al volver la señal entran el consumo y el cobro sin rechazo.

### Decisiones pendientes para Diego (etapa 2)

6. **Cuadrar mientras OTRO teléfono tiene pendientes de esa mesa.** Lo de
   este teléfono ya bloquea el cuadre; lo de otro teléfono sin señal no se
   puede saber. Si el gerente cuadra, ese consumo llega después, se rechaza
   ("La mesa ya está cuadrada.") y el staff ve "Avísale a tu gerente". Como
   una mesa cuadrada no se reabre, se tendría que cargar en otro grupo. ¿Te
   parece bien así o prefieres que la base permita un "consumo tardío" con
   motivo sobre una mesa cuadrada (eso sí sería SQL nuevo y cambia la regla
   de "lo cuadrado no se modifica")? Mi recomendación: dejarlo así.
7. **Tapar la caja cuando entra otra cuenta** en otra pestaña: es lo más
   seguro (nada a nombre de otro), pero si dos personas comparten un
   teléfono a propósito, la primera tiene que recargar. ¿Así está bien?
8. Cerrar sesión sigue siendo `signOut()` global (cierra la sesión en todos
   los dispositivos de esa persona), como antes. No lo cambié.

### Riesgos (etapa 2)

- **Reloj muy adelantado** (más de una hora): auth-js cree que el token
  venció y lo renueva en cada `getSession`. La cola lo llama antes de cada
  envío, así que con el reloj así manda el doble de peticiones. Funciona,
  pero es más lento. No lo medí.
- **Pestaña congelada y conexión de IndexedDB cerrada por el sistema**: el
  código reabre y reintenta, pero Playwright no puede reproducir el cierre
  real de iOS ni el congelado de una pestaña visible. Falta probarlo en un
  iPhone y un Android reales (pasos manuales de la etapa 1, con la app en
  segundo plano unos minutos).
- `durability: "strict"` y `storage.persist()` no se pueden comprobar en
  pruebas; con apagón por batería puede perderse lo último en un navegador
  que no los respete.
- Archivos compartidos con otros carriles (más que en la etapa 1):
  `app/staff/panel/page.tsx` (solo `handleLogout` y un import),
  `mapa-noche.tsx` (ahora `memo`), `detalle-mesa.tsx`, `page.tsx` de caja.

### Archivos de la etapa 2

| Archivo | Qué |
|---|---|
| `components/caja/detalle-mesa.tsx` | No cerrar ni cuadrar con pendientes del grupo; "Enviar ahora" |
| `components/caja/cola-caja.tsx` | `AvisoSesionCaja` (otra cuenta / sesión cerrada), pendientes de otra cuenta, qué hacer con un rechazo |
| `app/staff/caja/page.tsx` | Tapa la caja según la sesión; pasa `deOtraCuenta` y `onEnviarAhora` |
| `components/caja/mapa-noche.tsx` | `memo`; marca que no parte el nombre de la mesa |
| `lib/use-cola-caja.ts` | Firma para no repintar en cada reintento; `pageshow` y `resume` (más lo del commit parcial: token fijo, sesión, límites de tiempo) |
| `lib/caja-cola.ts`, `lib/domain/caja-cola.ts` | Del commit parcial (`3bf5d61`), revisados y probados |
| `app/staff/panel/page.tsx` | Límite de tiempo al cerrar sesión con señal mala |
| `scripts/dev/probar-caja-cola-dominio.mjs` | +15 casos (52) |
| `scripts/dev/probar-caja-noche-mala.mjs` (nuevo) | Los 8 casos de arriba en el navegador (21) |
| `scripts/dev/probar-carga-caja-cola.mjs` (nuevo) | Carga con CPU 4× y 40 pendientes, datos `t_caja_` |

---

## Etapa 3: correcciones de la revisión adversarial (25/11/2026)

El revisor encontró 10 defectos en el carril (HEAD `3bf5d61` frente al árbol
de trabajo). Los verifiqué uno por uno contra el código: **los 10 eran
reales**. Todo queda en el árbol de trabajo, sin commit (lo hace el
coordinador). **Sin SQL nuevo** (50–59 siguen libres).

| # | Gravedad | Defecto | Qué hice | Dónde |
|---|---|---|---|---|
| 1 | alto | Se podía cerrar o cuadrar con movimientos del grupo en la cola: la hoja decía "Cuadrar mesa · $700" (con lo pendiente), la base cuadraba con $500 y al llegar rechazaba el resto | El arreglo de la etapa 2 (sin "Cuadrar", "Cerrar" ni "Solo cerrar" mientras haya pendientes del grupo; "Enviar ahora" en su lugar; `cerrarMesa()` y `cuadrar()` también lo revisan) queda completo, y además: la hoja de cuadrar recibe **los montos de la base** (`consumoEnBase`, `cobradoEnBase`, sin lo pendiente) y se bloquea ("Esperando el envío") si llega un pendiente con la hoja abierta; "Enviar ahora" dice "Enviando…" mientras se manda. **Al probarlo encontré otro hueco**: al terminar de mandar, la cola quitaba lo enviado de la vista ANTES de que la caja volviera a leer la base, y por un momento la mesa mostraba los montos viejos (la hoja abrió con "$500" con la base ya en $700). Ahora, mientras una pasada manda, sus propios avisos no refrescan la vista; refresca al final, después de releer la base | `detalle-mesa.tsx`, `hojas-mesa.tsx`, `lib/use-cola-caja.ts` (`pasando`) |
| 2 | medio | `clasificar()` daba por rechazados errores pasajeros con código (PGRST000–003, 53300, 55P03, 08xxx…) | Pasajeros conocidos (PGRST000–003, 53000, 53300, 55P03, 57014, 57P01–03, 40001, 40P01 y todo 08xxx) se reintentan **siempre**, como la red. Un 5xx/408/429 con código desconocido (p. ej. XX000) y PGRST202 se reintentan **hasta 10 veces** (`MAX_INTENTOS_DUDOSOS`, unos 5 min con la espera creciente) y luego se rechazan con el motivo genérico: sin tope, uno roto frenaría la cola entera detrás. Los fallos de red no cuentan para ese tope (campo nuevo `intentosDudosos`, opcional). Rechazo inmediato solo para P0001, 42501/403 y los 4xx de verdad | `lib/domain/caja-cola.ts`, `lib/caja-cola.ts` |
| 3 | medio | La cola solo salía con la Caja abierta; la app instalada abre en `/staff/panel` | `EnvioColaStaff` en `app/staff/layout.tsx`: en todas las pantallas de staff menos la Caja (que monta la suya) manda la cola con las mismas reglas y muestra "Caja: N movimientos por enviar · Abrir caja" (y "N no se guardaron · Ver"). Textos de `/offline.html` corregidos ("se envían solos cuando vuelva la señal y la app de staff esté abierta con tu cuenta"); `sw.js` a `antroapp-v4` para que el teléfono tome la página nueva | `components/caja/envio-cola-staff.tsx` (nuevo), `app/staff/layout.tsx`, `public/offline.html`, `public/sw.js` |
| 4 | medio | La etapa 2 no estaba en ningún commit | Terminada, probada y documentada aquí (sección "Etapa 2" de arriba más esta). El commit lo hace el coordinador: el sistema me bloquea `git commit` | — |
| 5 | bajo | Con sesión vencida u otra cuenta, el aviso decía "La señal sigue fallando" | Ya resuelto en la etapa 2 (sin commit): con la sesión ajena la caja se tapa con `AvisoSesionCaja` ("Tu sesión se cerró" / "Entró otra cuenta…") y `AvisoCola` no se muestra. Lo comprueba `probar-caja-noche-mala.mjs` (casos 5 y 6) | `page.tsx`, `cola-caja.tsx` |
| 6 | bajo | "Por cobrar" de la noche sumaba pendientes de mesas cerradas, cuadradas o de otra noche | Los totales suman solo lo pendiente de una sesión **abierta** de la noche cargada, la misma regla que las mesas | `app/staff/caja/page.tsx` |
| 7 | bajo | Un staff dado de baja que vuelve a abrir la app: sus pendientes se quedaban para siempre como "de otra cuenta… se envían cuando vuelva a entrar" | `cerrarSesionDadoDeBaja(…, { colaCaja: true })` marca sus pendientes como rechazados ("No se envió: tu cuenta fue dada de baja.") antes de cerrar la sesión (caja, panel, nómina y equipo del gerente). Además, los pendientes de **otra** cuenta con más de 72 h pasan a rechazados ("…pasaron más de 72 horas sin que volvieras a entrar…") y desde ahí vencen en otras 72 h. Lo propio nunca vence por esta regla: se manda y la base decide | `lib/cuenta-dada-de-baja.ts`, `lib/caja-cola.ts` (`rechazarPendientesDe`, `leerCola`), `lib/domain/caja-cola.ts` |
| 8 | bajo | Las pruebas de "una sola vez" solo contaban filas (la clave absorbe reenvíos) | Paso 1: cuenta las peticiones a `caja_registrar_*` en los 5 s después de vaciar y exige 0. Paso 4a: exige exactamente 1 envío. Paso nuevo 7b también cuenta (1 envío desde el panel) | `probar-caja-sin-red.mjs` |
| 9 | bajo | `--limpiar-restos` borraba todo "T caja %" sin TAG y sin `reservations`/`commissions` | `--tag=<TAG>` borra solo esa corrida; sin `--tag`, solo corridas cuyas cuentas tienen más de `--minutos` (120 por omisión, mínimo 30). Mismo orden que `limpiar()`, con `reservations` y `commissions`, en una transacción con rollback si falla. Probado: con una corrida recién cortada, sin `--tag` borró 0 y con `--tag` 1 antro y 5 cuentas; `--minutos=10` se niega | `probar-caja-sin-red.mjs` |
| 10 | bajo | El código ya no funciona con el rollback del paso 7b | **Documentado** (no restauré el respaldo sin `p_clave`: un envío sin clave sí puede duplicar dinero). Ver la nota para `docs/pase-produccion.md` abajo. Además PGRST202 ya no se rechaza al primer intento: se reintenta hasta 10 veces (cubre los segundos en que PostgREST recarga el esquema durante un pase) | este documento, `lib/domain/caja-cola.ts` |

### Para `docs/pase-produccion.md` (lo integra el coordinador)

> **Desde b-caja, el rollback del paso 7b
> (`sql/2026-11-21-caja-idempotencia-rollback.sql`) exige revertir también el
> código.** La caja lee `clave_cliente` de `caja_consumos` y `caja_pagos` (sin
> esa columna no carga) y la cola de caja manda siempre `p_clave` (sin las
> funciones con ese parámetro, cada consumo o cobro vuelve con PGRST202, se
> reintenta unos 5 min y luego se marca "no se guardó"). Orden si hubiera que
> deshacer el 7b: primero regresar el código a una versión sin b-caja,
> después el SQL.

### SQL

Ninguno. Nada que aplicar en producción ni rollback.

### Pruebas automáticas (resultados reales, 25/11/2026)

Servidor: build de producción (`next build` con `NEXT_DIST_DIR=.next-build`
y las variables de `.env.dev`, `next start -p 3025`) contra antroapp-dev.

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-caja-cola-dominio.mjs` (+28 casos: pasajeros, dudosos con tope, 4xx, ajenos vencidos, motivo de baja) | **80/80** |
| `probar-caja-sin-red.mjs` (+8 casos: 5e baja con la caja cerrada, 7 cerrar/cuadrar con pendientes, 7b fuera de la caja, conteo de envíos en 1 y 4a) | **41/41** (la primera corrida dio 40/41: así encontré el hueco de la vista que se refrescaba antes de releer la base; arreglado y vuelto a correr dos veces en 41/41) |
| `probar-caja-sin-red.mjs --fase2` (build aparte con `NEXT_PUBLIC_FASE2=1`) | **42/42** |
| `probar-caja-noche-mala.mjs` | **21/21** (dos veces: con el build del arreglo de la vista y con el build final) |
| `probar-caja-multi.mjs` | **16/16** con el build del arreglo de la vista. La corrida contra el build final (que solo cambia un texto del aviso del panel) iba en verde 11 de 16 casos cuando cerré este reporte; no la vi terminar |
| `probar-carga-caja-cola.mjs` (CPU 4×, 50 mesas, 1,150 movimientos) | 41 de 41 entran una vez; `verificar-cuadre` sin diferencias; medidas abajo |
| `npx tsc --noEmit`, `npx eslint` de los archivos tocados | sin errores |
| `next build` (`.next-build`, variables de `.env.dev`) | sin errores (`tsconfig.json` revertido después) |

Medidas con CPU 4× después de los cambios: cola vacía, carga 5.9 s, abrir
mesa 144 ms, búsqueda 253 ms; con 40 por enviar, carga 4.8 s, abrir mesa
139 ms, búsqueda 187 ms, 0 tareas largas en la revisión periódica; capturar
sin red 127 ms; vaciar 41 = 4.5 s (109 ms por movimiento). **Cambio
visible**: el aviso "N por enviar" ahora se va cuando la caja ya releyó la
base (9.0 s con CPU 4× para 41 movimientos), no uno por uno mientras se
mandan; mientras tanto dice "Enviando…". Es el precio de no mostrar montos
viejos.

Una corrida de `probar-caja-sin-red.mjs` se cortó por un fallo de DNS del
equipo (`getaddrinfo ENOTFOUND …pooler.supabase.com`) y no pudo limpiar: la
limpié con `--limpiar-restos --tag=84eefc` (1 antro, 5 cuentas; después 0
restos `t_caja_` en dev).

Capturas nuevas (revisadas): `09-…-390.png` y `09b-cuadrar-espera-envio-360.png`
(mesa con $200 y $200 por enviar: "Para cerrar o cuadrar, primero tienen que
llegar a la base los 2 movimientos…" y "Enviar ahora · 2 movimientos por
enviar"); `21-…-390.png` y `21b-panel-aviso-cola-360.png` (panel con "Caja: 1
movimiento por enviar · Abrir caja").

### Pasos de prueba manual (etapa 3)

Usuarios: `dev_gerente@example.com` y `dev_staff@example.com` (contraseña en
`backups/dev-credenciales.json`). Usa una mesa de prueba de Club Demo Dev.

**No deja cuadrar con algo en el teléfono** (gerente, Chrome en la compu):

1. Entra con `dev_gerente`, abre **Caja** y una mesa abierta ya saldada
   (saldo $0): abajo dice "Cuadrar mesa".
2. F12 → Network → **Offline**. Agrega un consumo de $200 y cobra el saldo
   ($200): las dos filas dicen "· por enviar".
3. Abajo **no** está "Cuadrar mesa" y en "⋯" no está "Solo cerrar": sale
   "Para cerrar o cuadrar, primero tienen que llegar a la base los 2
   movimientos…" y "Sin conexión · 2 movimientos por enviar".
4. Quita Offline y toca **Enviar ahora** (o espera): pasa a "Enviando…" y
   luego vuelve "Cuadrar mesa". Ábrelo: la hoja dice el total con los $200.

**La cola sale desde el panel** (staff):

1. Entra con `dev_staff`, abre **Caja** y una mesa abierta. Offline. Agrega un
   consumo de $10.
2. Ve a `/staff/panel`: sale "Sin conexión" con "Hay 1 movimiento de caja
   guardado… con la app de staff abierta con la cuenta que los capturó".
3. Quita Offline: la página se recarga sola en el panel y, **sin entrar a la
   Caja**, el consumo entra (revísalo en la Caja). Mientras no entra, arriba
   del panel dice "Caja: 1 movimiento por enviar · Abrir caja".

**Cuenta dada de baja con pendientes** (un staff de prueba propio, no
`dev_staff`):

1. Con el staff de prueba en la Caja, Offline, agrega un consumo y cierra la
   pestaña.
2. Desde el panel del gerente, da de baja a ese staff.
3. Abre otra pestaña en `/staff/caja`: sale al login con el aviso de cuenta
   desactivada. En F12 → Application → IndexedDB → `antroapp-caja` →
   `pendientes`, el movimiento dice `estado: "rechazado"` y el motivo "No se
   envió: tu cuenta fue dada de baja.".

### Decisiones pendientes para Diego (etapa 3)

9. **Tope de reintentos para errores dudosos** (5xx con código desconocido y
   PGRST202): 10 intentos, unos 5 minutos, y luego "no se guardó". Más alto
   aguanta un pase o una caída larga sin perder la captura; más bajo libera
   antes la cola. ¿Te parece bien 10?
10. **Pendientes de otra cuenta a las 72 h** pasan a "no se guardó" (antes
    se quedaban para siempre). Si quien los capturó vuelve después de eso,
    los ve como rechazados con el motivo y su gerente decide. ¿72 h está bien?
11. El aviso "Caja: N por enviar" aparece en todas las pantallas de staff
    menos la Caja (también nómina, equipo y catálogo). ¿Lo quieres solo en
    el panel?

### Riesgos (etapa 3)

- **El aviso "N por enviar" tarda más en irse** (se va cuando la caja releyó
  la base, no uno por uno). Con señal buena y pocos movimientos son 1–2 s.
- **Pendientes de otro teléfono** (otro staff sin señal) siguen sin poder
  bloquear el cuadre: es la decisión 6 de la etapa 2.
- La cola ahora también corre en `/staff/panel`, `/staff/nomina`,
  `/staff/equipo` y `/staff/catalogo`: cada pantalla de staff abre IndexedDB y
  escucha la sesión. No medí su costo en el panel.
- Archivos compartidos con otros carriles, nuevos en esta etapa:
  `app/staff/layout.tsx`, `lib/cuenta-dada-de-baja.ts` (tercer parámetro
  opcional; las llamadas viejas siguen igual), `app/staff/nomina/page.tsx` y
  `components/equipo/pantalla-equipo.tsx` (una línea cada uno),
  `public/offline.html` y `public/sw.js` (versión v4).

### Archivos de la etapa 3

| Archivo | Qué |
|---|---|
| `components/caja/detalle-mesa.tsx` | Montos de la base para la hoja de cuadrar; "Enviando…" |
| `components/caja/hojas-mesa.tsx` | `HojaCuadrar` con `bloqueo` |
| `components/caja/envio-cola-staff.tsx` (nuevo) | La cola fuera de la Caja, con su aviso |
| `app/staff/layout.tsx` | Monta `EnvioColaStaff` |
| `app/staff/caja/page.tsx` | Totales con la regla de las mesas; `enviandoCola`; baja con `colaCaja` |
| `app/staff/panel/page.tsx`, `app/staff/nomina/page.tsx`, `components/equipo/pantalla-equipo.tsx` | Baja con `colaCaja` |
| `lib/domain/caja-cola.ts` | `clasificar()` con pasajeros y dudosos; ajenos vencidos; motivos |
| `lib/caja-cola.ts` | `intentosDudosos`; `rechazarPendientesDe`; ajenos vencidos en `leerCola` |
| `lib/use-cola-caja.ts` | No refrescar la vista a media pasada; leer la cola antes de contar |
| `lib/cuenta-dada-de-baja.ts` | Opción `colaCaja` |
| `public/offline.html`, `public/sw.js` | Texto que no promete de más; caché v4 |
| `scripts/dev/probar-caja-cola-dominio.mjs` | 80 casos |
| `scripts/dev/probar-caja-sin-red.mjs` | Casos 5e, 7, 7b; conteo de envíos; `--limpiar-restos` con TAG o antigüedad |
