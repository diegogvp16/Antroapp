-- Rollback de sql/post-junta/01-alta-club.sql.
-- No borra los antros dados de alta con el asistente: solo la función y la
-- bitácora (club_altas). Los antros quedan como cualquier otro.
drop function if exists public.admin_alta_club(jsonb);
drop table if exists public.club_altas;
