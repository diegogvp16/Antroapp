-- ROLLBACK de sql/2026-11-20-caja-candado-puerta.sql
drop trigger if exists reservations_candado_puerta on public.reservations;
drop function if exists public.reservations_candado_puerta();
