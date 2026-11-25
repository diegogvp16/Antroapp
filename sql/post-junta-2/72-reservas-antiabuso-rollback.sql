-- Rollback de sql/post-junta-2/72-reservas-antiabuso.sql: quita los límites de
-- la reserva sin cuenta (vuelve a quedar solo la política de forma).
begin;
drop trigger if exists reservations_antiabuso_anon on public.reservations;
drop function if exists public.reservations_antiabuso_anon();
drop table if exists public.reserva_intentos;
commit;
