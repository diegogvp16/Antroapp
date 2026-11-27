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

## Actualización 14:55

- **Integrados en `post-junta-3`:**
  - bloque 7, reportes PDF;
  - bloque 2, PWA y escáner de respaldo (`c51757a`), con sus 8 hallazgos corregidos. Pruebas: 47/47, 58/58, 48/48, 42/42, 13/13 y 41/41.
  - Después de cada merge: typecheck, lint y build limpios; C4 57/57.
- **`02-ip-cliente.sql` (`67f8fb4`): hallazgo de seguridad confirmado en dev con el gateway real.**
  - El primer valor de `X-Forwarded-For` lo escribe quien llama. Los topes por IP del 72/66 (reservas sin cuenta, que es pase 2) se esquivaban: sin el arreglo pasaron 21 de 21.
  - Arreglo: `ip_cliente()` usa `cf-connecting-ip` o el último salto. Prueba 10/10. Antiabuso 14/14 y concurrencia 52/52.
  - **Si el pase 2 sale antes que el 3, el 02 debe ir con el pase 2.**
- **`lib/funciones.ts` (`b124d9b`):** sin señal al abrir se usa la última respuesta guardada. Sale de la revisión de fase 2.
- **Revisiones adversariales hechas:** POS, antifraude, clientes, landing y fase 2. Todos sus hallazgos están en corrección dentro de cada carril.
- **14:40, límite de uso:** los 5 carriles en corrección se detuvieron y se reanudaron con su contexto a las 14:55.

## Actualización 15:20

- **Integrados en `post-junta-3`, cada uno después de su revisión y sus correcciones:**
  - 7 reportes PDF;
  - 2 PWA;
  - 5 landing (11 hallazgos);
  - 1 POS (9 hallazgos; 5,000 líneas en 3.4 s);
  - 4 y 6 clientes (8 hallazgos, entre ellos la enumeración gratis de la lista negra);
  - 8 fase 2 (10 hallazgos).
- **Después de cada merge:** typecheck, lint y build limpios; C4 57/57.
  - Una corrida intermitente falló: el cliente perdió la sesión, probablemente por el límite de Auth compartido entre carriles. Al repetirla salió 57/57.
- **Conflictos resueltos:** enlaces en los paneles de staff y dueño, donde se quedaron todos. El botón de catálogo se cambió por `EnlacesFase2`, que respeta la bandera.
- **`post-junta-3` en GitHub** (`d641849`), revisada antes sin secretos ni respaldos. `master` no se tocó.
- **En curso:**
  - antifraude, que corrige sus 9 hallazgos;
  - bloque 9: extender C4 y la auditoría C1/C5 a lo nuevo, en dos carriles.
- **Para el pase:** 80 y 81 requieren la fase 2 base (P11 del pase 2, opcional).
