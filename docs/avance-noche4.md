# Avance de la noche 4 (27/11/2026)

Bitácora por si se corta la sesión. Se actualiza cada ~2 horas.

Reglas:

- Nada se escribe en producción.
- Nada de merge ni push a `master`.
- Todo SQL nuevo lleva su rollback y se prueba en dev.
- Cada función nueva va detrás de una bandera por antro o por grupo, apagada por defecto.

## Rama y carriles

- **Rama:** `post-junta-3`, que sale de `post-junta-2` (`6daa21b`).
- **Cada carril** trabaja en su worktree (`C:\Users\diego\Proyectos\AntroApp-n4\<carril>`) y en su rama `n4-<carril>`.
- **Integración:** el coordinador integra cada rama en `post-junta-3` con su revisión.

| Carril | Bloque | SQL | Bandera |
|---|---|---|---|
| `pos` | 1. Ventas del POS | 10–19 | `pos_ventas` |
| `pwa` | 2. PWA y escáner de respaldo | 20–29 | `escaner_respaldo` |
| `fraude` | 3. Antifraude de RPs | 30–39 | `antifraude` |
| `clientes` | 4. Lista negra y no-show; 6. WhatsApp | 40–49 y 60–69 | `lista_negra`, `whatsapp` |
| `landing` | 5. `/para-clubes` | 50–59 | de plataforma (no hay antro) |
| `reportes` | 7. Reportes PDF | 70–79 | `reportes_pdf` |
| `fase2` | 8. Inventario y propinas | 80–89 | `inventario`, `propinas` |

## Hecho

- **Base (`dc6a035`): banderas por antro y por grupo** (`sql/post-junta-3/00-funciones-club.sql`).
  - Tablas `club_funciones` y `grupo_funciones`, más bitácora. La API no las toca directo.
  - Funciones:
    - `funcion_activa`: solo para la base;
    - `mis_funciones`: para la app, solo de antros que quien llama puede ver;
    - `funciones_estado` y `funcion_cambiar`: solo el admin.
  - Pantalla `/admin/funciones` y `lib/funciones.ts`.
  - Pruebas en dev: 31/31. Rollback idéntico y reaplicación igual.
- **Máquina:** 16 núcleos, 31 GB de RAM, conectada a la corriente. Corren 5 carriles a la vez y luego los otros 2.
