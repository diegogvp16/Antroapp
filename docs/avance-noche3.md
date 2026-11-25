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

## Actualización 23:00

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

## Sigue

- Integrar los 6 carriles en `post-junta-2`.
- Después: C3 (límites y zod en endpoints públicos), C4 (suite E2E), C6 (360 px), C7 parte 2 (políticas de caja con InitPlan y `caja_firma_noche`).
- D3 (`pase-2.md`) y D4 (`avance.md`).
