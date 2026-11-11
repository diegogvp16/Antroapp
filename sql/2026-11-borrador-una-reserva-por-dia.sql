-- ============================================================================
-- AntroApp — BORRADOR: máximo 1 reserva por cliente, antro y día
-- Fecha: 2026-11-11
-- Estado: SIN EJECUTAR. Revisar los supuestos antes de correrlo.
--
-- Lo que hay hoy en producción (leído el 11/11/2026 con service role):
--   * 27 reservas. status: 21 'pendiente', 6 'usada'. No existe ningún
--     estado 'cancelada' (ni en la base ni en el código).
--   * 21 de 27 tienen cliente_id NULO (reservas sin cuenta y las que crea
--     un RP a nombre de su cliente).
--   * 0 duplicados por (cliente_id, club_id, fecha).
--   * 2 grupos duplicados por (cliente_telefono, club_id, fecha). Solo
--     importan si se elige la OPCIÓN B de abajo.
--
-- SUPUESTOS (decide Diego):
--   1. Qué estados cuentan: 'pendiente', 'confirmada' y 'usada'. Se escribe
--      como lista explícita de los que SÍ cuentan, así que si mañana se
--      agrega 'cancelada' (o cualquier otro), automáticamente NO cuenta y un
--      cliente que canceló puede volver a reservar ese día.
--   2. Reservas con cliente_id NULO (anónimas y de RP): la OPCIÓN A no las
--      limita. En Postgres un índice único nunca choca entre NULLs, así que
--      el índice solo controla a clientes con cuenta. Es lo más seguro de
--      aplicar: un RP puede traer a dos clientes distintos el mismo día sin
--      que choquen.
--   3. La OPCIÓN B (comentada) limita también las anónimas usando el
--      teléfono. Riesgo: dos personas que reservan con el mismo teléfono (o
--      un RP que repite el suyo) chocarían. Tiene 2 duplicados que habría
--      que resolver antes.
--   4. "Día" = la columna `fecha` (date), que ya es el día de la noche
--      reservada en hora de México. No depende de created_at.
--
-- Cuando se aplique, la app recibe un error 23505 (unique_violation) al
-- insertar el duplicado. Hoy /cliente/reservar lo mostraría como error
-- genérico; conviene traducirlo a "Ya tienes una reserva en este antro ese
-- día" (cambio de código pendiente, no hecho).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- PASO 0 — DIAGNÓSTICO (solo lectura). Córrelo primero.
-- Si devuelve filas, el índice NO se puede crear hasta resolverlas.
-- ----------------------------------------------------------------------------
select cliente_id, club_id, fecha, count(*) as reservas,
       array_agg(id order by created_at) as ids,
       array_agg(status order by created_at) as estados
from public.reservations
where cliente_id is not null
  and status in ('pendiente', 'confirmada', 'usada')
group by cliente_id, club_id, fecha
having count(*) > 1
order by fecha desc;

-- Solo si se va por la OPCIÓN B: duplicados de anónimas por teléfono.
select cliente_telefono, club_id, fecha, count(*) as reservas,
       array_agg(id order by created_at) as ids,
       array_agg(source order by created_at) as origen
from public.reservations
where cliente_id is null
  and status in ('pendiente', 'confirmada', 'usada')
group by cliente_telefono, club_id, fecha
having count(*) > 1
order by fecha desc;


-- ----------------------------------------------------------------------------
-- PASO 1 — OPCIÓN A (recomendada): solo clientes con cuenta
-- ----------------------------------------------------------------------------
-- `concurrently` no bloquea la tabla mientras se construye, pero NO puede ir
-- dentro de begin/commit: corre esta sentencia sola.
create unique index concurrently if not exists reservations_una_por_cliente_dia
  on public.reservations (cliente_id, club_id, fecha)
  where cliente_id is not null
    and status in ('pendiente', 'confirmada', 'usada');


-- ----------------------------------------------------------------------------
-- PASO 1 — OPCIÓN B (NO recomendada sin decidirlo): también anónimas, por
-- teléfono. Descomentar solo después de resolver los duplicados del
-- diagnóstico de teléfono.
-- ----------------------------------------------------------------------------
-- create unique index concurrently if not exists reservations_una_anonima_por_tel_dia
--   on public.reservations (cliente_telefono, club_id, fecha)
--   where cliente_id is null
--     and source = 'organica'
--     and status in ('pendiente', 'confirmada', 'usada');


-- ----------------------------------------------------------------------------
-- PASO 2 — VERIFICACIÓN
-- ----------------------------------------------------------------------------
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'reservations'
  and indexname like 'reservations_una_%';
-- Esperado: 1 fila (o 2 si también se aplicó la opción B).
