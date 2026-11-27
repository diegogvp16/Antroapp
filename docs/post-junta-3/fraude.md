# Revisión de RPs (antifraude) — bloque 3 de la noche 4

Rama `n4-fraude` (sobre `post-junta-3`). Estado al 27/11/2026: probado en
antroapp-dev, con los arreglos de la revisión independiente; **nada en
producción**. Todo detrás de la bandera por antro `antifraude` (SQL 00),
**apagada por defecto** y apagada en dev al terminar.

## Qué hace

- **3 reglas** por antro (cliente repetido entre RPs, ráfaga de reservas,
  consumo atípico), cada una con encendido/apagado y umbrales enteros con
  valor por defecto y límites. Sin configuración propia, una regla está
  **encendida con los valores por defecto** (una vez encendida la bandera).
- Al abrir la pantalla **solo se listan** las alertas guardadas. Buscar
  alertas nuevas es un botón y la base deja **una búsqueda cada 2 minutos
  por antro** (`fraude_detecciones`; dos a la vez se forman en fila). La
  pantalla muestra la última búsqueda (cuándo, quién, rango y resumen).
- La detección se calcula **bajo pedido** (`fraude_detectar`) con datos que
  ya existen: `reservations` y la caja por mesa (`mesa_cuentas`,
  `caja_consumos`, `mesa_sesiones`, `caja_noches`). Sin triggers nuevos ni
  funciones existentes redefinidas.
- Las alertas no se duplican. Volver a buscar actualiza la evidencia de las
  que siguen «Por revisar», marca con **«Ya no se cumple»**
  (`ya_no_aplica_en`) las «Por revisar» que en esa búsqueda ya no se
  cumplen (sin borrarlas) y **no toca** las descartadas o confirmadas.
- Revisión: `revisar → descartada | confirmada`, y «Volver a revisar». Nota
  obligatoria (5 a 1000 caracteres). Cada cambio queda en la bitácora con
  quién, cuándo, de, a, nota **y la evidencia y el resumen de ese momento**
  (si la alerta se reabre y la evidencia cambia, la decisión conserva con
  qué se tomó).
- Los cambios de reglas también quedan en bitácora (antes / después / quién).
- Lista paginada: «Mostrando X de N» y «Ver 50 más» (la base da como mucho
  200 por llamada y el total).

## Las reglas (definiciones exactas)

Noches = noches operativas (corte 08:00 en `clubs.zona_horaria`). Solo
cuentan los RPs con `profiles.role = 'rp'` y `club_id` del antro.

**Teléfono a 10 dígitos** (`fraude_tel10`, igual a `normalizarTelefonoMx`):
se quedan solo los dígitos y se quita un prefijo 521 / 044 / 045 / 52 / 01 /
1 si después quedan exactamente 10. Así se leen «55 1234 5678/», «5512345678
x», «55_1234_5678», «044 55…», «1 55…», «+52 1 (55)…». Lo que no da 10
dígitos es **ilegible**: no entra en la regla y la búsqueda dice cuántas
reservas de RP del rango tenían teléfono ilegible o vacío.

| Regla | Umbrales (defecto, límites) | Una alerta por | Definición |
|---|---|---|---|
| **Cliente repetido entre RPs** (`cliente_repetido`) | `dias` 30 (1–180), `min_rps` 2 (2–10) | (teléfono, RP que llega) | Una reserva de RP (`source = 'rp'`) es una **llegada** del RP X al teléfono si X no tenía otra reserva de ese teléfono en los `dias` días anteriores. Hay alerta si, en esa llegada, contando las reservas de RP del teléfono con noche entre «su noche − dias» y «su noche» (hasta esa reserva, en orden de noche y hora de creación), hay al menos `min_rps` RPs distintos. Ventana mostrada: la noche de la llegada más reciente. **La misma pareja no vuelve a salir** aunque el cliente siga reservando con el RP nuevo (y si se descartó, no se reabre); solo un RP nuevo hace otra alerta. Si un RP deja pasar más de `dias` sin reservarle y vuelve, es una llegada nueva (de esa misma pareja: no sale de nuevo si ya estaba revisada). |
| **Ráfaga de reservas** (`rafaga`) | `min_reservas` 8 (3–100), `minutos` 10 (1–240) | (RP, noche en que las creó) | Con `reservations.created_at`: hay alerta si en algún intervalo `[t, t + minutos]` de esa noche el RP creó al menos `min_reservas` reservas `source = 'rp'`. Evidencia: la ráfaga más grande (cuántas, de qué hora a qué hora, ids) y el total de la noche. |
| **Consumo atípico** (`consumo_atipico`) | `pct_bajo` 20 (1–90), `min_cuentas_bajas` 3 (1–50), `factor_alto` 5 (2–50), `muestra_minima` 20 (5–1000), `dias_referencia` 60 (7–365) | (RP, semana, bajo/alto) | **Mediana de la semana** = mediana del consumo sin anulados de **todas** las cuentas cuadradas del antro con consumo > 0 (walk-in, orgánicas y de RP) cuyas noches caen en los `dias_referencia` días que terminan el domingo de esa semana. Solo si esa muestra tiene al menos `muestra_minima` cuentas; si no, la semana se reporta «sin muestra» y no se revisa. Para cada RP, sus cuentas cuadradas con consumo > 0 de la semana: **bajo** si consumo < `round(mediana × pct_bajo / 100)` (alerta con `min_cuentas_bajas` o más: consumos mínimos que solo sirven para que la reserva cuente para cuota/comisión); **alto** si consumo > `mediana × factor_alto` (alerta con 1 o más). Consumo 0 no es «bajo». Redondeo de `numeric` (mitad lejos del cero). |

Las mismas definiciones están en `lib/domain/fraude.ts`
(`normalizarTelefonoMx`, `alertasClienteRepetido`, `mediana`, `umbralBajo`,
`clasificarConsumo`, `maximoEnVentana`, `enmascararTexto`) y la pantalla
explica cada regla con los umbrales del antro.

### Escaneos duplicados: se quitó

Estaba como cuarta regla y **no podía dispararse** con los flujos reales:
`puerta_escanear` solo registra el escaneo cuando la reserva no tiene
`puerta_estado`; después de la entrada, escanear o confirmar otra vez lanza
un aviso y ese aviso **deshace** cualquier registro de la misma
transacción; `puerta_entrada_diferida` (escáner de respaldo) tampoco deja
registro cuando la reserva ya había entrado (responde `ya_entro` sin
`caja_evento`). Con lo que hay en `caja_eventos` hoy no se puede ver un
código usado dos veces, así que la regla no se presenta. Para tenerla haría
falta **registrar los intentos rechazados fuera de la transacción que lanza
el aviso** (otra tabla escrita antes del `raise`, o desde la app después del
error): eso toca `puerta_*` y es **decisión de Diego**.

## Quién ve qué

| Quién | Ve / revisa / configura |
|---|---|
| Gerente activo del antro | Sí (`/staff/revision`, enlace en su panel) |
| Dueño del antro | Sí (`/dueno/revision`, enlace en su panel) |
| Dueño del grupo del antro | Sí (mismo `/dueno/revision`, con selector de antro); sus acciones salen con su nombre |
| Admin | Sí, todos los antros con la bandera (`/admin/revision`, enlace junto a «Alertas de reporte»); sale como «Administración» |
| Staff puro | No («Solo el gerente revisa a los RPs.»); sin enlace |
| RP | **Nunca**, ni sobre sí mismo |
| Cliente, otro antro, sin perfil, dado de baja, contraseña temporal, anónimo | No |

La pantalla distingue: cuenta sin permiso (dada de baja o con contraseña
temporal) → «Tu cuenta no tiene permiso para revisar RPs en este momento…»;
bandera apagada → «La revisión de RPs no está activa para tu antro.» La base
responde `P0001` en ambos casos (`fraude_mis_antros` devuelve los antros
que la cuenta puede revisar con su bandera; vacío = sin permiso).

**Datos personales:**
- La evidencia y la lista solo llevan teléfonos como `******1234`; sin
  nombres de clientes.
- Las notas se **guardan enmascaradas**: cualquier secuencia de 10 o más
  dígitos (con espacios, guiones, puntos o paréntesis) queda `******1234`
  (`fraude_enmascarar_texto`); la pantalla vuelve a enmascarar al mostrar.
- El sujeto de «cliente repetido» es `HMAC-SHA256(antro:teléfono)` con una
  clave aleatoria de la instalación (`fraude_secreto`) que no lee nadie por
  la API (ni anon, ni authenticated, ni service_role; solo las funciones).
  El teléfono completo no se guarda en ninguna tabla nueva (sí sigue en
  `reservations`, como antes).
- Nombres de cuentas: solo si son del antro, su dueño o de su grupo.

## Rendimiento

La primera versión hacía subconsultas por fila (cuadráticas) y tardaba más
de 8 s (el `statement_timeout` de authenticated) con volumen real. Ahora:
ventanas (`lag`, `count(*) over (range … following)`), joins por teléfono,
teléfonos candidatos filtrados primero, `not in` con hash para «ya no se
cumple», consumo por cuenta con su índice, la referencia semanal
materializada y, solo dentro de `fraude_detectar`, `set enable_nestloop =
off` (con las estimaciones de los CTE el planificador a veces elegía un
ciclo anidado de 10 mil × 10 mil filas).

Prueba de carga (`probar-fraude-carga.mjs`, transacción deshecha, como el
gerente con `statement_timeout` de 8 s): 27,990 reservas de RP (300 por
noche, 93 noches, 6 RPs, 4,000 teléfonos que se repiten, 2 % ilegibles),
13,950 cuentas cuadradas con consumo y 9 ráfagas sembradas. Cinco corridas
seguidas al final: **63 noches 2.0–2.7 s** (primera búsqueda, crea ~9,800
alertas porque los teléfonos al azar se cruzan entre RPs), **repetir 63
noches 1.5–3.1 s**, **14 noches ~0.5 s**, lista 0.17 s, detalle 0.07 s.
Límite de la prueba: 4 s por llamada (la mitad del timeout). Si otra sesión
retiene un candado (dev es compartido), la prueba lo detecta (`lock_timeout`
1 s) y repite.

## Archivos

- `sql/post-junta-3/30-antifraude-rps.sql` y `30-antifraude-rps-rollback.sql`
- `lib/domain/fraude.ts` — catálogo, definiciones y estadísticas (puras)
- `lib/fraude.ts` — llamadas a la base (tipadas)
- `components/fraude/revision-rps.tsx` — pantalla (lista, filtros, paginación, detalle, acciones, historial)
- `components/fraude/evidencia-alerta.tsx` — evidencia por regla
- `components/fraude/reglas-fraude.tsx` — reglas, umbrales y bitácora
- `components/fraude/enlace-revision-rps.tsx` — botón de navegación (solo con bandera)
- `app/staff/revision/page.tsx`, `app/dueno/revision/page.tsx`, `app/admin/revision/page.tsx`
- Una línea de import + una de enlace en `app/staff/panel/page.tsx`
  (bloque del gerente), `app/dueno/panel/page.tsx` y `app/admin/page.tsx`
  (bajo «Alertas de reporte», que no se tocó).
- Pruebas: `scripts/dev/probar-fraude-dominio.mjs`, `probar-fraude.mjs`,
  `probar-fraude-carga.mjs`, `probar-fraude-pantalla.mjs`

## Base: objetos y orden

Requiere el SQL 00 (`funcion_activa`), el pase 1 (caja por mesa, grupos,
`es_gerente_o_dueno`, `club_es_dueno_grupo`) y `pgcrypto` en `extensions`
(Supabase lo trae). Va después del 00; no depende de otros SQL de la noche 4.

- Tablas (RLS encendido, sin políticas, `revoke all` a public/anon/authenticated,
  solo service_role): `fraude_reglas`, `fraude_reglas_cambios`,
  `fraude_alertas`, `fraude_alertas_cambios`, `fraude_detecciones` (+
  secuencias). `fraude_secreto`: ni service_role.
- Para la app (`authenticated`, `security definer`, `search_path = ''`,
  autorización primero y luego bandera, condiciones en `coalesce(…, false)`):
  `fraude_mis_antros`, `fraude_reglas_leer`, `fraude_regla_guardar`,
  `fraude_reglas_cambios_leer`, `fraude_detectar` (máx. 63 noches, hasta
  mañana, una cada 2 min por antro), `fraude_ultima_deteccion`,
  `fraude_alertas_listar` (filtros estado/regla/RP/fechas, límite y
  desplazamiento, total), `fraude_alertas_rps`, `fraude_alerta_detalle`,
  `fraude_alerta_cambiar`, `fraude_catalogo` (inmutable, sin datos).
- Internas (sin `execute` para anon/authenticated): `fraude_puede_revisar`,
  `fraude_autorizar`, `fraude_parametros`, `fraude_regla_activa`,
  `fraude_tel10`, `fraude_enmascarar_tel`, `fraude_enmascarar_texto`,
  `fraude_nombre`. `fraude_tel10` no lleva `set search_path` a propósito
  (así Postgres la mete dentro de la consulta); no es security definer y
  llama a `pg_catalog` con esquema.
- Rollback: borra las 19 funciones y las 6 tablas (alertas, reglas,
  bitácoras, búsquedas y la clave). No toca la bandera. Reaplicar genera una
  clave nueva (el rollback ya borró todo lo que dependía de la anterior).

Prueba del rollback en dev (27/11, fotos del esquema seguidas): aplicado →
rollback → sin una sola línea `fraude_` y **0 diferencias** en el resto
contra el aplicado; reaplicar → esquema completo **idéntico** al primer
aplicado (0 diferencias, el bloque `fraude_` son 825 líneas). Dev queda con
el 30 aplicado y la bandera apagada.

## Pruebas (27/11/2026, antroapp-dev, todas al final sobre el SQL definitivo)

- `node scripts/dev/probar-fraude-dominio.mjs` — **66/66** (teléfonos en 15
  formatos, enmascarar notas, mediana, redondeo, umbrales, ventanas,
  llegadas de «cliente repetido» con el caso de la revisión: un cambio de RP
  y 4 semanas → 1 alerta; RP nuevo → otra).
- `node scripts/dev/probar-fraude.mjs` — **182/182**. Parte 1 (144) en una
  transacción deshecha, sesiones simuladas: cada regla con casos que
  disparan y que no; normalización y enmascarado iguales al dominio;
  ilegibles contados; HMAC (no md5 recalculable); el cliente que cambia de
  RP una vez da 1 alerta, descartada no vuelve, RP nuevo sí; límite de 2
  minutos; no duplicar; evidencia que crece; «ya no se cumple» y su
  limpieza; reabrir conserva la evidencia de la decisión; notas
  enmascaradas; paginación; nombre del dueño de grupo; permisos de 16
  perfiles (dados de baja, contraseña temporal, sin perfil); aislamiento
  entre antros; bandera apagada; tablas, clave y ayudantes cerrados. Parte
  2 (38) con **sesiones reales** contra la API de dev (12 perfiles,
  temporales `t_n4_fraude_*` borradas).
- `node scripts/dev/probar-fraude-carga.mjs` — **12/12** (ver Rendimiento).
- `PLAYWRIGHT_DESDE=… node scripts/dev/probar-fraude-pantalla.mjs http://localhost:3043`
  — **59/59** a 390×844 y 360×740: al abrir no busca; botón y su límite;
  ilegibles en el resumen; filtros; «Mostrando 2 de 2»; detalle; nota con
  teléfono enmascarado; evidencia de la decisión; «Ya no se cumple»;
  reglas; dueño, admin, staff, RP y bandera apagada. Capturas en
  `screenshots-n4-fraude/`.
- `npx tsc --noEmit`, `npx eslint` (archivos tocados) y
  `NEXT_DIST_DIR=.next-build npx next build`: en verde.
- Restos al terminar: 0 reservas, cuentas, perfiles, alertas, reglas,
  búsquedas, cuentas de caja `t_n4_fraude_*`; bandera `antifraude` sin filas.

No probado en pantalla: el mensaje «sin permiso» (el login de la app no deja
entrar a una cuenta dada de baja y la de contraseña temporal va a cambiarla
primero); está probado en la base (`fraude_mis_antros` vacío) y en el código.

## Decisiones para Diego

1. **Umbrales por defecto**: razonables, no medidos con datos reales.
2. **Reglas encendidas por defecto** al encender la bandera. ¿O apagadas?
3. **Quién**: gerente, dueño, dueño de grupo y admin ven y configuran. ¿El
   gerente debe poder cambiar umbrales?
4. **Reabrir** («Volver a revisar», con nota): ¿se queda?
5. **Cliente repetido**: una alerta por (cliente, RP que llega), y una
   pareja revisada no vuelve a salir. ¿Así, o que vuelva si pasa mucho
   tiempo?
6. La mediana usa **todas** las cuentas (incluidas las de RP). ¿Solo walk-in
   y orgánicas?
7. **Escaneos duplicados**: ¿registrar los intentos rechazados en la puerta
   para poder detectarlos? (toca `puerta_*`).
8. Límite de búsqueda: **2 minutos por antro**. ¿Otro?

## Recomendaciones fuera de este bloque

- **Validar el teléfono al crear la reserva del RP** (`app/rp/panel`, hoy
  texto libre): con un teléfono ilegible la regla de cliente repetido no lo
  puede revisar. No se tocó (es de otra pantalla); la búsqueda dice cuántos
  hubo.

## Riesgos (falsos positivos)

- Cliente repetido: un cliente real que cambia de RP, teléfonos compartidos
  (pareja, oficina) o capturados mal.
- Ráfaga: un RP que captura de golpe su lista real; datos demo por script.
- Consumo bajo: clientes que de verdad consumen poco; con cover alto la
  mediana puede ser baja. Consumo alto: mesas grandes o festejos.
- Una alerta no es una prueba: la pantalla lo dice y pide nota.

## Lo que NO está hecho

- Detección de códigos usados dos veces (ver «Escaneos duplicados»).
- Detección automática (cron) o avisos por correo: solo con el botón.
- Acción sobre el RP (baja, retener comisión): la confirmación solo queda
  registrada.
- Exportar alertas o reporte por RP.
- Nada en producción; el SQL va después del 00 en el pase.
