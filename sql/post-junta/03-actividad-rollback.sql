-- Rollback de sql/post-junta/03-actividad.sql (no guarda datos: solo se quita la función).
drop function if exists public.actividad_club(uuid, date, date);
