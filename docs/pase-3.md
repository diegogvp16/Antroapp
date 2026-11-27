# Pase 3 — `post-junta-3` a producción

> **NO EJECUTADO.** Escrito el 27/11/2026 (noche 4). Va **después** del pase 2
> (`docs/pase-2.md`), y el pase lo pide Diego de forma explícita.
> Todo lo nuevo está detrás de banderas **apagadas**: al terminar el pase,
> la app se comporta igual que antes hasta que el admin encienda una función
> en `/admin/funciones` para un antro o un grupo.

## Antes de empezar

1. **El pase 2 debe estar completo.**
   - El 80 y el 81 (inventario y propinas) además requieren la fase 2 base (P11 del pase 2, opcional). Si el pase 2 se hizo sin la fase 2, **se saltan** el 80 y el 81 (y su bandera no se enciende).
2. **El `02` (IP real en los topes) es un arreglo de seguridad del pase 2.**
   - Si el pase 2 sale antes que este, el `02` debe ir **con el pase 2**, justo después del 66.
   - Sin él, el tope de reservas sin cuenta por IP se esquiva con un encabezado inventado. Se confirmó en dev: 21 de 21 pasaron.
3. **Diagnóstico obligatorio del `01`** (solo conteos): `node scripts/db/conteos-prod.mjs`, consulta `largos_texto`.
   - Las cuatro cifras deben ser 0. El 27/11 dieron 0, 0, 0 y 0.
   - Si alguna no es 0, el `01` falla entero sin dejar nada: hay que acortar esas filas antes.
4. **Respaldo del día visible** en Supabase → Database → Backups.
5. **Llevar a mano** el esquema de producción y la lista de pasos.

## Orden

Todo el SQL es compatible con el código de hoy (el del pase 2): **primero el
SQL, después el merge**. Cada archivo va en su propia transacción y tiene su
rollback.

| Paso | Archivo (`sql/post-junta-3/`) | Qué hace | Notas |
|---|---|---|---|
| T1 | `00-funciones-club.sql` | Banderas por antro y por grupo (`club_funciones`, `grupo_funciones`, bitácora), todas apagadas | Base de todo lo demás |
| T2 | `01-largos-texto.sql` | Nombre ≤ 120 y teléfono ≤ 30 en `profiles` y `reservations` (validados) | Diagnóstico antes (arriba) |
| T3 | `02-ip-cliente.sql` | `ip_cliente()` y la IP real en los topes de reservas sin cuenta | Si no fue con el pase 2 |
| T4 | `10-pos-ventas.sql` | Ventas del POS: mapeos, importaciones, ventas, conciliación | |
| T5 | `20-escaner-respaldo.sql` | Código corto del boleto y entradas sin señal | Índice parcial en `caja_eventos` |
| T6 | `30-antifraude-rps.sql` | Reglas, alertas y revisión de RPs | |
| T7 | `40-lista-negra.sql` | Lista negra y no-show por antro | **Toca `reservations`**: dos triggers AFTER y un índice. Fuera de horario de operación |
| T8 | `50-para-clubes.sql` | `/para-clubes`: bandera de plataforma, contactos y bitácora | Después del T3 (usa `ip_cliente`) |
| T9 | `60-whatsapp-plantillas.sql` | Plantillas de WhatsApp por antro | Después del T7 |
| T10 | `70-reportes-pdf.sql` | Reportes PDF de noche y semana | Solo funciones |
| T11 | `80-inventario.sql` | Inventario completo | **Solo con la fase 2 base** |
| T12 | `81-propinas.sql` | Propinas y reparto | **Solo con la fase 2 base** |
| T13 | — | Merge de `post-junta-3` a `master` (publica el código; banderas apagadas) | Vercel → Instant Rollback |
| T14 | — | Humo (`node scripts/humo-produccion.mjs https://antroapp.vercel.app --navegador`), `/api/salud` y recorrido de roles | |

Después de cada SQL: verificar por introspección (catálogo de producción en
solo lectura) que quedó, como en los pases 1 y 2.

### Merge (T13)

```bash
git fetch origin
git checkout master && git pull --ff-only
git merge --no-ff origin/post-junta-3 -m "Pase 3: post-junta-3 (banderas apagadas)"
git push origin master          # publica en producción (Vercel)
```

Si GitHub protege `master` con PR obligatorio, el merge va por PR.

## Rollback

En orden inverso (T12 → T1), cada uno con su `-rollback.sql`. Cuidados:

- **81 (propinas):** su rollback **borra registros de dinero** (propinas y repartos). El archivo empieza con una consulta de respaldo; exportar antes.
- **40 (lista negra):** borra bloqueos y su historial. Respaldar antes si ya se usó (`docs/respaldos.md`).
- **50:** su rollback no toca `ip_cliente`. El del `02` va después y regresa la función del 66 exacta.
- **00:** va al final, porque todos los demás usan `funcion_activa`.
- **El código:** Instant Rollback de Vercel. El SQL es compatible con el código anterior, así que se puede revertir el código sin revertir el SQL.

## Lo que Diego hace a mano

**Para el pase:**

1. **Supabase → Database → Backups:** confirmar el respaldo del día.
2. **Supabase → SQL Editor** (Antroapp, `kigltjvakwuuulvzbyri`): una consulta nueva por archivo, en el orden de la tabla. El T7 va fuera del horario del antro.
3. **GitHub:** `post-junta-3` ya está en GitHub. El merge a `master` lo autoriza Diego.

**Al encender funciones, después del pase** (en `/admin/funciones`, primero en un solo antro):

- **Ventas del POS, escáner de respaldo, revisión de RPs, reportes PDF:** nada externo.
- **Lista negra y no-show:** antes, el **aviso de privacidad** tiene que mencionar la lista negra (decisión con abogado). El bloqueo automático viene apagado.
- **WhatsApp:** nada externo. Solo arma enlaces `wa.me`; no se manda nada por API.
- **Inventario y propinas:** además `NEXT_PUBLIC_FASE2=1` en Vercel (y redeploy).
- **`/para-clubes`:**
  - **no encenderla mientras Club Demo tenga las fotos de SIX GDL**;
  - precio «[por definir]»;
  - el aviso de privacidad debe mencionar el formulario;
  - si se exige CAPTCHA (`contacto_requiere_captcha`), Turnstile tiene que estar encendido; para apagar Turnstile, primero dejar de exigirlo;
  - opcional: `NEXT_PUBLIC_CLUB_DEMO_ID` en Vercel para fijar el antro de ejemplo.
- **Correos reales y alertas:** lo de `docs/pase-2.md` (Resend y `CORREO_MODO`).

## Ensayo en dev

`node scripts/dev/ensayo-pase3-paso-a-paso.mjs` parte de dev con todo el
pase 2 (fase 2 incluida). Primero revierte la cadena del pase 3 y compara con
la foto del final del ensayo del pase 2. Después, para cada paso:

- aplica;
- corre el rollback y revisa que el esquema quede idéntico al de antes;
- vuelve a aplicar y revisa que quede idéntico al primer aplicar.

**Resultado del ensayo (27/11):**

- **12/12 pasos** con rollback exacto y reaplicación igual, en 2.8 min.
- Revertir toda la cadena dejó dev **idéntico** al final del ensayo del pase 2.
- En dev, por script, cada archivo tarda de 1.3 a 1.5 s.

**Privilegios de producción:** `node scripts/dev/simular-privilegios-prod.mjs`
copia en dev los privilegios por defecto de producción y corre la cadena del
pase 2 + pase 3 (50 pasos, 324 objetos). Resultado: **0** funciones o tablas
quedarían abiertas en producción sin haberse probado en dev. Un control
confirma que la simulación sí reproduce producción.

### Tiempo estimado en producción (a mano)

| Bloque | Pegadas | Estimado |
|---|---|---|
| Diagnóstico (conteos) y respaldo visible | — | 10 min |
| T1–T12 (sin el 02 si ya fue con el pase 2) | 11–12 | 25 min |
| T13: merge y deploy | — | 10 min |
| T14: humo, `/api/salud` y recorrido | — | 30 min |
| **Total** | | **≈ 1 h 15 min** |

## Pruebas en dev (27/11, con todo integrado)

```bash
node scripts/dev/ensayo-pase3-paso-a-paso.mjs      # 12/12, base = final del pase 2
node scripts/dev/simular-privilegios-prod.mjs      # 0 abiertos sin probar (pase 2 + 3)
PLAYWRIGHT_DESDE=<carpeta> node scripts/dev/e2e/correr.mjs --base=http://localhost:3031   # 112/112, 19/19, dos veces seguidas (servidor con NEXT_PUBLIC_FASE2=1)
node scripts/dev/auditoria-rls.mjs --estricto      # C1: 14,116/14,116 (dos corridas)
node scripts/dev/probar-concurrencia-noche3.mjs    # C5: 129/129 (dos corridas)
node scripts/dev/probar-funciones-club.mjs         # 31/31
node scripts/dev/probar-largos-texto.mjs           # 10/10
node scripts/dev/probar-ip-cliente.mjs             # 10/10 (gateway real)
```

Cada carril tiene sus pruebas y sus resultados en `docs/post-junta-3/<carril>.md`.
