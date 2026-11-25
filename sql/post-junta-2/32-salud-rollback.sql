-- Rollback de sql/post-junta-2/32-salud.sql (B8, panel de salud del admin).
-- Solo quita lo que agregó el 32: no toca datos.
drop function if exists public.admin_salud_reglas();
drop function if exists public.admin_salud();
drop index if exists public.registro_intentos_creado;
drop index if exists public.login_intentos_creado;
