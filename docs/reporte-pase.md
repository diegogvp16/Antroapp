# Reporte: preparación del pase y de la junta (23/11/2026)

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
