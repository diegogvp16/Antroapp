-- Rollback de sql/post-junta/06-mensualidad.sql.
-- Quita el candado y las tablas de la mensualidad. clubs.suscripcion_activa
-- se queda con el último valor que puso el webhook (no se toca).
-- ANTES de correrlo con cobro real: exportar suscripciones y pagos_mensualidad.
drop trigger if exists clubs_candado_suscripcion on public.clubs;
drop function if exists public.clubs_candado_suscripcion();
drop table if exists public.stripe_eventos;
drop table if exists public.pagos_mensualidad;
drop table if exists public.suscripciones;
drop table if exists public.planes;
drop table if exists public.config_plataforma;
