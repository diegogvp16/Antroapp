-- Rollback de sql/post-junta-2/70-indices-prod.sql: una sentencia a la vez.
drop index concurrently if exists public.reservations_club_fecha;
drop index concurrently if exists public.reservations_rp_fecha;
drop index concurrently if exists public.reservations_cliente_creada;
drop index concurrently if exists public.commissions_rp_tipo;
drop index concurrently if exists public.caja_cuadres_noche;
drop index concurrently if exists public.caja_eventos_club_hecho;
drop index concurrently if exists public.profiles_club_role;
drop index concurrently if exists public.rp_attendance_club_fecha;
drop index concurrently if exists public.rp_schedule_club_fecha;
drop index concurrently if exists public.rp_pagos_dia_club_fecha;
drop index concurrently if exists public.rp_pagos_dia_rp_fecha;
drop index concurrently if exists public.club_tables_club;
drop index concurrently if exists public.club_photos_club_orden;
drop index concurrently if exists public.clubs_dueno;
drop index concurrently if exists public.grupo_miembros_profile;
drop index concurrently if exists public.consumption_entries_reservation;
