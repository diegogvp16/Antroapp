# Reporte de la noche 2 (20/11/2026, 01:10–02:46 hora de la Ciudad de México)

Rama de trabajo: **`noche2`** (desde `desarrollo` en `a469a5a`). Rama aparte:
**`fase2`** (desde `noche2`). Base: **antroapp-dev** únicamente.

## Confirmaciones

- **Producción: no se escribió nada.**
  - Base de producción: ni lectura esta noche.
  - Vercel: no se desplegó a producción ni se cambiaron variables.
  - Contraseñas y llaves: ninguna cambiada.
- **`desarrollo` y `master` intactos**:
  - `desarrollo` = `origin/desarrollo` = `a469a5a`;
  - `master` = `origin/master` = `dc61d91` (19/11);
  - ningún merge ni commit en ellas.
- Etiqueta **`checkpoint-0100`** en `a469a5a`, subida a GitHub: para volver,
  `git switch desarrollo` (ya está ahí) o `git checkout checkpoint-0100`.
- Repo limpio: lo único versionado que parece sensible es `.env.local.example`
  (solo nombres). Capturas (`screenshots-*/`), `backups/` y `.env*` fuera de Git.
- Datos de prueba: cada script crea su antro y sus usuarios y los borra al
  final; todos terminaron con "restos 0". Una reserva de prueba que quedó
  suelta por una prueba fallida se borró a mano (estaba en Club Demo Dev,
  de `dev_rp`).
- **Acceso a la vista previa.** La vista previa de Vercel pide iniciar sesión. Para el recorrido con
  Playwright **no** se usó el secreto de automatización del proyecto (el
  permiso lo bloqueó y no lo rodeé). Se hizo así:
  - el recorrido de los 6 roles contra un build de producción **del mismo
    commit** conectado a dev (`scripts/dev/servidor-prod-dev.mjs`);
  - en la vista previa real, con `vercel curl`, 12 rutas responden 200 (panel, caja,
    nómina, /grupo, manifests, página sin conexión, iconos). `vercel curl` usa
    el secreto que ya existía (creado el 19/11 22:01 UTC); no se creó ninguno.

## Vista previa y último commit

- `noche2`: **https://antroapp-git-noche2-antroapp.vercel.app** (pide
  iniciar sesión en Vercel). Último commit con código: `372aeaa`; después
  solo documentación (este reporte).
- `fase2`: https://antroapp-git-fase2-antroapp.vercel.app (bandera apagada:
  se ve igual que `noche2`).

## Bloque 1 — Caja en condiciones reales ✅

Detalle: `docs/caja-condiciones-reales.md`.

| | Antes | Ahora |
|---|---|---|
| Doble toque | podía entrar dos veces | candado síncrono en `useAccion`; triple toque = 1 consumo |
| Respuesta perdida por la señal + reintento | consumo o cobro **doble** | clave de idempotencia: el reintento devuelve el mismo movimiento |
| Dos staff cobran el saldo a la vez | mesa **sobrepagada** | "saldo esperado": entra uno; al otro, "la mesa ya quedó pagada" |
| Cuadrar/cerrar con respuesta perdida | error confuso | la app revisa el estado real y termina bien |
| Sin conexión | error genérico | aviso "Sin conexión · reconectando…" con la hora de los montos; botones "Sin conexión"; la captura se queda |
| Cambios de otros staff | había que tocar Actualizar | se ven solos en ~8–10 s, con una **firma de la noche** de ~1 KB (antes cada revisión habría bajado ~75 KB) |

- **Carga (build de producción, CPU 4× más lenta, 50 mesas, 1,150
  movimientos):**
  - carga en 3.2–3.6 s (4.4–4.9 s con 4G lenta);
  - scroll a 16 ms por cuadro, ninguno lento;
  - abrir una mesa ~130 ms; búsqueda ~160 ms;
  - funciones de caja con 8 staff a la vez: p50 ~100 ms, p95 ~130–175 ms.
- **`scripts/verificar-cuadre.mjs`**: 1,015 revisiones en dev y 483 en la
  noche de carga. Sin una sola diferencia de centavos entre caja, cuadres,
  comisiones, nómina, /grupo y panel del RP. No hubo bugs que corregir.
- **SQL (solo dev, rollback probado: esquema idéntico):**
  `sql/2026-11-21-caja-idempotencia.sql`. Es compatible en los dos sentidos:
  el código viejo funciona con la base nueva y el código nuevo con la base vieja.

## Bloque 2 — Números para el cliente ✅

Detalle y cifras: `docs/numeros-dashboards.md`.

- **Confuso o mal etiquetado, ya corregido:**
  - **"% de entrada"** contaba como fallidas las reservas de noches futuras: 56 % en
    lugar de 68 % con la demo.
  - **"Sin consumo"** en el panel de staff era solo la marca manual. Ahora dice
    "Se fueron sin consumir".
  - **"Ticket promedio"** era por cuenta, no por reserva. Ahora dice "por
    cuenta".
  - **"Comisiones"** incluía los pagos por día. Ahora dice "Comisiones y pagos a RPs".
  - **"Comisiones: N"** en la nómina contaba también las de $0. Ahora dice
    "Consumieron".
- **Nuevo:**
  - conversión (reservas que consumen entre reservas que ya podían llegar);
  - consumo con reserva;
  - rendimiento por RP (abierto de entrada para el gerente).
- **Acceso**, en consulta (28/28) y en pantalla (24/24): el gerente ve solo su
  antro; el dueño ve los suyos y los de su grupo; staff, RP y cliente no ven nada.
- **SQL (solo dev, rollback probado):** `sql/2026-11-21-grupo-conversion.sql`.

## Bloque 3 — App instalable y celular ✅ (sin SQL)

- **Cuatro apps instalables, cada una abre en su panel:**
  - AntroApp (cliente);
  - Antro Staff (`/staff/panel`);
  - Antro RP (`/rp/panel`);
  - Antro Dueño (`/dueno/panel`).

  Chrome no reporta errores de instalación en ninguna (34/34).
- **Iconos nuevos de marca** (obsidiana y oro, con versión "maskable"):
  reemplazan el degradado morado que `CLAUDE.md` pide evitar. Se regeneran con
  `node scripts/generar-iconos.mjs`.
- **Sin señal**, al abrir una pantalla sale la página propia "Sin conexión". El
  service worker solo guarda esa página: nada con datos.
- **Teclado:** el botón principal ya no queda tapado (Android con
  `interactive-widget`, iPhone con `visualViewport`). Las hojas no abren el
  teclado si no hace falta escribir.
- **Auditoría móvil** (un subagente revisó, sin escribir):
  - 44 px mínimos en todas las pantallas operativas, con una sola regla en
    `globals.css`;
  - teclado numérico en las reglas de pago;
  - errores claros en lugar de textos de Supabase en inglés: alta de RP, panel
    de staff, nómina;
  - fallas que pasaban en silencio ahora avisan: pago del día, quitar turno,
    dar de baja, permisos de caja;
  - el panel del RP ya no queda en blanco ni muestra $0 falsos;
  - la lista del RP se actualiza al crear una reserva (era un bug).
- **WhatsApp del RP:**
  - va directo al teléfono del cliente;
  - lleva la fecha legible ("sábado 21 de noviembre") y el aviso de que el QR
    no garantiza la entrada;
  - mide 319 caracteres;
  - el enlace abre el boleto en iPhone sin sesión y no muestra el teléfono.

  El boleto y la tarjeta del RP muestran el mismo aviso.

## Bloque 4 — Comparativo de temas ✅ (no elegí)

Detalle: `docs/comparativo-temas.md`.

- **Temas:** "actual" (es el que está puesto), "oscuro" (el lenguaje de la
  caja) y "claro" (misma estructura en hueso, con el mismo dorado).
- **Un solo punto para cambiarlo:** `TEMA_REPORTES` en `lib/tema-reportes.ts`.
- **Para comparar en la vista previa:** agregar `?tema=oscuro` o `?tema=claro` a
  `/grupo`, `/staff/nomina` o `/dueno/nomina`.
- **Capturas:** 18, en `screenshots-temas/` (3 pantallas × 3 temas × 390 y 1280 px).

## Bloque 5 — Fase 2: inventario y propinas ✅ (rama `fase2`, aislada)

Detalle: `docs/fase2.md`.

- **Bandera:** `NEXT_PUBLIC_FASE2`, apagada por defecto. Con la bandera apagada,
  la caja de 3 sesiones da 17/17, igual que antes.
- **Catálogo:**
  - existencias y bitácora;
  - la venta descuenta y es idempotente;
  - anular regresa las existencias;
  - aviso de existencias bajas;
  - pantalla del gerente;
  - hoja de consumo con categorías y buscador.
- **Propina:** va aparte del saldo, del cuadre y de la comisión.
- **SQL (solo dev, rollback probado):** `sql/fase2/`.
  - Para dejar dev como `noche2`:
    `node scripts/db/aplicar-dev.mjs sql/fase2/2026-11-21-inventario-propinas-rollback.sql`.
  - Mientras esté aplicado, `desarrollo` y `noche2` siguen funcionando (todas
    sus pruebas en verde).
- **Pruebas:** base 51/51; pantalla con la bandera 12/12.

## Bloque 6 — Cierre

| Prueba | Resultado |
|---|---|
| probar-caja | 167/167 |
| probar-clubs-visibilidad | 68/68 |
| probar-login | 15/15 |
| probar-rp-panel (build de producción) | 40/40 |
| recorrido-roles, 6 roles a 390 px (build de producción de `noche2`) | 32/32 |
| probar-caja-concurrencia | 29/29 |
| probar-caja-multi (Playwright, 3 sesiones) | 17/17 |
| verificar-cuadre | sin diferencias |
| probar-dashboards / en pantalla | 28/28 · 24/24 |
| probar-instalable | 34/34 |
| probar-fase2 / en pantalla (rama `fase2`) | 51/51 · 12/12 |
| `tsc`, `eslint`, `next build` | OK |

## Qué falló durante la noche (y cómo quedó)

- La primera prueba de 3 sesiones buscaba "$2,400.00" y la app escribe "$2,400": era la prueba, no la app.
- `app/manifest.ts` impedía que Staff y RP tuvieran su propio manifest: se cambió a un archivo estático.
- El servidor de desarrollo (Turbopack) no recogió un cambio de `globals.css`: hubo que reiniciarlo. Queda como lección en `CLAUDE.md`.
- Este Chromium no emula "modo instalado": la instalabilidad se comprobó con la API de Chrome.
- El recorrido sobre la vista previa protegida no se pudo hacer con Playwright (ver arriba).

## Decisiones que necesito de ti

1. **Integrar `noche2` a `desarrollo`** y, en el pase, aplicar el paso 7b
   (`caja-idempotencia` y `grupo-conversion`). Hasta entonces, nada de esto está
   en `desarrollo`.
2. **Tema** de nómina y /grupo: actual, oscuro o claro (ver capturas).
3. **Conversión**: ¿la noche en curso cuenta, o solo noches cerradas?
4. **Ticket**: ¿por cuenta (hoy en /grupo) o por reserva (hoy en el rendimiento
   por RP)?
5. **"Se fueron sin consumir"** (marca manual del staff): ¿se quita, ahora que
   la caja dice quién consumió?
6. **Iconos nuevos**: se cambiaron porque el morado contradice la marca. Si
   prefieres el anterior, se revierte en un commit.
7. **Fase 2**:
   - ¿la propina entra o no al conteo de caja?;
   - ¿se vende sin existencias?;
   - ¿se quita el concepto libre?;
   - ¿la propina es del mesero o de la mesa?
8. **Recorrido de Playwright sobre la vista previa protegida**: necesita tu
   permiso para usar el secreto de automatización de Vercel (ya existe; solo
   se usaría, nunca se imprime).

## Cómo probar cada cosa (usuarios dev; contraseña en `backups/dev-credenciales.json`)

| Qué | Usuario | Dónde |
|---|---|---|
| Caja: doble toque, sin conexión (modo avión), dos teléfonos en la misma mesa | `dev_staff` y `dev_gerente` | `/staff/caja` |
| Cobro simultáneo: abrir "Cobrar" en dos teléfonos y tocar a la vez | `dev_staff` + `dev_gerente` | una mesa con saldo |
| /grupo con conversión y rendimiento por RP | `dev_gerente` (1 antro), `dev_dueno` (2 antros) | `/grupo` |
| Nómina con etiquetas nuevas | `dev_gerente` / `dev_dueno` | `/staff/nomina`, `/dueno/nomina` |
| Temas | los mismos | agregar `?tema=oscuro` o `?tema=claro` |
| Instalar las apps | `dev_staff`, `dev_rp`, `dev_dueno` | Chrome Android: menú → Instalar app, desde cada panel |
| WhatsApp del RP | `dev_rp` o `demo_mariana` | Reservas → + Nueva reserva → Compartir por WhatsApp |
| Fase 2 | `dev_gerente` (catálogo), `dev_staff` (caja) | vista previa de `fase2` con `NEXT_PUBLIC_FASE2=1`, o local: `NEXT_PUBLIC_FASE2=1 node scripts/dev/servidor-prod-dev.mjs` |

Ojo: la noche demo es la del 19/11 y cambia a las 08:00. Para probar después,
regenerarla como dice `docs/avance.md`.
