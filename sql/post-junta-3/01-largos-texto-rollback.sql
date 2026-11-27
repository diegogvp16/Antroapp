-- Rollback de sql/post-junta-3/01-largos-texto.sql: quita los límites de largo.
begin;
alter table public.reservations drop constraint if exists reservations_cliente_telefono_largo;
alter table public.reservations drop constraint if exists reservations_cliente_nombre_largo;
alter table public.profiles drop constraint if exists profiles_telefono_largo;
alter table public.profiles drop constraint if exists profiles_nombre_largo;
commit;
