# Reporte de la noche (19/11/2026, rama `desarrollo`)

> Reglas de la sesión: solo `desarrollo` y antroapp-dev; producción solo
> lectura; nada de merge a master, deploy, SQL en producción, ni cambios de
> contraseñas o llaves.

## Confirmación: nada se escribió en producción

- **Base de producción**: solo se leyó el catálogo (estructura, sin datos),
  con la conexión en modo solo lectura de `scripts/db/conexion.mjs`, para
  compararlo con `sql/esquema/esquema-prod.sql`. Resultado: idéntico. No se
  corrió ningún INSERT, UPDATE, DELETE ni DDL.
- **Vercel**: se listaron los deploys y los **nombres** de las variables de
  Production (sin valores, sin cambios). No hubo deploy a producción.
- **Git**: no hubo merge ni push a `master`. Todo está en `desarrollo`
  (push a `origin/desarrollo`, que solo genera Previews).
- No se cambiaron contraseñas, llaves ni variables. Los datos que se
  borraron y crearon son de **antroapp-dev**.

## Estado por bloque

| Bloque | Estado | Resumen |
|---|---|---|
| A · Panel del RP | ✅ | Estados por consumo, tema oscuro, detalle con línea de tiempo, cuota desde la base, aislamiento verificado. 40/40 pruebas de pantalla. |
| C · Demo y escala | ✅ | `demo-datos` con caja por la API (dev y prod después del pase), `mesas-extra` (50 mesas), reproducible desde cero. |
| B · Reglas de comisión | ✅ (diseño) | `docs/reglas-comision.md` con SQL propuesto **sin ejecutar** y 3 preguntas para el cliente. |
| D · Calidad y seguridad | ✅ | Auditoría de caja y panel RP; arreglos en código y en SQL (aún no en prod); recorrido de 6 roles 32/32; tipos, lint y build limpios. |
| E · Preparar el pase | ✅ (sin ejecutar) | `docs/pase-produccion.md`; catálogo de prod comparado; SQL revisado; cadena de rollbacks probada. |
| F · Documentación | ✅ | `docs/avance.md`, `CLAUDE.md`, este reporte. |

## Qué se hizo, por bloque

### A · Panel del RP (`/rp/panel`)

- **Estados por consumo** (calculados en la base, `rp_mis_reservas`):
  - Consumió: cuenta para comisión.
  - Llegó, sin consumo.
  - No llegó: la noche cerró sin entrada.
  - Por llegar: la noche sigue abierta.

  Se quitaron "Ingresó / Confirmada / Pendiente".
- **Tema oscuro** con la paleta pedida, sin serif, sombras ni degradados;
  botones de 44 px o más; sin scroll horizontal a 390 y 360.
- **Lista**:
  - periodo (Esta semana / Anterior / Mes), barra de colores por estado;
  - filtros (Todas / Consumieron / Sin consumo / No llegaron);
  - filas con nombre, fecha, personas, mesa, punto de estado y monto.
- **Detalle**:
  - nombre, teléfono y estado;
  - línea de tiempo: creada, llegó, ocupó mesa, consumo, cuadrada;
  - comisión con su estado y botón "Escribirle" por WhatsApp.
- **Visibilidad**: un solo punto, `rp_nivel_visibilidad(club)`, fijo hoy en
  "estado + monto".
- **Tarjeta de cuota**: sale solo si el antro usa cuota
  (`rp_progreso_cuota()`, que puede responder "sin cuota"). Ejemplos:
  "Cuota alcanzada" o "3 de 10 reservas que consumen". Se usa también en
  la pestaña Nómina, que antes contaba "entraron" e ignoraba la regla
  personalizada del RP.
- **Aislamiento**: la consulta regresa solo las reservas del RP que llama.
  La prueba revisa la respuesta de red: Mariana 35 reservas, 0 ajenas;
  Diego 29, 0 ajenas.
- **Pruebas**: `scripts/dev/probar-rp-panel.mjs`, 40/40, con `demo_mariana`
  y `demo_diego` a 390 y 360. Los 4 estados aparecen. Capturas en
  `screenshots-rp-rediseno/`.

### C · Demo y escala (dev)

- `scripts/demo-datos.mjs`:
  - escribe la caja por la API, respetando los triggers;
  - en dev toma la noche en curso; en prod usa `--fecha`;
  - borra solo lo demo; nunca cuentas.
- Reproducible desde cero: `sembrar-dev` → `demo-datos --env=.env.dev --si`
  → `mesas-extra`. Se hizo dos veces esta noche, una con la base
  reconstruida desde el esquema de prod.
- La demo trae:
  - Mesa 1 con 3 grupos y Mesa 2 con 2;
  - reservas de RP en los 4 estados;
  - 8 reservas para mañana;
  - Mariana con la cuota alcanzada y Diego sin alcanzarla (3 de 10).
- `scripts/dev/mesas-extra.mjs`: hasta 50 mesas, 12 ocupadas con walk-in;
  candado contra prod.

### B · Reglas de comisión

`docs/reglas-comision.md` incluye:
- las 3 reglas y sus parámetros;
- qué soporta hoy el código: porcentaje y fijo sí; la cuota solo semanal,
  sin mínimo ni escalones;
- un modelo con vigencia y SQL propuesto **no ejecutado**, con su rollback;
- la integración con el cuadre y la nómina, 17 casos de prueba y 6 riesgos;
- las 3 preguntas para el cliente.

### D · Calidad y seguridad

**Arreglos en código:**
- Caja: lectura paginada de la noche (PostgREST corta en 1000 filas y la
  caja hubiera sumado de menos) y los permisos en una sola llamada.
- Accesibilidad: contraste de bordes de campos (3:1), objetivos de 44 px,
  estado de cada mesa en texto para lectores de pantalla y pestaña activa
  visible. Las hojas inferiores llevan el foco adentro, no lo dejan salir
  con Tab y lo regresan al cerrar.
- Errores genéricos: solo se muestran los avisos de las funciones
  (`raise exception`); lo demás sale sin nombres de tablas ni políticas.
- Login:
  - bloqueo por correo **e** IP (5 fallos); antes cualquiera podía dejar
    fuera a otra persona fallando 5 veces con su correo;
  - límite holgado por correo (30) y por IP (20);
  - el RP dado de baja se rechaza en el servidor (403).

**Arreglos en SQL** (solo en archivos que aún no están en prod; aplicados
y probados en dev):
- Un RP dado de baja con una sesión vieja no lee reservas ni comisiones
  (dos políticas restrictivas), y las funciones de su panel y nómina lo
  rechazan.
- Un staff dado de baja no ve la caja.
- Índices `caja_consumos(noche_id)` y `caja_pagos(noche_id)`.
- Secuencias nuevas cerradas a `anon` y `authenticated`.
- `rp_progreso_cuota` ya no muestra una "cuota" de 1, que en realidad paga
  desde la primera reserva.
- Panel RP: la Nómina usa la cuota de la base.

**Revisado:**
- Staff no puede cuadrar (probar-caja).
- RP no ve datos de otros (probar-rp-panel).
- Dueño de grupo ve solo lo suyo (probar-caja y visibilidad).
- `anon` no tiene privilegios sobre ninguna tabla, secuencia ni función
  nueva (salvo `puede_ver_club`, a propósito).

**Rendimiento con 50 mesas:** carga ≈1.5 s, 14 consultas, búsqueda ≈30 ms.

**Recorrido de 6 roles a 390 px** (`scripts/dev/recorrido-roles.mjs`):
32/32, sin errores de consola ni de red y sin scroll horizontal. Capturas
en `screenshots-recorrido-roles/`.

**Pruebas finales:**

| Prueba | Resultado |
|---|---|
| probar-caja | 167/167 |
| visibilidad | 68/68 |
| probar-login | 15/15 |
| probar-rp-panel | 40/40 |
| recorrido de la caja | 22/22 |
| recorrido de roles | 32/32 |
| tsc, eslint, next build | sin errores |

### E · Preparar el pase (nada ejecutado en prod)

- **Catálogo de prod vs repo**: idéntico (0 diferencias).
- **Prod vs dev**: la diferencia son exactamente los 7 archivos del pase. Se
  probó así:
  1. Se reconstruyó dev desde el esquema de prod y se aplicaron los 7
     archivos.
  2. Se corrieron todos los rollbacks en orden inverso.
  3. El esquema resultante fue idéntico al de prod (solo cambia el
     encabezado "(prod)/(dev)").
- **Revisión del SQL**:
  - Toda tabla nueva tiene RLS y GRANT explícitos.
  - Toda función nueva revoca a `public` y `anon`.
  - Las columnas nuevas sobre tablas existentes llevan default válido.
  - Los archivos grandes no son idempotentes: se pegan una vez, entre
    `begin`/`commit`.
  - `rp-panel` y `caja-permisos` sí son idempotentes.
- **Diagnóstico de duplicados**: el PASO 0 de
  `sql/2026-11-borrador-una-reserva-por-dia.sql` es solo SELECT.
  Corrido el 20/11 en prod: 0 duplicados. El runbook agrega 3 diagnósticos
  más (pagos por día duplicados, estados fuera de lista, dueños con dos
  antros).
- **`docs/pase-produccion.md`**:
  - 11 pasos, cada uno marcado como reversible o irreversible, con su
    verificación y rollback;
  - la ventana estabilidad → merge;
  - el candado de puerta después del código;
  - la demo del 25 después de las 08:00;
  - una tabla de problemas comunes.

## Decisiones para Diego

1. **La cuota de Human Hood se captura hoy como "5", no "4".** Con el campo
   actual, el número D significa "la D-ésima ya paga". La pantalla del
   dueño lo explica, pero es fácil equivocarse. El diseño nuevo guarda
   `cuota = 4` directo.
2. **Las 3 preguntas del cliente** (final de `docs/reglas-comision.md`):
   - periodo de la cuota;
   - consumo mínimo;
   - monto según el tamaño del grupo.
3. **Cuándo hacer el pase.** Recomiendo lunes 23 o martes 24 de día, para
   que el 25 por la mañana solo falte la demo. Estabilidad y merge, seguidos.
4. **Supabase (a mano)**: confirmar el plan con respaldos, activar CAPTCHA y
   "Leaked password protection" en producción (`docs/avance.md`).
5. **Dar de baja staff**: el SQL ya respeta `activo = false` para staff,
   pero no hay pantalla para dar de baja a un staff, solo a RPs. ¿Se quiere?

## Pendientes (no se hicieron)

- `import "server-only"` en `lib/supabase/servicio.ts`. Hoy lo protege que
  la llave no tenga `NEXT_PUBLIC_`; conviene agregarlo con su prueba de
  build.
- Semántica de menús por teclado en la caja (Escape cierra "Más
  acciones"). Menor.
- Implementar las reglas de comisión: espera las respuestas del cliente.
- Alta masiva de RPs (plantillas de ~130 por antro).
- La deuda 9 (el staff lee la configuración de comisión en `clubs`) se
  resuelve con el modelo de `docs/reglas-comision.md`.

## Riesgos

- **Ventana entre estabilidad y merge**: con el código viejo y las funciones
  nuevas no nacen comisiones de RP. Debe ser de minutos y sin antros
  operando.
- **Demo del 25**: si `demo-datos` se corre antes de las 08:00, la noche
  objetivo no queda "en curso" en la caja.
- **Vista previa protegida por Vercel**: para abrirla hay que iniciar sesión
  en Vercel. Las pruebas de pantalla se corrieron contra el servidor local
  apuntando a dev, con el mismo código del Preview.
- Las capturas y `backups/` están solo en esta computadora (ignorados por
  Git).

## Tiempos (por los commits)

| Hora | Commit |
|---|---|
| 19:31 | plan inicial del reporte |
| 19:41–19:50 | bloque A (panel RP y demo con caja) |
| 20:11 | caja: permisos y paginación; accesibilidad; scripts de dev |
| 20:13–20:25 | login, errores genéricos, SQL endurecido (dev reconstruido dos veces) |
| 20:28 | bloque B |
| 20:34 | recorrido de 6 roles y arreglo de la Nómina del RP |
| 20:40 | bloque E |
| ≈20:50 | bloque F y cierre |

## Cierre

- **Último commit**: ver `git log -1` en `desarrollo` (el commit de este
  reporte).
- **Vista previa** (rama `desarrollo`, base antroapp-dev):
  https://antroapp-git-desarrollo-antroapp.vercel.app
- **Usuarios para probar**:
  - `demo_mariana@example.com` (panel RP);
  - `dev_staff@example.com` y `dev_gerente@example.com` (caja).

  Contraseña en `backups/dev-credenciales.json`. Antes de probar otro día,
  regenerar la noche demo (ver `docs/avance.md`).
