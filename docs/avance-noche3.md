# Avance de la noche 3 (24–25/11/2026)

Bitácora por si se corta la sesión. Se actualiza cada ~2 horas.
Reglas: nada se escribe en producción; nada de merge ni push a `master`.

## Ramas

| Rama | Base | Para qué |
|---|---|---|
| `desarrollo` | `master` + reporte del pase | Subida a GitHub (`5c8edfb`) |
| `post-junta` | + merge de `master` (`85f5a5e`) | Ya trae los pasos 2b, 7c/10a y 7d |
| `prejunta` | `master` (`771e7d3`) | Parte A (junta). Worktree aparte: `C:\Users\diego\Proyectos\AntroApp-prejunta` |
| `post-junta-2` | `post-junta` (`85f5a5e`) | Partes B y C. Árbol principal |

## Estado de antroapp-dev

- 21:11: respaldo en `backups/dev-2026-11-25-03-11-antes-noche3`.
- Se bajó al esquema de producción (rollback del pase 2, más 10a, 7d y 2b otra vez). El esquema quedó igual al de producción salvo dos GRANT sin efecto.
- Ahí se ensayó `demo-datos` (A5).
- Después se volvió a subir a post-junta con `ensayo-pase2 aplicar`.

## Hecho

- **Bloque 0:**
  - commit y push de `desarrollo`;
  - `master` integrado en `post-junta` sin conflictos (no redefine `registrar_*`, y el 10a es el mismo);
  - ramas `prejunta` y `post-junta-2` creadas.
- **A5:** ensayo de `demo-datos` en dev con el esquema de producción.
  - 135 reservas, 4 noches, 35 mesas, 66 comisiones, en 72 s.
  - `verificar-cuadre`: 1,005 revisiones, **sin diferencias al centavo**.
  - Comando para producción (25/11, después de las 08:00, en `master`):
    `node scripts/demo-datos.mjs --fecha=2026-11-25` y luego lo mismo con `--si`.
- **Typecheck y lint de `post-junta-2` después del merge:** limpios.

## Actualización 22:00

- **Hueco CRÍTICO vigente en producción** (auditoría C2):
  - **El hueco:** `profiles_insert_propio` deja que una cuenta recién registrada cree su propio perfil como `dueno` con el `club_id` de cualquier antro.
  - **Probado en dev con sesión real:** leyó 135 reservas con teléfono, personal, sueldos y comisiones, y pudo crear mesas y dar de baja RPs.
  - **El arreglo:** `sql/2026-11-25-perfil-sin-club-ajeno.sql`, con rollback y prueba `scripts/dev/probar-perfil-club-ajeno.mjs` (4/4). Va en `post-junta-2` y en `prejunta`.
  - **En producción:** 0 perfiles sospechosos (solo conteo). **No se aplicó en producción**: lo decide Diego.
- **Parte A** (`prejunta`), lista y con revisión adversarial:
  - **A1:** `docs/manana-junta.md`.
  - **A2:** `scripts/ensayo-demo.mjs` (18 OK, 10 AVISO por los datos viejos, 0 FALLA).
  - **A3:** `scripts/capturas-presentacion.mjs`, 44 capturas. Hay que repetirlo mañana después de `demo-datos`.
  - **A4:** arreglos de ficha y catálogo, con `docs/revision-ficha-club-demo.md`.
  - **A6, A7 y A8:** preguntas, piloto y objeciones.
  - **Guion corregido:** el minuto 0:30 fallaba porque `/cliente` pide sesión.
- **D1 y D2** (`prejunta`): runbook de la noche y manuales de staff y RP.
- **C7** (`post-junta-2`):
  - 16 índices, versión dev y versión de producción con CONCURRENTLY, verificados con EXPLAIN;
  - el escáner se carga al abrir la cámara (13/13).
- **C8** (`post-junta-2`): el QR del boleto ya no se guarda en `app_errores`, y la consola ya no muestra filas completas (10/10, monitoreo 8/8).
- **Workflow de la parte B, C1 y C5:** corriendo en 6 worktrees (`AntroApp-wt/b-*`, `c-rls`).

## Corte por límite de uso (23:40 → 09:28)

Los workflows se detuvieron a las 23:40 por el límite de 5 horas. La sesión se
reanudó a las 09:28 del 25/11, con la compu en batería (100%).

- Terminó la primera etapa de 5 carriles: B5, B7, B11, B6 y B9.
- Lo demás quedó a medias. Se commiteó como checkpoint "PARCIAL" en cada carril y se reanudó el workflow con su caché.

Mientras tanto, en `post-junta-2`:

- **C3:** límites a las reservas sin cuenta, en la base (`72`, 14/14).
- **C7 parte 2:** políticas de caja con un conjunto calculado una vez por consulta (`71`, 28/28; consumos de la noche de 31.6 ms a 0.43 ms). Todavía no se aplica en dev.

## demo-datos en PRODUCCIÓN (autorizado por Diego, 25/11, 10:00)

Es el único cambio en producción autorizado hoy.

1. **Revisión previa (solo lectura):**
   - fecha operativa 2026-11-25, Club Demo publicado, `staff.demo` activo y en Club Demo;
   - línea base: 127 reservas demo (40 del 25/11, **creadas el 19/11** por la corrida anterior, que ya traía esa noche), 0 no-demo, caja vacía, 0 reservas y 0 caja en otros antros, 78 comisiones, 180 consumos viejos;
   - en resumen: `demo-datos` no había corrido hoy.
2. **Respaldo:** `backups/prod-2026-11-25-antes-demo-datos/`, solo local. Trae reservas, consumos y comisiones de Club Demo, la caja de Club Demo, las tablas de RP de las cuentas `demo_*`, sus perfiles y la fila del antro.
3. **Corrida:**
   - simulación idéntica a la de dev;
   - `node scripts/demo-datos.mjs --fecha=2026-11-25 --si`, de 10:00:28 a 10:01:55;
   - resultado: 4 noches, 35 mesas, 173 consumos, 66 comisiones, cada noche "✓ coincide con la base".
4. **Verificación de solo lectura:**
   - **cuadre:** `verificar-cuadre` sin diferencias, 651 revisiones (copia temporal contra producción con sesión de solo lectura; el script del repo solo corre en dev);
   - **antes contra después:** solo cambió Club Demo. Otros antros: 0 y 0. Grupos y antros, iguales. `staff.demo` abrió 4 noches y registró 173 consumos;
   - **humo:** 84/84;
   - **ensayo del guion:** 24 OK, 4 AVISO conocidos, 0 FALLA, sin escrituras.
5. **Capturas:** `C:\Users\diego\Proyectos\AntroApp\screenshots-presentacion\`, 23 en móvil y 23 en escritorio, con `INDICE.md`.
6. **Rollback** (no hizo falta):
   - primero `sql/limpiar-demo-caja.sql` en el SQL Editor, porque la caja no se borra por la API;
   - después, reponer reservas, consumos, comisiones y tablas de RP desde el respaldo.

## Hueco del perfil en PRODUCCIÓN (autorizado por Diego, 25/11)

- **Revisión:** la de 5 líneas, entregada.
- **Respaldo:** `backups/prod-2026-11-25-antes-perfil/`, con 28 perfiles y 7 políticas de `profiles`. Había 0 clientes o dueños con `club_id`.
- **SQL:** copiado al portapapeles de Diego dos veces, con la ruta: Antroapp, `kigltjvakwuuulvzbyri`, SQL Editor.
- **Pendiente:** que Diego lo corra y diga «listo». Después se verifica, solo leyendo, la política, la prueba del hueco en dev, el recorrido 49/49, el humo 84/84 y el login y registro.

## Integración (25/11, tarde)

- **La parte B y C1/C5 terminaron**, con revisión adversarial y correcciones en cada carril:
  - todos los defectos que encontró el revisor eran reales;
  - se corrigieron todos menos los que quedaron como decisión de Diego.
- **Commits por carril:**
  - `c6185ee` b-cliente;
  - `464beca` b-reportes;
  - `0aa928b` b-alta;
  - `941fd6a` b-equipo;
  - `f17ba51` b-caja;
  - `8b695c0` c-rls.
- **Merge en `post-junta-2`:** en orden B10, B11/B4, alta, equipo, caja y RLS. Hubo un solo conflicto, en los botones de `/admin`, y se quedaron todos.
- **Typecheck, lint y build:** limpios.
- **71 (C7 parte 2) aplicado en dev:**
  - prueba del 71: 9/9;
  - caja: 168/168;
  - concurrencia: 29/29.
- **C4 con todo integrado: 57/57 pasos, 9/9 flujos.** Las dos fallas de la mañana eran de la app y quedaron resueltas. Solo cambiaron los textos del formulario.
- **Ensayo de toda la cadena del pase 2** (38 pasos, `ensayo-pase2 completo --comparar-prod`):
  - el esquema queda idéntico después de revertir y reaplicar;
  - dev revertido queda igual a producción, salvo la política del perfil (pendiente) y GRANT a `service_role`.
- **Hallazgo y arreglo:** el rollback del `post-junta/10` regresaba 6 funciones a antes del 10a. En producción habría reabierto el hueco ALTO del pase 1. Ahora regresa a lo que hay hoy en producción (`69edb31`).
- **Privilegios de producción:**
  - allá, lo nuevo nace abierto a `anon`; en dev, no;
  - simulación en dev (`simular-privilegios-prod.mjs`): 0 funciones o tablas abiertas sin probar;
  - un control confirma que la simulación sí reproduce producción.
- **D3:** `docs/pase-2.md`.
- **C6, accesibilidad a 360 px:** 54 pantallas. Pasó de 10 hallazgos a 0:
  - «Volver» y puntos de la galería a 40 px;
  - el aviso de suscripción del dueño ya no desborda.
- **D4:** `docs/avance.md`.
