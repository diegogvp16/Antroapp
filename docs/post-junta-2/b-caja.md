# Carril b-caja — B9: caja que no pierde nada sin internet

Rama `b-caja` (desde `post-junta-2`), etapa 1 de 2. Todo probado en
**antroapp-dev**. Producción no se tocó (ni lectura de datos ni escritura).

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
5. **Pendientes de una cuenta dada de baja** se quedan en ese teléfono como
   rechazados hasta "Entendido" o 72 h. Nadie más los puede mandar.

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
  desde el pase 1, paso 7b).

## Notas de entorno

- En este worktree `node_modules` es un enlace a la carpeta principal y
  **Turbopack se niega a arrancar** ("Symlink node_modules is invalid").
  `scripts/dev/servidor-dev.mjs` falla aquí; usé el mismo arranque sin
  `--turbopack` (webpack) desde un script en el scratchpad. No cambié
  `servidor-dev.mjs`.
