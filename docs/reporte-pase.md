# Reporte: preparación del pase y de la junta (23/11/2026)

## Estado real de producción (actualizado el 27/11/2026)

| Qué | Cuándo | Estado |
|---|---|---|
| Pase 1, pasos 1 a 10 (tabla de abajo) | 24/11 | Aplicado y verificado: humo 84/84, recorrido 49/49 |
| Ajustes de Club Demo (`scripts/ajustes-club-demo.mjs --si`) | 24/11, 21:02 | Aplicado y verificado |
| Paso 11: `demo-datos` para la junta | 25/11, 10:00 | Aplicado y verificado (abajo) |
| Hueco CRÍTICO del perfil: `sql/2026-11-25-perfil-sin-club-ajeno.sql` | 27/11 | Aplicado a mano por Diego y verificado (abajo) |

Nada más se ha escrito en producción. El pase 2 (`post-junta-2`) **no** se ha hecho.

### Paso 11: `demo-datos` del 25/11 (autorizado por Diego)

- **Revisión previa (solo lectura):**
  - fecha operativa 2026-11-25;
  - Club Demo publicado;
  - `staff.demo` activo en Club Demo;
  - `demo-datos` no había corrido ese día.
- **Respaldo:** `backups/prod-2026-11-25-antes-demo-datos/`, solo local. Trae reservas, consumos, comisiones y caja de Club Demo, más las tablas de RP de las cuentas `demo_*`.
- **Corrida:** `node scripts/demo-datos.mjs --fecha=2026-11-25 --si`, de 10:00:28 a 10:01:55. Primero se simuló sin `--si`.
- **Resultado:** 4 noches, 35 mesas, 173 consumos, 64 pagos, 32 cuadres y 66 comisiones. Cada noche quedó «✓ coincide con la base».
- **Verificación (solo lectura):**
  - cuadre sin diferencias al centavo, en 651 revisiones;
  - solo cambió Club Demo: los otros antros siguen con 0 reservas y 0 caja, y grupos y antros siguen iguales;
  - humo 84/84;
  - ensayo del guion de la junta: sin fallas.
- **Rollback** (no hizo falta): `sql/limpiar-demo-caja.sql` en el SQL Editor y luego reponer desde el respaldo.

### Hueco CRÍTICO del perfil (aplicado el 27/11)

- **El hueco:** `profiles_insert_propio` dejaba que una cuenta recién registrada creara su perfil como `dueno` con el `club_id` de **cualquier** antro. Con eso leía reservas con teléfono, personal, sueldos y comisiones de ese antro. Se probó en dev con sesión real.
  - En producción había 0 perfiles de cliente o dueño con `club_id`, así que no se explotó.
- **Arreglo:** `sql/2026-11-25-perfil-sin-club-ajeno.sql`. Rollback: `sql/2026-11-25-perfil-sin-club-ajeno-rollback.sql`.
  - `profiles_insert_propio` ahora exige `club_id IS NULL`.
  - La nueva restrictiva `profiles_insert_sin_club_restrictiva` exige lo mismo con AND.
- **Respaldo previo:** `backups/prod-2026-11-25-antes-perfil/`, solo local. Trae 28 perfiles y las políticas de `profiles`.
- **Verificación (27/11, solo lectura en producción):**
  - catálogo: las 2 políticas de INSERT, tal como dice el archivo, y las otras 6 políticas de `profiles` sin cambios (8 en total; antes 7);
  - prueba del hueco en dev (`scripts/dev/probar-perfil-club-ajeno.mjs`, rama `post-junta-2`): 4/4. El registro legítimo de cliente y dueño sigue funcionando, y un perfil con antro ajeno se rechaza con 42501;
  - recorrido de los roles en producción: 49/49, con login de RP, cliente, staff, gerente, dueño de grupo y admin;
  - humo 84/84, que incluye los registros de cliente y de dueño;
  - no se crearon cuentas en producción.

## Pase ejecutado (24/11/2026)

Rama del pase: **`pase-final`** (`bcfe50b`) = `candidato-pase` + solo
`sql/post-junta/10a-pase1-autorizacion-sin-nulos.sql` (paso 7c) y los pasos
nuevos 2b y 7d. Nada más de `post-junta`, `fase2` ni `noche2`.

Diego pegó cada SQL en el SQL Editor de producción. Después de cada uno se
verificó por introspección, con el catálogo en solo lectura
(`conectarProdLectura`). Horas de México.

| Paso | Qué | Hora | Verificación |
|---|---|---|---|
| 1 | Respaldo del día (`backups/prod-2026-11-24-17-27-antes-del-pase`, solo local) | antes de 13:33 | Confirmado por Diego |
| 2b | `registrar_*` sin EXECUTE para el anónimo | 13:33 | anon sin EXECUTE en ambas funciones |
| 3 | Cover | 13:37 | `cover_modo` / `cover_monto` y sus 2 constraints; default de `deposito_monto` = 0 |
| 4 | Caja por mesa | 13:43 | Las 11 tablas con RLS y sin privilegios para anon. Funciones ejecutables por anon: solo las previstas. Humo pública 22/22 |
| 5 | Estabilidad | 13:50 | 2 índices únicos. `login_intentos` y `app_errores` con RLS. `registrar_*` en versión nueva |
| 6 | Nómina y grupo | 13:54 | Las 7 funciones, ninguna para anon. `nomina_semana_datos` tampoco para authenticated |
| 7 | Panel RP y permisos de caja | 17:12 | 5 funciones (anon no, authenticated sí) y 2 restrictivas `*_rp_dado_de_baja` |
| 7b | Caja en condiciones reales | 17:14 | Firmas con `p_clave` y `p_saldo_esperado`, `caja_firma_noche`, `grupo_rendimiento_rp` y `clave_cliente` |
| 7c | 10a: autorización sin NULL | 17:15 | Las 6 funciones corregidas, solo `puede_ver_club` para anon. El anónimo sigue viendo solo Club Demo |
| 7d | `registrar_*` sin NULL | 17:16 | Cuerpos idénticos al archivo; anon sin EXECUTE |
| 8 | Merge `pase-final` → `master` (`771e7d3`) y push | 17:20 | Deploy de Vercel listo a las 17:21 (41 s), en antroapp.vercel.app. Humo **84/84** |
| 9 | Candado de puerta | 20:43 | Trigger `reservations_candado_puerta` (BEFORE INSERT OR UPDATE). Función sin SECURITY DEFINER y con `search_path` fijo. Ni anon ni authenticated la ejecutan. Humo **84/84** |
| 10 | Recorrido de los roles en producción, solo lectura | 21:03–21:05 | **49/49** (abajo) |

- **Qué se revirtió:** nada.
  - Cerca de las 17:47 se pegó por error el **rollback** del paso 9 en lugar del paso 9. Como el candado no existía, no hizo nada: se verificó que no había trigger ni función y que todo lo anterior seguía intacto.
  - El paso 9 correcto se aplicó a las 20:43.
- **Comparación de funciones, producción vs dev (`pase-final`) después del paso 7d:** las únicas diferencias eran:
  - `registrar_*`, porque 7d es posterior a la foto de dev;
  - el candado de puerta, que faltaba y es el paso 9;
  - el ACL de `clubs_candado_zona_horaria`: anon la puede ejecutar, pero es función de trigger y no tiene efecto.
- **Rollback de Vercel disponible:** Instant Rollback a `antroapp-p86citl6v-antroapp.vercel.app`, el deploy anterior. No hizo falta.

### Ajustes de Club Demo (después del pase verificado)

Se aplicaron a las 21:02 con `node scripts/ajustes-club-demo.mjs --si` (service role).
El ciclo completo se ensayó antes en dev con `--dev`: aplicar, recorrido 34/35, rollback parcial y rollback completo. La única falla esperada fue `?tema=`, que en dev sí debe funcionar.
Antes de correrlo, una revisión adversarial con 3 revisores encontró varios problemas, ya corregidos:
- una sola contraseña para todas las cuentas;
- un rollback que bloqueaba todo o nada;
- objetos perdidos si se caía una respuesta.

- **a) Cuentas demo**, todas `@example.com`, cada una con su contraseña. Las contraseñas están **solo** en `backups/2026-11-24-prod-cuentas-demo.json`:
  - `admin.demo` (admin);
  - `cliente.demo`;
  - `staff.demo` y `gerente.demo`, de Club Demo;
  - `dueno.grupo.demo`;
  - `gerente.tijuana.demo`.

  El RP del recorrido es `demo_mariana`, que ya existía.
- **b) Ficha de Club Demo:**
  - horario: **"Mié a Sáb 9pm a 3am"** (antes "Jue a Sáb");
  - música: "Reggaetón, house y pop";
  - vestimenta: "Casual elegante";
  - edad mínima: 18.
- **c) "Club Demo Tijuana"**, **oculto**:
  - borrador, sin suscripción;
  - zona `America/Tijuana`, 10 mesas;
  - dueño `dueno.grupo.demo`, gerente `gerente.tijuana.demo`.

  Grupo "Grupo Club Demo" = Club Demo + Tijuana, con `dueno.grupo.demo` como dueño de grupo.
- **Verificado:**
  - el anónimo sigue viendo solo Club Demo, ya con la ficha nueva;
  - hay 4 antros, 1 publicado;
  - el anónimo no lee `grupos`.
- **Rollback:** `node scripts/ajustes-club-demo.mjs --rollback --si`. Borra solo lo que creó el script. Una cuenta a la que ya apunten caja o reservas se **desactiva y bloquea** en vez de borrarse; la caja no se borra. La simulación actual dice "borrar" para todo.
- **Para el 25/11:** `demo-datos` necesitaba un staff en Club Demo y no había ninguno. Habría fallado con "El antro demo necesita un staff y un gerente".
  - Ahora usará `staff.demo`, y de gerente a Lorena o a `gerente.demo`: `demo-caja.mjs` toma el primero que devuelve la consulta.
  - Después de eso, el rollback desactivará esas cuentas en lugar de borrarlas.

### Recorrido en producción (paso 10): 49/49

Playwright a 390 px contra https://antroapp.vercel.app. Solo navega: no pulsa nada que escriba.

| Rol | Pantallas |
|---|---|
| Anónimo | `/`, `/cliente`, ficha, `/acceso-negocios`, logins y signups |
| RP `demo_mariana` | 4 pestañas |
| Cliente | catálogo, ficha, reservar (sin enviar), perfil |
| Staff | panel, caja, nómina ("Solo el gerente") |
| Gerente | panel, caja, nómina |
| Gerente de Tijuana | ve su antro |
| Dueño de grupo | panel de Tijuana, nómina, `/grupo` con los 2 antros |
| Admin | `/admin` |

- **Sin errores:** sin pantallas de error, sin scroll horizontal y sin errores de consola ni respuestas 4xx/5xx.
- **Sin escrituras:** las únicas peticiones que no son GET fueron el login y RPC `STABLE` (de lectura). La caja sigue en 0 filas.
- **`app_errores`:** 0 en las últimas 3 horas.
- **`?tema=claro` no aplica en producción:** `/grupo` sigue con el tema oscuro.

Notas, no son fallas:
- `/cliente` sin sesión manda al login; así es el código.
- Las reservas demo del 25/11 se ven "Llegó, sin consumo" porque son del modelo viejo. Se arreglan con `demo-datos` el 25/11 después de las 08:00.

### Qué se escribió en producción y qué no

- **Sí:**
  - el SQL de los pasos 2b a 9, pegado por Diego;
  - el merge y push a `master` → deploy automático;
  - los ajustes de Club Demo (a, b, c) con el script de arriba.
- **No:**
  - `demo-datos` (se corrió después, el 25/11: ver «Estado real» arriba);
  - ninguna contraseña existente ni ninguna llave;
  - nada en otros proyectos;
  - ningún dato real tocado fuera de los 4 campos de la ficha de Club Demo.
- **Git:**
  - `master` = `771e7d3`, árbol idéntico a `pase-final`;
  - `desarrollo` = `master` + este reporte y `scripts/ajustes-club-demo.mjs` (`5c8edfb`, subido el 24/11 en la noche);
  - sin credenciales ni respaldos en Git (`backups/` está ignorada).
- **Hecho después:** `post-junta` adoptó 2b, 7c/10a y 7d al integrar `master` (`85f5a5e`).

---

Rama de trabajo: **`candidato-pase`** = `desarrollo` + `noche2` (sin `fase2`).
Base: **antroapp-dev** únicamente.

## Confirmaciones

- **Producción: no se escribió nada.** Solo hubo lecturas:
  - el catálogo, en sesión de solo lectura, para comparar esquemas;
  - conteos agregados fijos de Club Demo, sin correos, nombres ni teléfonos (`scripts/db/conteos-prod.mjs`);
  - peticiones **GET** sin sesión a antroapp.vercel.app (prueba de humo).

  Sin SQL, sin deploy, sin variables y sin llaves.
- **Ramas intactas** en GitHub:

  | Rama | Commit |
  |---|---|
  | `master` | `dc61d91` |
  | `desarrollo` | `a469a5a` |
  | `noche2` | `6a5507b` |
  | `fase2` | `14ce066` |

  Sin merges ni commits en ellas.
- Etiqueta **`checkpoint-noche2`** en `6a5507b`, subida a GitHub (junto a `checkpoint-0100`).
- **Repo limpio:**
  - Lo único parecido a credenciales que hay en Git es `.env.local.example`, que solo trae nombres.
  - Capturas, videos y respaldos están fuera de Git:
    - `screenshots-*/` (también el video `.webm`);
    - `backups/`, que tiene los respaldos de dev y los esquemas del ensayo.
- **Dev cambió**: el bloque 6 lo resembró. **La contraseña de los usuarios
  ficticios de dev es nueva** (la cambia `sembrar-dev`; está en
  `backups/dev-credenciales.json`). El SQL de `fase2` ya **no** está aplicado en dev
  (se quitó para la prueba 1b; para volver a ponerlo, ver "Riesgos").

## Vista previa y último commit

- **https://antroapp-git-candidato-pase-antroapp.vercel.app** (pide iniciar
  sesión en Vercel). Apunta a antroapp-dev.
- Último commit con código: `fcc306f`; después, solo documentación (este reporte).

## Bloque 1 — Candidato al pase

### a) `candidato-pase` y conflictos

**No hubo conflictos.** Evidencia: `desarrollo` no recibió commits después
de `a469a5a`, que es justo donde nace `noche2` (merge-base = `a469a5a`); el
árbol de la fusión quedó **idéntico** al de `noche2` (0 archivos de
diferencia). No se perdió nada de ninguna rama. `fase2` no se tocó.

Commits nuevos sobre la fusión (cada uno se revierte solo):

| Commit | Qué |
|---|---|
| `fdf58d7` | Tema **oscuro** por defecto en nómina y /grupo (`lib/tema-reportes.ts`) |
| `b18be09` | Conversión **solo con noches cerradas** (SQL de /grupo + pantalla). Para revertirlo: revertir el commit y volver a aplicar la versión anterior del SQL |
| `ac7cf9b` | Cabeceras de seguridad (nosniff, Referrer-Policy, sin iframes ajenos, cámara y ubicación solo para el sitio, sin x-powered-by) |
| `fee8abd` | `scripts/humo-produccion.mjs` |
| resto | Pruebas, scripts de ensayo y de junta, documentación |

### b) ¿Funciona el código sin el SQL del paso 7b? (con evidencia)

Se probó en dev: se quitó el 7b (y el de `fase2`, que depende de él) y se corrió la app de
`candidato-pase` contra esa base.

| Prueba | Sin el 7b | Con el 7b aplicado **después**, sin reiniciar nada |
|---|---|---|
| Caja en la base (`probar-caja`) | 167/167 | 167/167 |
| Recorrido 6 roles | 30/32: la caja carga y opera, pero la consola muestra un **404 de `caja_firma_noche`** cada 10 s | 32/32 |
| 3 sesiones en la misma mesa (`probar-caja-multi`) | 9/13: **dos staff cobraron a la vez el saldo completo → mesa de $3,250 cobrada $6,500** | 17/17 |
| Reintentos y concurrencia (`probar-caja-concurrencia`) | no aplica: las funciones no existen | 29/29 |
| /grupo (`probar-dashboards-pantalla`) | 17/24: **sin conversión ni rendimiento por RP** ("todavía no está disponible") | 24/24 |

**Respuesta**:
- **Sin el 7b, el código nuevo funciona, pero degradado:**
  - pierde la protección contra cobros dobles y reintentos duplicados;
  - cada consumo y cobro hace dos viajes (404 y luego la llamada vieja);
  - la caja baja la noche completa cada 10 s (~75 KB en vez de ~1 KB);
  - `/grupo` no muestra conversión ni rendimiento por RP.
- **Nada se rompe:** no hay pantallas caídas y no se pierden datos.
- **Si se aplica DESPUÉS del código**, la app lo usa al instante: el 7b se
  aplicó con la app corriendo y las pruebas pasaron sin recargar ni volver a
  desplegar.
- **El SQL del 7b no afecta al código viejo:** sus parámetros nuevos tienen default.

**Decisión de orden**: el 7b va **antes del merge**. Así no hay ningún minuto
con código nuevo sin protección contra cobros dobles.

### c) Reversible o irreversible, rollback y tiempo

Tabla completa en `docs/pase-produccion.md` (sección "Orden"):
- Todos los pasos de SQL son reversibles, con rollback exacto y probado. El 4
  es "con cuidado": su rollback borra lo registrado en caja.
- El merge se revierte con Instant Rollback de Vercel.
- El 11 (datos demo) es irreversible para lo demo.

**Punto de no retorno**: no hay uno técnico antes del paso 11. El práctico
es **la primera noche con movimientos reales de caja**: desde ahí, revertir
el paso 4 borra datos reales.

### d) Runbook

`docs/pase-produccion.md` tiene el orden final:
- con el merge de `candidato-pase` a `master` (sin ejecutarlo);
- con el 7b antes del merge;
- con los tiempos reales del ensayo;
- con los criterios para parar y revertir, por paso.

### e) Tema oscuro y conversión con noches cerradas

Están en dos commits separados (`fdf58d7` y `b18be09`).
- **Noche cerrada:** ya pasó su corte de las 08:00, o el gerente la cerró en la caja.
- **"Esta semana"** solo tiene la noche en curso, que sigue abierta, así que la
  conversión sale "—".
- **"Semana anterior"** muestra 69 % con los datos de dev.

## Bloque 2 — Prueba de humo (`scripts/humo-produccion.mjs`)

Solo GET, sin sesión. Revisa:
- rutas públicas y logins (cliente/RP, dueño y admin): que respondan 200;
- rutas protegidas sin sesión;
- que las API no respondan a GET;
- cabeceras de seguridad;
- manifests, iconos, service worker y página sin conexión;
- que ninguna página muestre errores técnicos ni nombres de tablas.

Modos opcionales:
- `--navegador`: confirma que las rutas protegidas terminan en el login, y el navegador aborta lo que no sea GET.
- `--vercel-curl`: para la vista previa protegida.

| Contra | Resultado |
|---|---|
| **Vista previa de `candidato-pase`** (vercel curl) | **APROBADO 74/74** |
| Build de producción local contra dev, con navegador | 83/84 (solo falta HSTS, que pone Vercel en https) |
| **Producción actual** (solo GET) | 46/60: **páginas públicas y logins 22/22, API 6/6, sin errores técnicos**. Las 14 fallas son justo lo que trae el pase: `/staff/caja`, `/staff/nomina`, `/dueno/nomina` y `/grupo` dan 404; faltan 5 cabeceras, 3 manifests y `/offline.html`. Después del pase debe dar 74/74 |

## Bloque 3 — La junta (`docs/guion-junta.md`)

- **Guion** de 10 minutos: minuto a minuto, con la cuenta, la pantalla, el dato y el mensaje clave para el dueño de grupo.
- **`/grupo` con 2 ciudades:** Guadalajara y Tijuana; **solo existe en dev**.
- **Respuestas preparadas:** precio (por definir), seguridad y privacidad, y qué decir si piden algo que no existe.
- **Contingencias:** internet, login, escáner, celular, datos y una pantalla que falla.
- **Regenerar los datos en 2 minutos:** `demo-datos` tardó 71 s y `mesas-extra` 5 s en el ensayo.
- **Plan B:** `scripts/dev/video-junta.mjs` graba el recorrido sin escribir nada (0 escrituras) y deja 11 capturas y un video en `screenshots-junta/`.
- **Checklist** de la noche anterior y de la mañana.
- **Escáner (3d)**, `probar-escaner.mjs` 9/9: lee el QR en vertical en ~2.3 s con luz normal, poca luz y muy oscuro, y "Confirmar entrada" funciona. Anotado:
  - la cámara simulada no reproduce enfoque, reflejos ni movimiento de un celular real;
  - no hay botón de linterna;
  - el aviso del QR parece un campo de texto.

## Bloque 4 — Producción, solo lectura

Solo conteos (`scripts/db/conteos-prod.mjs`):

| Qué | Hoy en producción |
|---|---|
| Club Demo | existe, verificado y con suscripción |
| Horario | "Jue a Sáb 9pm a 3am" (**la junta es miércoles**) |
| Ficha | edad mínima, vestimenta y música **vacías**; sin ubicación |
| Mesas | **29** (dev: 50) |
| Fotos | 3, las de SIX GDL |
| Personal | 1 gerente, 10 RPs (los 6 `demo_*` activos y en Club Demo) y **0 staff** |
| Reglas | 5 reglas por RP y 6 turnos fijos |
| Reservas demo | 127 (del 19 al 25/11) |
| Caja, nómina nueva, `/grupo`, cover | **no existen** (llegan con el pase) |
| Antros publicados | 1, en una sola ciudad |

**Qué hacer el día de la junta** (ya está en la checklist del guion):
1. **Si el pase ya se hizo:**
   - corregir el horario y llenar edad mínima, vestimenta y música desde el panel del dueño;
   - **crear una cuenta de staff** en Club Demo;
   - correr `demo-datos --fecha=2026-11-25 --si` después de las 08:00.
2. **Si no se hizo:** la demo va en la vista previa (dev).
3. **`/grupo` con 2 ciudades:** desde dev, o decides crear en producción, después del pase, un segundo antro demo y un grupo. Eso no está hecho.

No se ejecutó `demo-datos` en producción.

## Bloque 5 — Seguridad manual (`docs/seguridad-manual.md`)

Clic a clic, con "qué deberías ver" en cada paso:
- **Supabase:**
  - contraseñas filtradas y longitud mínima;
  - límites de intentos;
  - **CAPTCHA: todavía NO**, porque la app no manda el token y nadie podría entrar;
  - respaldos;
  - "automatically expose new tables";
  - restablecer la contraseña de la base: solo hay que actualizarla en `.env.dev`, Vercel no la usa.
- **Vercel:** Instant Rollback, las 3 variables de Production y los registros.
- **GitHub:** ruleset para proteger `master`.

## Bloque 6 — Ensayo del pase en dev

| Etapa | Resultado | Tiempo |
|---|---|---|
| a) Respaldo de dev | `backups/dev-2026-11-23-22-09-antes-del-ensayo` (28 tablas; esquema + datos) | ~20 s |
| b) Rollbacks 9 → 3 | todos OK | 16 s |
| b) Comparación con el catálogo de producción | **IDÉNTICO** (888 líneas). El catálogo de producción tampoco cambió desde `sql/esquema/esquema-prod.sql` | ~30 s |
| 2 Diagnósticos | a–d en 0 | 2 s |
| 3 cover | OK | 3.2 s |
| 4 caja por mesa | OK | 3.4 s |
| 5 estabilidad | OK | 3.1 s |
| 6 nómina y grupo | OK | 3.2 s |
| 7 panel RP + permisos | OK | 4.8 s |
| 7b idempotencia + conversión | OK | 4.7 s |
| 8 build de Vercel (`candidato-pase`) | Ready; humo de la vista previa 74/74 | build 33–57 s; humo 218 s |
| 9 candado de puerta | OK | 3.1 s |
| 10 recorrido 6 roles + humo local | 32/32 · 83/84 (HSTS) | 81 s · 12 s |
| d) Rollback del 9 y otra vez el 9 | OK y OK | 3.3 s + 3.3 s |
| Esquema tras el pase vs. antes del ensayo | **0 líneas de diferencia** | — |
| e) `sembrar-dev`, `demo-datos` (hoy), `mesas-extra` | grupo de 2 ciudades, 16 noches de historia; hoy: 40 reservas, 27 con entrada; 50 mesas | 69 s · 71 s · 5 s |
| e) Cuentas `demo_mariana`, `dev_staff`, `dev_gerente`, `dev_dueno` | entran (rp, staff, gerente, dueño; activas) | — |
| f) Restaurar desde el respaldo | **no hizo falta**: nada falló | — |

Pruebas sobre el estado final de dev, todas en verde:

| Prueba | Resultado |
|---|---|
| Recorrido 6 roles | 32/32 |
| Panel RP | 40/40 |
| `/grupo` en pantalla | 24/24 |
| Caja, 3 sesiones | 17/17 |
| Escáner | 9/9 |
| Login | 15/15 |
| Dashboards | 28/28 |
| Visibilidad | 68/68 |
| Caja | 167/167 |
| Concurrencia | 29/29 |
| `verificar-cuadre` | sin diferencias |
| `tsc` y `eslint` | OK |
| `next build` | OK (el de `servidor-prod-dev` y el de Vercel) |

## Qué falló durante el trabajo (y cómo quedó)

- **`/grupo` en pantalla falló al principio por datos viejos**, no por el código: la demo era del 19/11 y "esta semana" estaba vacía. Se regeneró la noche demo y la prueba ahora decide según los datos.
- **Al cambiar de rama, los archivos quedaron con fin de línea CRLF** y dos ediciones automáticas no encontraban el texto. Se normalizó; los archivos se guardan igual en Git.
- **El video de respaldo no cambiaba de semana** (el selector es una pestaña, no un botón). Corregido.
- **El humo en local marca HSTS como faltante**: es correcto, lo pone Vercel en https.
- **El respaldo de dev no sirve para restaurar usuarios** (no guarda contraseñas): la restauración real de dev es resembrar (`sembrar-dev` + `demo-datos` + `mesas-extra`). Está en `docs/guion-junta.md` y en este ensayo.

## Riesgos

1. **El código viejo pierde comisiones con el paso 5**: la ventana entre el paso 5 y el 8 debe ser de minutos (ya está así en el runbook).
2. **Instant Rollback regresa solo el código**: el SQL se queda; es compatible salvo esa misma nota del paso 5.
3. **Producción no tiene staff en Club Demo y su ficha está incompleta**: sin ajustes, la demo en producción se ve peor que en dev.
4. **`fase2` necesita su SQL en dev para probarla con la bandera encendida**. Para volver a ponerlo (dev compartido con `desarrollo`, `noche2` y `candidato-pase`, que siguen funcionando con él):
   ```bash
   git show origin/fase2:sql/fase2/2026-11-21-inventario-propinas.sql > <carpeta temporal>/fase2.sql
   node scripts/db/aplicar-dev.mjs <carpeta temporal>/fase2.sql
   ```
5. **Las cabeceras nuevas incluyen `Permissions-Policy` con la cámara solo para el sitio**: el escáner se probó con ellas (9/9). Si algún día se incrusta un mapa externo, hay que revisar `frame-ancestors` y esa política.

## Decisiones que necesito de ti

1. **Cuándo hacer el pase**: lunes 23 o martes 24 de día, para que la junta del miércoles sea en producción, **o** dejarlo para después y hacer la junta en la vista previa.
2. **Si el pase va antes de la junta**:
   - crear la cuenta de staff en Club Demo;
   - corregir horario y ficha;
   - correr `demo-datos` el 25 después de las 08:00.
3. **`/grupo` con 2 ciudades en la junta**: mostrarlo desde dev, o autorizar crear en producción, después del pase, un segundo antro demo y un grupo (habría que escribir un script; no existe).
4. **Seguridad manual** (`docs/seguridad-manual.md`): sobre todo el respaldo de hoy, rotar la contraseña de la base y proteger `master`. Si proteges `master` exigiendo PR, el paso 8 se hace con un PR en lugar de `git push`.
5. **CAPTCHA**: si lo quieres, hay que agregar Turnstile a login y registros primero (rama aparte).
6. **Linterna en el escáner**: agregarla después de la junta.
