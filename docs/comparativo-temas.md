# Comparativo de temas para las pantallas de números (bloque 4)

Propuesta, **sin elegir**: `/staff/nomina`, `/grupo` y `/dueno/nomina` en tres
versiones. Solo en la rama `noche2`; `desarrollo` no se tocó.

| Tema | Qué es |
|---|---|
| `actual` | Como antes: `.theme-control` (gris claro, solo Inter). En `noche2` sigue puesto. |
| `oscuro` | El lenguaje de la caja y del panel del RP (`.theme-caja`): fondo #0C0B0A, superficies #12100E, bordes #25211D, texto #F4EFE6, dorado #D4AF5A. |
| `claro` | La misma estructura en paleta clara sobria (`.theme-caja` + `.theme-caja-claro`): fondo hueso #F6F3EC, superficies #FFFDF8, bordes #E5DFD3, texto #1B1814, secundario #625A4F, **el mismo dorado** #D4AF5A como acento (rellenos, foco), siempre con texto oscuro encima. |

## Un solo punto para cambiarlo

`lib/tema-reportes.ts`:

```ts
export const TEMA_REPORTES: TemaReportes = "oscuro"; // en candidato-pase (23/11/2026)
```

Las tres pantallas se envuelven con `components/tema-reportes.tsx`, que pone
la clase. Los componentes de shadcn se restilizan solos por tokens
(`app/globals.css`); ningún color está escrito en las páginas.

Para comparar en la vista previa sin tocar código: agregar `?tema=oscuro` o
`?tema=claro` a la URL (por ejemplo `/grupo?tema=claro`). En producción ese
parámetro no aplica: manda la constante.

## Capturas

`screenshots-temas/<pantalla>-<tema>-<ancho>.png` (fuera de Git), con
`node scripts/dev/capturas-temas.mjs`: 3 pantallas × 3 temas × 390 y 1280 px
(18 capturas, todas sin scroll horizontal ni errores). Usuarios: `dev_gerente`
(nómina del staff) y `dev_dueno` (grupo y nómina del dueño).

## Para decidir

- En estas pantallas casi no hay acciones principales, así que el dorado se
  ve poco (foco, botones primarios, insignias). Si se elige `oscuro` o
  `claro`, se puede marcar en dorado la pestaña de periodo seleccionada,
  como en la caja.
- `oscuro` une todo lo que el staff usa de noche (caja, panel del RP,
  nómina). `claro` se lee mejor de día y en escritorio (el dueño revisando
  números en la oficina).
