# Bloque 8: fase 2 completa (inventario y propinas) detrás de banderas

Rama `n4-fase2` (sobre `post-junta-3`), 27/11/2026. Solo dev: nada de esto
está en producción.

## Banderas

Cada parte necesita **dos** banderas encendidas:

| Parte | Bandera global (build) | Bandera del antro (`club_funciones`) |
|---|---|---|
| Catálogo en la caja, inventario, reporte de inventario, aviso de existencias bajas | `NEXT_PUBLIC_FASE2=1` | `inventario` |
| Propina en el cobro, propinas sueltas, reparto, reporte de propinas | `NEXT_PUBLIC_FASE2=1` | `propinas` |

- Las dos banderas del antro están **apagadas por defecto**. Solo el admin las
  enciende (`/admin/funciones`, `funcion_cambiar`).
- Con la bandera del antro apagada, la caja se ve y se comporta exactamente
  como sin la fase 2:
  - la hoja de consumo es la de siempre;
  - el cobro no pide propina y no manda `p_propina_centavos`;
  - no aparecen «Propinas aparte» ni las propinas del cuadre;
  - el panel no enlaza a la fase 2;
  - las páginas dicen «todavía no está activo».
  - Probado en pantalla y en la base.
- En la app: `lib/fase2-contexto.tsx`. La caja pone `Fase2Provider` con su
  antro y sus componentes leen `useFase2()`. Las páginas usan
  `useFase2DeClub(clubId)`.
- En la base: las funciones **nuevas** revisan la bandera del antro, siempre
  después de revisar quién llama (`coalesce(funcion_activa(...), false)`).
  `funcion_activa` sigue sin poder ejecutarse por anon ni authenticated.

## Qué había y qué faltaba

| Necesidad | Antes (fase 2) | Ahora |
|---|---|---|
| Existencias por producto | sí (`productos.existencias`) | igual |
| Entradas / compras | ajuste genérico «entra» con motivo | `inventario_entrada`: cantidad, costo total y referencia opcionales, con clave de idempotencia |
| Mermas | ajuste genérico «sale» | `inventario_merma`: con motivo obligatorio (sugerencias: se rompió, se derramó, caducó, cortesía) |
| Ajuste por conteo | ajuste genérico con la diferencia calculada a mano | `inventario_conteo`: capturas lo contado; la base compara contra lo que el sistema decía al empezar a contar (`p_existencias_vistas`), así que las ventas hechas mientras se cuenta no se absorben en la diferencia; pide motivo si no cuadra |
| Baja al vender, sube al anular | sí (`caja_registrar_consumo_producto` y trigger) | igual, sin cambios |
| Aviso de existencias bajas | sí (panel y catálogo) | además detrás de la bandera `inventario` |
| Historial | solo la tabla, sin pantalla | `inventario_historial`: saldo después de cada movimiento (columna `orden`); botón «Historial» en el catálogo |
| Reporte por noche | no | `inventario_reporte_noche` y `/staff/inventario`: vendido, anulado, entradas, mermas y diferencias por producto |
| Propina por cobro | sí (`caja_pagos.propina_centavos`, sin cuenta) | igual, detrás de la bandera `propinas` |
| Propina suelta por mesa o cuenta y forma de pago | no | `caja_propinas` y `caja_registrar_propina`; se anula con motivo (`caja_anular_propina`) |
| Propina sin mesa (la que dejan con la mesa ya cuadrada, o la de la barra) | no | «+ Propina sin mesa» en una mesa libre o cuadrada de la caja, y «Registrar propina sin mesa» en `/staff/propinas` |
| Corregir la propina de un cobro (error de dedo) | solo anulando todo el cobro, con la mesa abierta | `propinas_anular_de_cobro`: anula solo la propina, con motivo, sin tocar el cobro, el saldo ni los cuadres (tabla `propinas_cobro_anuladas`); desde `/staff/propinas` |
| Reparto configurable | no | `propinas_config` (% personal, % RP de la cuenta, % casa y si entra el gerente) y `propinas_repartir` |
| Cierre de la noche con propinas aparte | sí, solo informativo | igual: `caja_cerrar_noche` no se tocó; el cuadre muestra las dos fuentes |
| Reporte de la noche | no | `propinas_reporte_noche` y `/staff/propinas` |

## Archivos

**SQL**, en orden:

| Archivo | Qué hace |
|---|---|
| `sql/post-junta-3/80-inventario.sql` (rollback `80-inventario-rollback.sql`) | Tipos `entrada`, `merma` y `conteo` en la bitácora. Columnas `costo_centavos`, `referencia`, `contado`, `clave_cliente` y `orden`. Funciones `inventario_entrada`, `inventario_merma`, `inventario_conteo`, `inventario_historial` e `inventario_reporte_noche`, y dos ayudantes internos sin GRANT. |
| `sql/post-junta-3/81-propinas.sql` (rollback `81-propinas-rollback.sql`) | Tablas `caja_propinas`, `propinas_cobro_anuladas`, `propinas_config`, `propinas_repartos` y `propinas_reparto_lineas`. Trigger `propinas_candado`. Funciones `caja_registrar_propina`, `caja_anular_propina`, `propinas_anular_de_cobro`, `propinas_config_leer`, `propinas_config_guardar`, `propinas_calcular`, `propinas_repartir`, `propinas_anular_reparto` y `propinas_reporte_noche`, y cinco ayudantes internos sin GRANT (`propinas_detalle`, `propinas_de_noche`, `propinas_partes`, `propinas_regla`, `propinas_candado`). |

Detalles del SQL:

- Requiere la fase 2 (`sql/fase2/…`, `sql/post-junta/09`) y
  `post-junta-3/00`.
- **No se redefinió ninguna función existente**: `caja_registrar_pago`
  (con el arreglo 65), `caja_registrar_consumo*`, `producto_*` y el trigger de
  anulación quedan como estaban.
- Los dos archivos llevan RLS en todas las tablas nuevas, `revoke ... from
  public, anon` y GRANT explícitos, `security definer` con
  `search_path = ''` y mensajes P0001 en español.
- **Rollback**:
  - **81 borra registros de dinero**: propinas sueltas, anulaciones de
    propinas de cobros, reglas y repartos, sin forma de recuperarlos. El
    archivo de rollback empieza con el aviso y con una consulta de respaldo
    (todo en un JSON) que hay que correr y guardar antes. Los eventos de caja
    de propinas se quedan, porque `caja_sin_borrar` lo impide.
  - 80 no borra movimientos: pasa `entrada`, `merma` y `conteo` a `ajuste`
    con la misma cantidad (las existencias siguen cuadrando) y deja el
    detalle en el motivo. Se pierden las columnas nuevas.
- **Prueba del rollback en dev**: esquema antes → aplicar → rollback →
  esquema igual, y reaplicar → igual. La comparación se hizo sobre los
  objetos de estos archivos porque otros carriles cambiaban dev al mismo
  tiempo; la de 81 también salió idéntica en el esquema completo. Se
  volvió a probar tras las correcciones de la revisión (80 y 81 cambiaron
  firmas: `inventario_conteo` y `propinas_calcular` / `propinas_repartir`).
  **Quedan aplicados en dev.**

**App**:

- `lib/fase2-contexto.tsx`
- `lib/fase2-pagina.ts`
- `lib/domain/inventario.ts` (se amplió)
- `lib/domain/propinas.ts`
- `components/propinas/propinas-mesa.tsx`
- `components/propinas/propinas-cuadre.tsx`
- `components/inventario/movimiento-inventario.tsx`
- `components/inventario/enlaces-fase2.tsx`
- `components/inventario/selector-noche.tsx`
- `app/staff/inventario/page.tsx`
- `app/staff/propinas/page.tsx`

**Ediciones mínimas en archivos compartidos**:

- `app/staff/caja/page.tsx`: el proveedor de banderas.
- `components/caja/hojas-mesa.tsx`: `FASE2_ACTIVA` → bandera del antro.
- `components/caja/detalle-mesa.tsx`: bandera, total de propinas y la
  sección «Propinas aparte».
- `components/caja/cuadre-noche.tsx`: `PropinasCuadre`.
- `app/staff/panel/page.tsx`: enlaces.
- `app/staff/catalogo/page.tsx`: bandera; «Existencias» abre entrada, merma
  o conteo; se agregó «Historial».
- `components/inventario/aviso-existencias.tsx`.

**Scripts**:

- `scripts/dev/probar-fase2-completa.mjs`: base, con sesiones reales.
- `scripts/dev/probar-fase2-dominio.mjs`: reglas puras.
- `scripts/dev/probar-fase2-completa-pantalla.mjs`: Playwright.
- `scripts/dev/fase2-datos-ejemplo.mjs`: datos de ejemplo.
- `scripts/dev/probar-fase2-pantalla.mjs`: ahora enciende las banderas de su
  antro de prueba.

## Reglas que quedaron

**Inventario**:

- Entradas, mermas, conteos, historial y reporte: solo gerente, dueño del
  antro o admin, y con la bandera encendida.
- Cada movimiento bloquea el producto. Siempre se cumple: existencias = suma
  de la bitácora.
- Conteo: la pantalla manda lo que el sistema decía al abrir el conteo.
  Quedan existencias = contado + (actuales − vistas) y la diferencia
  guardada es contado − vistas; el motivo dice cuántos movimientos hubo
  mientras se contaba. Sin ese dato (por la API), el conteo es absoluto.

**Propinas**:

- Registrar requiere el permiso de caja «cobrar», con la noche abierta. La
  mesa no puede estar cuadrada; si lo está, se registra sin mesa (desde la
  mesa en la caja o desde `/staff/propinas`).
- Anular (una suelta o solo la propina de un cobro) requiere el permiso
  «anular», con la noche abierta o cerrada, mientras la noche no se haya
  repartido. Para corregir después del reparto, primero se anula el reparto.
- La propina no toca el saldo, el cuadre de mesa o de noche, el conteo de
  caja ni la comisión.

**Reparto**:

- Solo con la **noche cerrada** y una vez por noche. Para corregir, se anula
  con motivo y se vuelve a hacer. Tres repartos a la vez dejan uno solo.
- La regla se copia al reparto: cambiarla después no altera un reparto ya
  hecho.
- **Se manda la regla que se vio**: `propinas_calcular` y `propinas_repartir`
  reciben los tres porcentajes y si entra el gerente. Si otro gerente cambió
  la regla entre «Ver cómo queda» y «Repartir», se rechaza («La regla del
  reparto cambió…») y no se guarda nada.
- Cómo se calcula cada propina:
  - La parte del RP es el % del RP si la cuenta tiene RP **activo**. Si la
    propina es de la mesa (como la del cobro, que no lleva cuenta) y la mesa
    tiene una sola cuenta, cuenta como de esa cuenta. Con varias cuentas no
    hay parte de RP. Un RP dado de baja no cobra: su parte va al personal y
    el reporte lo avisa («dado de baja: su parte va al personal»).
  - La casa se lleva su %.
  - El resto va al personal elegido, en partes iguales. Los centavos que
    sobran se dan uno a cada quien, en orden de nombre.
  - Con **0 % al personal**, o si el antro **no tiene personal** que pueda
    entrar, ese resto va a la casa (no se pide elegir a nadie). Si hay
    personal y no se eligió a nadie, se rechaza.
  - Las líneas suman el total exacto; la base lo comprueba.
- Al personal solo entran el staff activo del antro y, si la regla lo dice,
  el gerente. Los RPs no entran.
- El reporte separa las propinas **con el cobro** de las **sueltas**, y antes
  de repartir la pantalla avisa cuántas son del cobro para revisarlas (ver
  decisión 1).

## Pruebas (dev, 27/11/2026)

| Prueba | Resultado |
|---|---|
| `node scripts/dev/probar-fase2-completa.mjs` | **206/206** (ver detalle abajo) |
| `node scripts/dev/probar-fase2-dominio.mjs` | **32/32** |
| `probar-fase2-completa-pantalla.mjs` (Playwright, 390 y 360 px, servidor `next dev` en 3047 con FASE2=1 y llaves de dev) | **45/45** (ver detalle abajo). Capturas en `screenshots-n4-fase2/`. |
| `probar-fase2.mjs` / `probar-catalogo-csv.mjs` (existentes) | 51/51 y 16/16 |
| `probar-caja.mjs` / `probar-caja-concurrencia.mjs` | 168/168 y 29/29 |
| `probar-fase2-pantalla.mjs` (existente, con las banderas de su antro) | 12/12 |
| `auditoria-rls.mjs` (otro carril, sin `--base`) | 10049 coinciden, 0 no coinciden (la única función sin veredicto es de otro carril: `para_clubes_contacto_enviar`). Ninguna función nueva sale en el escaneo de NULL. Las 5 tablas nuevas salen como «sin matriz» (aviso: el SPEC de esa auditoría no las incluye todavía). |
| `npx tsc --noEmit`, `eslint` (archivos tocados), `next build` (`.next-build`) | sin errores |

Qué cubre `probar-fase2-completa.mjs`:

- banderas apagadas: no se crea nada y la caja funciona como antes;
- permisos de admin, dueño, gerente, staff, RP, cliente, gerente, staff y
  dueño del otro antro, anónimo y cuenta sin perfil;
- aislamiento entre antros;
- reintentos y ráfagas con la misma clave;
- venta, merma y anulación a la vez;
- dos staff venden la última pieza a la vez: las dos entran y quedan −1
  exactas;
- historial encadenado y reporte de la noche;
- propinas fuera del saldo, del cuadre, de la comisión y del conteo;
  `verificar-cuadre` sin diferencias;
- reparto al centavo, tres repartos a la vez, anular y repetir;
- correcciones de la revisión:
  - conteo con ventas mientras se cuenta (no se absorben);
  - la regla cambia entre ver y repartir (se rechaza y no se guarda nada);
  - RP dado de baja (su parte va al personal y el reporte lo avisa);
  - el RP de una propina «de la mesa» sale en el reporte;
  - anular solo la propina de un cobro (no se puede con el reparto hecho;
    el cobro y los cuadres no cambian; no se borra);
  - 0 % al personal y antro sin personal (el resto va a la casa);
  - totales por origen (cobro o suelta).

Qué cubre `probar-fase2-completa-pantalla.mjs`:

- panel, reporte de inventario y propinas de la noche de ejemplo;
- conteo e historial desde el catálogo;
- caja con banderas apagadas contra encendidas;
- registrar una propina suelta;
- «Propina sin mesa» desde una mesa libre de la caja;
- en `/staff/propinas`: totales por origen, registrar propina sin mesa y
  anular una propina con motivo;
- sin scroll horizontal a 360 px y sin botones de menos de 40 px.

**Datos de ejemplo**:

- `node scripts/dev/fase2-datos-ejemplo.mjs [--banderas]` crea en Club Demo
  Dev una noche **pasada y cerrada** (por defecto, ayer):
  - 6 productos «Ejemplo F2 · …» y 4 mesas con walk-ins (sin RP: no genera
    comisiones);
  - ventas, una venta anulada, una entrada, mermas y un conteo;
  - cobros con propina, propinas sueltas (una anulada), cuadres, cierre y
    reparto.
- Usa las funciones reales como `dev_staff` y `dev_gerente`; después mueve
  las horas a esa noche.
- `--limpiar` borra exactamente eso y deja la regla del reparto y las
  banderas de Club Demo Dev **como estaban antes de crear**. Las guarda al
  crear, en un evento de la noche de ejemplo. Se probó con un estado previo
  conocido (inventario apagada y regla 60/30/10): quedó idéntico.
- Se corrió, se usó en Playwright y **se limpió**: dev quedó sin datos de
  ejemplo y con las banderas `inventario` y `propinas` apagadas en todos los
  antros.

## Decisiones para Diego

1. **Las funciones viejas de la fase 2 no revisan la bandera del antro**:
   `caja_registrar_consumo_producto`, `producto_*` y la propina en
   `caja_registrar_pago`. Las usan otras pruebas que comparten dev. La
   pantalla solo las ofrece con la bandera. **Riesgo**: por la API se puede
   guardar una propina en un cobro con la bandera apagada. No se ve hasta
   que se enciende, y entonces entra al reparto. Mitigación: el reporte y la
   pantalla del reparto separan las propinas «con el cobro» y avisan cuántas
   son, y cada una se puede anular sola (`propinas_anular_de_cobro`).
   ¿Se cierran también en la base (otro SQL que redefine esas funciones)?
2. **Vender sin existencias** sigue permitido (queda negativo con aviso):
   dos staff con la última pieza venden los dos.
3. **El reparto pide la noche cerrada**. ¿Se quiere poder repartir con la
   noche abierta?
4. **La propina del cobro no lleva cuenta**: el RP solo recibe su parte si
   la mesa tiene una sola cuenta (o si la propina suelta se le asigna a su
   cuenta).
5. **Personal del reparto**: el staff activo del antro. Se sugiere a quien
   registró algo en la caja esa noche, pero no hay rol de «mesero» ni de
   «barra». ¿Hace falta?
6. **Mermas y conteos solo gerente o dueño**. ¿Se deja también al staff de
   barra?
7. **Las propinas en efectivo no entran al conteo de caja** (como ya estaba).
   Si el antro las mete a la caja, hay que cambiar `caja_cerrar_noche`.
8. **El reporte cuenta las existencias iniciales («alta») como entradas** de
   esa noche.

## Riesgos

- **Prueba del rollback**: la comparación de esquema fue sobre los objetos
  propios, porque otros carriles aplicaban SQL en dev al mismo tiempo. La de
  81 sí salió idéntica en el esquema completo.
- **Sin red**: la propina suelta no pasa por la cola de caja; con mala señal
  se reintenta con la misma clave, pero no se guarda en el teléfono.
- **Refresco entre teléfonos**: las propinas sueltas de otro staff se ven
  cada 15 s en la mesa; `caja_firma_noche` no las incluye.
- **Conteo por la API sin `p_existencias_vistas`**: sigue siendo absoluto
  (una venta entre el conteo y el guardado se absorbe). La pantalla siempre
  lo manda.
- **Propinas del cobro guardadas con la bandera apagada** (decisión 1).
- **El rollback del 81 borra registros de dinero**: respaldar antes, con la
  consulta del encabezado del archivo.
- **Pantalla vieja con otra regla**: si la regla cambió, «Ver cómo queda» y
  «Repartir» se rechazan con un mensaje claro; hay que recargar la página.

## Lo que NO está hecho

- Pantallas para el dueño: la base ya lo deja, pero el dueño no tiene
  pantalla de catálogo, inventario ni propinas.
- Que el RP o el staff vean su parte del reparto en su panel.
- Exportar los reportes (CSV o PDF).
- Bloquear la venta sin existencias.
- Costo promedio o valor del inventario: el costo de la entrada solo se
  guarda y se muestra en el historial.
- Varias barras o almacenes.
- Alertas por correo.
