# Rediseño de la caja (/staff/caja) — notas y propuestas

> 20/11/2026, rama `desarrollo`. La interfaz nueva usa solo lo que ya existe
> en la base. Todo lo que pediría cambiar la base está abajo como
> **propuesta, con SQL sugerido SIN ejecutar**.

## 1. Lo que hay hoy (revisado antes de diseñar)

**a) Cómo se guarda el consumo.** `caja_consumos` guarda un **monto en
centavos** y un **concepto libre opcional** (hasta 120 caracteres). **No hay
catálogo de productos**, ni cantidad, ni precio unitario. Para mostrar
renglones "cantidad × producto · precio" sin tocar la base, la interfaz
guarda el concepto como `"2 × Cerveza"` y el monto como el **total** del
renglón; al leerlo, lo separa (`leerRenglon` en `lib/domain/caja.ts`). Los
consumos viejos sin ese formato se ven como "1 × concepto".

**b) Las cuentas por persona.** Sí importan, para la **comisión**: cada
consumo pertenece a una cuenta (`mesa_cuentas`) y al cuadrar, cada RP cobra
sobre lo consumido en **su** cuenta. El **cuadre** de la mesa y de la noche
usa los totales de la mesa (no de las cuentas), y los pagos pueden ir a una
cuenta o a toda la mesa.
→ La interfaz **no muestra cuentas**. Solo cuando una mesa tiene más de un
cliente sentado, la hoja "Agregar consumo" pregunta "¿De quién es?" (una
fila de nombres); sin eso, la comisión de cada RP se calcularía mal. Los
cobros se registran a **toda la mesa**.

**c) Qué hacía "Abrir otra vez".** En el mapa, sobre una mesa **cuadrada**,
llamaba a `caja_abrir_mesa`: **crea un grupo nuevo** (sesión nueva) en la
misma mesa; el grupo cuadrado no se toca (la base no deja reabrir una mesa
cuadrada). Aparte existe `caja_reabrir_mesa`, que reabre una mesa
**cerrada sin cuadrar** (el mismo registro), con motivo.
→ En el diseño nuevo:
- "**Recibir nuevo grupo**" (botón principal de una mesa cuadrada) = grupo
  nuevo. El grupo anterior aparece colapsado, con candado, y nunca se
  modifica; se muestra el total de la mesa en la noche.
- "**Abrir otra vez…**" (solo gerente, dentro de "Más acciones", con motivo
  obligatorio como confirmación) = reabrir una mesa cerrada que aún no se
  cuadra.

**d) De dónde sale el nombre del cliente.** De `mesa_cuentas.cliente_nombre`:
la base lo copia de la reserva al sentar (o es el nombre escrito para un
walk-in). El RP sale de la cuenta (`rp_id`, que la base copia de la reserva
solo si el RP es de ese antro) y su nombre de `profiles`. Si hay varios
clientes en la mesa se muestra el primero y "+N". Sin nadie sentado se ve
"Sin cliente"; una mesa sin grupo, "Libre".

## 2. Lo que se hizo (solo interfaz)

- Tema oscuro `.theme-caja` (tokens en `app/globals.css`): fondo #0C0B0A,
  superficies #12100E, bordes #25211D, dorado #D4AF5A, texto #F4EFE6,
  secundario #A39B8F, ok #8FD1A4, aviso #E3BE6A. Solo Inter, sin sombras ni
  degradados, sin mayúsculas espaciadas. Botones de 44 px o más (el
  principal, 48 px).
- **Mapa**: encabezado compacto (fecha, estado de la noche y Consumo /
  Cobrado / Por cobrar en una línea), pestañas con conteo (Todas, Abiertas,
  Por cuadrar, Libres), buscador por mesa, cliente o RP, cuadrícula de 2
  columnas. El estado se lee por el color del cuadro: abierta (dorado
  tenue), por cuadrar (amarillo), cuadrada (apagada), libre (borde
  punteado). Tocar el cuadro abre el detalle (única acción).
- **Detalle**: barra con volver, mesa, estado y "Más acciones"; cliente en
  21 px con personas y RP, saldo a la derecha; consumo como renglones con
  total; cobros por forma de pago con hora; anulados plegados y tachados con
  su motivo (tocar un renglón permite anularlo con motivo, si hay permiso).
  Un solo botón principal fijo según el paso: Recibir grupo → Agregar
  consumo → Cobrar $saldo → Cuadrar mesa.
- **Hoja "Agregar consumo"**: buscador sobre lo **ya vendido esta noche**
  (sale de los consumos registrados; no es un catálogo), contador −/+ por
  producto, concepto con precio libre y cantidad, botón fijo "Agregar a la
  mesa · $X". Las **categorías** (Botellas, Cervezas, Mezcladores, Otros) no
  se pusieron: necesitan el catálogo (propuesta A).
- Archivos: `components/caja/mapa-noche.tsx`, `detalle-mesa.tsx`,
  `hojas-mesa.tsx`, `hoja.tsx`; `lib/domain/caja.ts` (resumen por mesa,
  renglones, búsqueda); `app/staff/caja/page.tsx`. Se retiraron los
  componentes viejos (mapa-mesas, mesa-detalle, cuenta-cliente, cobro-mesa,
  sentar-cliente). "Cuadre de la noche" sigue igual, ahora en tema oscuro.

## 3. Propuestas (NO aplicadas)

### A. Catálogo de productos con existencias por antro

Qué resuelve: precios fijos por antro, categorías en la hoja de consumo y
existencias que bajan con cada venta (y suben si se anula).

```sql
-- SUGERIDO, SIN EJECUTAR. Probar primero en antroapp-dev.
create table public.productos (
  id               uuid primary key default gen_random_uuid(),
  club_id          uuid not null references public.clubs (id),
  nombre           text not null check (char_length(nombre) between 1 and 80),
  categoria        text not null check (categoria in ('botellas', 'cervezas', 'mezcladores', 'otros')),
  precio_centavos  bigint not null check (precio_centavos between 1 and 100000000),
  existencias      int,             -- nulo = no se lleva inventario de este producto
  minimo_aviso     int,             -- avisar cuando quede esto o menos
  activo           boolean not null default true,
  creado_en        timestamptz not null default now()
);
create unique index productos_nombre_por_club on public.productos (club_id, lower(nombre));

-- El consumo recuerda qué producto, cuántos y a qué precio (el monto lo
-- sigue calculando la base: precio del catálogo × cantidad).
alter table public.caja_consumos
  add column producto_id uuid references public.productos (id),
  add column cantidad int check (cantidad between 1 and 99),
  add column precio_unitario_centavos bigint;

-- Bitácora de inventario: nada se borra, todo movimiento queda.
create table public.inventario_movimientos (
  id           bigint generated always as identity primary key,
  club_id      uuid not null references public.clubs (id),
  producto_id  uuid not null references public.productos (id),
  tipo         text not null check (tipo in ('venta', 'anulacion', 'entrada', 'ajuste')),
  cantidad     int not null,        -- negativa en venta, positiva en anulación/entrada
  consumo_id   uuid references public.caja_consumos (id),
  motivo       text check (char_length(motivo) <= 300),
  hecho_por    uuid references public.profiles (id),
  hecho_en     timestamptz not null default now()
);

-- GRANT explícitos (en dev no hay exposición automática) y RLS:
-- lectura con caja_puede_ver(club_id); escritura solo por funciones.
-- Funciones nuevas (SECURITY DEFINER, mismo patrón que la caja):
--   caja_registrar_consumo_producto(p_cuenta_id, p_producto_id, p_cantidad)
--     -> monto = precio × cantidad, movimiento 'venta', baja existencias
--        (no deja bajar de 0 si se lleva inventario).
--   caja_anular_consumo: si el consumo tiene producto_id, movimiento
--     'anulacion' y regresa las existencias.
--   productos_guardar(...) e inventario_entrada(...): dueño o gerente.
```

En la interfaz: categorías en la hoja, producto con precio fijo, aviso de
"quedan 3" y una pantalla de catálogo/inventario para el gerente.

### B. Propina por cobro, con total por mesa y por noche

```sql
-- SUGERIDO, SIN EJECUTAR.
alter table public.caja_pagos
  add column propina_centavos bigint not null default 0
    check (propina_centavos between 0 and 100000000);

-- caja_registrar_pago recibe p_propina_centavos (nuevo parámetro con
-- default 0, para no romper llamadas actuales). La propina NO cuenta para
-- el saldo de la mesa ni para la comisión: saldo = consumo - monto.
-- caja_cuadres: agregar propina_efectivo_centavos, propina_tarjeta_centavos
-- y propina_otro_centavos (mesa y noche), calculadas por la base.
-- En el cuadre de la noche, el conteo físico compara contra monto + propina
-- de cada forma de pago.
```

En la interfaz: campo "Propina" en la hoja Cobrar; total de propina por mesa
en el detalle y por noche en el encabezado y en el cuadre.

### C. Mismo lenguaje visual en /staff/nomina, /grupo y /dueno/nomina

1. Pasar a componentes compartidos lo que ya usa la caja: `Hoja`,
   `BotonPrincipal`, `Contador`, la línea de totales del encabezado y las
   pestañas con conteo.
2. Envolver esas pantallas en `.theme-caja` (los tokens de shadcn ya se
   re-mapean solos) y quitar colores sueltos.
3. Nómina: tarjeta por RP como el cuadro de mesa (nombre principal, total y
   estado por color: pendiente, en revisión, validada, pagada, anulada), una
   sola acción principal por estado y "Anular" en "Más acciones".
4. Grupo: encabezado con totales en una línea y antros como cuadros, por
   ciudad.
5. Decidir con Diego si el dueño (que revisa de día, en oficina) quiere el
   tema oscuro o mantiene el claro: el oscuro está pensado para operar en el
   antro de noche.

## 4. Datos del demo que faltan o se ven vacíos

- **Libres: 0.** Club Demo Dev tiene 12 mesas y la noche demo las usa todas;
  para ver mesas libres hace falta agregar mesas al antro de dev (el diseño
  está pensado para hasta 50).
- Los walk-ins no tienen RP (correcto) y se ven "Sin RP".
- La noche demo es la del 19/11: al cambiar la noche (08:00) hay que volver
  a sembrar (`sembrar-dev` y luego `demo-datos --env=.env.dev --si`).
- En **producción**, `scripts/demo-datos.mjs` todavía registra los consumos
  con el modelo viejo (`consumption_entries`): después del pase, la demo de
  producción tendrá que crear la caja con las funciones de la base.
