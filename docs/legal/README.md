# Documentos legales de AntroApp — BORRADORES

> **BORRADOR: requiere revisión de un abogado.** Nada de esta carpeta es
> asesoría legal. Son puntos de partida escritos a partir de cómo funciona la
> app hoy (24/11/2026), para que un abogado los corrija y los apruebe antes de
> publicarlos. Las partes entre corchetes `[así]` son datos que faltan.

| Archivo | Para qué | Se publica en |
|---|---|---|
| `terminos.md` | Términos de uso de la plataforma (clientes, RPs, personal y antros) | `/terminos` |
| `reservas-y-qr.md` | Política de reservas y naturaleza del QR («no garantiza la entrada») | `/terminos` (al final) |
| `privacidad.md` | Aviso de privacidad integral (ley mexicana de datos personales) | `/privacidad` |
| `contrato-antro.md` | Contrato modelo de servicio con cada antro | No se publica: se firma con cada antro |
| `inventario-datos.md` | Qué datos personales guarda la app hoy, tabla por tabla | Interno (base del aviso de privacidad) |

## Cómo se publican

Las páginas `/terminos` y `/privacidad` y las casillas de aceptación (registro
del cliente y primera entrada del RP) están detrás de la bandera
**`NEXT_PUBLIC_LEGALES=1`**, apagada por defecto. Con la bandera apagada las
páginas responden 404 y los formularios no cambian.

El texto que muestran las páginas sale de estos mismos archivos. Después de
editar `terminos.md`, `reservas-y-qr.md` o `privacidad.md`:

```bash
node scripts/legal-a-paginas.mjs            # regenera lib/legal/textos.ts
node scripts/legal-a-paginas.mjs --revisar  # falla si las páginas no coinciden con los .md
```

y cambia `VERSION_LEGAL` en `lib/legal/version.ts`: así a quien ya aceptó una
versión anterior se le vuelve a pedir que acepte (la aceptación se guarda por
versión en `aceptaciones_legales`, `sql/post-junta/05-legales.sql`).

## Preguntas abiertas para el abogado

1. **Ley vigente**: en marzo de 2025 se publicó una nueva Ley Federal de
   Protección de Datos Personales en Posesión de los Particulares y
   desapareció el INAI. Confirmar la ley, el reglamento y la autoridad
   vigentes y ajustar las referencias.
2. **¿Responsable o encargado?** Los datos de una reserva (nombre, teléfono)
   los usa el antro para recibir al cliente. Definir si AntroApp es
   responsable, encargado del antro, o ambos según el dato.
3. **Menores de edad**: la app no pide edad ni identificación; la edad mínima
   la revisa el antro en la puerta. ¿Basta con declarar que el servicio es
   para mayores de 18 años?
4. **Transferencias internacionales**: Supabase y Vercel pueden alojar datos
   fuera de México. Confirmar región y si hace falta consentimiento.
5. **Datos de RPs**: comisiones y pagos son datos patrimoniales. ¿Hace falta
   consentimiento expreso por escrito?
6. **Conservación**: plazos propuestos en `privacidad.md` (por definir).
