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

## En curso

- Workflow de la parte A, en el worktree `prejunta`: A1, A2, A3, A4, A6, A7 y A8, cada uno con su revisor adversarial y su corrección.
- Workflow de inventario de la parte B, más las auditorías de solo lectura C2, C7 y C8.

## Sigue

- Parte B: implementación por grupos, en worktrees separados.
- Parte C: C1, C3, C4, C5 y C6 contra dev, en serie para no pisarse los datos.
- Parte D: documentación.
