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

## Actualización 14:15

- **`01-largos-texto.sql` (`aaedb90`)**: la revisión del bloque 7 encontró que un RP puede ponerse un nombre de 20,000 letras.
  - Se agregaron checks `NOT VALID`: nombre ≤ 120 y teléfono ≤ 30, en `profiles` y `reservations`.
  - El mensaje de error es claro.
  - Prueba: 10/10.
- **Bloque 7, reportes PDF: integrado** (`0721dd4`).
  - La revisión adversarial encontró 4 defectos y los 4 se corrigieron: rendimiento con nombres enormes, cuadre y anulaciones que faltaban, descarga en iOS y caracteres invisibles.
  - Pruebas: 38/38, 34/34 y 152/152.
  - Después del merge: typecheck, lint y build limpios; C4 57/57.
- **Bloque 3, antifraude: terminado**, en corrección después de su revisión.
  - Defecto alto: la detección no termina en un antro con volumen real; pasa del límite de 8 s.
  - Reglas que no hacen lo que dicen: teléfonos con formato raro, una alerta por semana y escaneos duplicados que nunca disparan.
- **Bloque 2, PWA y escáner: terminado**, en corrección después de su revisión.
  - Defecto alto: con la bandera encendida se abren dos cámaras.
  - Con mala señal se borraba la copia local.
- **Bloque 1, POS: terminado** (160/160, 135/135, 50/50) y en revisión.
- **En curso:** clientes (lista negra y WhatsApp), landing y fase 2.
