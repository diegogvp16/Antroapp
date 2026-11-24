# Números que se le muestran al cliente (noche 2, bloque 2)

Revisión de los tableros del gerente (`/staff/panel` y `/grupo`), del dueño
(`/grupo`, `/dueno/nomina`) y del dueño de grupo (`/grupo`). Todo en la rama
`noche2` y en antroapp-dev; **nada en producción**.

## Cómo se verificó

- `node scripts/verificar-cuadre.mjs`: cada cifra de `/grupo`, nómina y panel
  del RP contra la caja y conteos directos en la base, por antro y semana
  (1,015 revisiones, sin diferencias de un centavo).
- `node scripts/dev/probar-dashboards.mjs` (28/28): quién ve qué a nivel de
  consulta, con las cuentas dev reales.
- `PLAYWRIGHT_DESDE=… node scripts/dev/probar-dashboards-pantalla.mjs` (24/24): lo
  mismo en pantalla a 390 px, y que el consumo que se ve sea el de la base.
  Capturas en `screenshots-dashboards/`.

## Lo que estaba confuso o mal etiquetado, y cómo quedó

| Dónde | Antes | Problema | Ahora |
|---|---|---|---|
| Panel de staff/gerente | "Sin consumo" | Solo cuenta a quien el staff marcó a mano "se retiró sin consumir"; un cliente que entró y no consumió en caja no aparece. | "Se fueron sin consumir". |
| `/grupo` | "% de entrada" sobre todas las reservas del rango | Las reservas de noches que aún no llegan (mañana, dentro de "esta semana") contaban como "no entró". Con la demo: 27 de 48 = 56 % en lugar de 27 de 40 = 68 %. | Reservas con "N por venir"; entrada y conversión sobre las reservas que ya podían llegar. |
| `/grupo` | No había conversión | El cliente pidió "reservas que consumen / reservas". | "Consumieron" con "% de conversión" (reservas cuya cuenta tuvo consumo vigente). |
| `/grupo` | "Consumo" | Mezclaba con y sin reserva sin decirlo. | "Consumo en caja" con el detalle "$X con reserva". |
| `/grupo` | "Ticket promedio" junto a "Reservas" | Es por **cuenta** con consumo (incluye clientes sin reserva), no por reserva. | "Ticket promedio por cuenta", con el número de cuentas. |
| `/grupo` | "Comisiones" | Incluye también los pagos por día. | "Comisiones y pagos a RPs". |
| `/grupo` | No había rendimiento por RP | — | Sección "Rendimiento por RP" por antro: reservas (por venir), entraron, consumieron (%), consumo, ticket por reserva que consumió y comisiones + pagos. Abierta de entrada cuando es un solo antro (gerente). |
| Nómina (`/staff/nomina`, `/dueno/nomina`) | "Comisiones: N" | Cuenta también las de $0 (antes de llegar a la cuota): "4 comisiones" con 2 pagadas confunde. | "Consumieron" (y en el total: "N consumieron (mesas cuadradas)"). |

## Cifras de la demo de dev (semana del 16 al 22 de noviembre, Club Demo Dev)

Como se ven en `/grupo` con `dev_gerente` (y coinciden con la base):

| Cifra | Valor |
|---|---|
| Reservas | 48 (8 por venir) |
| Entraron | 27 (68 % de 40) |
| Consumieron | 24 (60 % de conversión) |
| Consumo en caja | $192,235 ($161,250 con reserva) |
| Ticket promedio por cuenta | $5,195.54 (37 cuentas) |
| Comisiones y pagos a RPs | $1,700 |

Por RP (consumo): Mariana Ruiz $53,800 (7 de 10 consumieron), Diego Ramírez
$39,850 (5 de 8; $0 de comisión porque no llega a su cuota de 10),
Fernanda Ortiz $26,650, Luis Herrera $21,200, Valeria Cantú $19,750.

## Acceso (consulta y pantalla)

| Quién | `/grupo` | Rendimiento por RP |
|---|---|---|
| Gerente activo | solo su antro | solo su antro |
| Dueño | sus antros y los de su grupo | ídem |
| Dueño de otro antro | solo el suyo | solo el suyo |
| Staff, RP, cliente | 0 antros (pantalla: "Esta vista es para dueños y gerentes") | rechazado |
| Anónimo | rechazado | rechazado |

## SQL

`sql/2026-11-21-grupo-conversion.sql` (rollback probado: esquema idéntico):
`grupo_resumen` con tres columnas nuevas al final y `grupo_rendimiento_rp`.
Solo dev. La pantalla funciona también sin él (las cifras nuevas no
aparecen y el rendimiento dice "todavía no está disponible").

## Decisiones para Diego

0. **Decidido el 23/11/2026** (rama `candidato-pase`): la conversión se
   calcula **solo con noches cerradas** (ya pasó su corte de las 08:00 o el
   gerente la cerró en la caja). La noche en curso no la baja.
1. ~~**Definición de conversión**~~ (resuelto arriba): hoy es "reservas cuya cuenta tuvo consumo /
   reservas que ya podían llegar". La noche en curso cuenta completa (las que
   aún no llegan bajan el % hasta que cierre la noche). ¿Se excluye la noche
   en curso?
2. **Ticket por cuenta vs. por reserva**: `/grupo` muestra por cuenta (con y
   sin reserva) y el rendimiento por RP, por reserva que consumió. ¿Cuál
   quiere ver el cliente arriba?
3. El panel de staff sigue mostrando "Se fueron sin consumir" (marca manual).
   Con la caja, ese botón casi no hace falta. ¿Se quita?
