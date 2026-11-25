-- ============================================================================
-- AntroApp — Hueco CRÍTICO: perfil propio con el club_id de un antro ajeno
-- Fecha: 2026-11-25 (auditoría C2 de la noche 3). Vigente en PRODUCCIÓN.
-- Rollback: sql/2026-11-25-perfil-sin-club-ajeno-rollback.sql
-- Prueba (dev): node scripts/dev/probar-perfil-club-ajeno.mjs   (con --abierto documenta el hueco)
--
-- profiles_insert_propio deja que cualquier cuenta recién registrada (signUp
-- con la anon key, que es pública) cree SU perfil con role 'cliente' o
-- 'dueno' y CUALQUIER club_id. current_club_id() devuelve primero
-- profiles.club_id, así que un "dueño" con el club_id de otro antro pasa
-- todas las políticas "rol dueño + club_id = current_club_id()". Probado en
-- dev el 25/11/2026 con sesión real: leyó las 135 reservas del antro ajeno
-- con nombre y teléfono, su personal, turnos, sueldos individuales y
-- comisiones, creó una mesa y pudo editar o dar de baja a sus RPs.
--
-- Arreglo: el autorregistro (cliente o dueño) nunca trae club_id —ni
-- /cliente/signup, ni /dueno/signup, ni /api/auth/registro lo mandan— así que
-- la política exige club_id nulo. Además una RESTRICTIVA (se aplica con AND
-- sobre cualquier permisiva, presente o futura) para que ninguna inserción
-- con sesión deje club_id: las cuentas con club (staff, gerente, RP) las crea
-- el servidor con la service role, que no pasa por RLS.
--
-- Diagnóstico ANTES de aplicar (solo lectura, en el SQL Editor):
--   select role, count(*) from public.profiles
--    where club_id is not null and role in ('cliente', 'dueno') group by role;
-- Lo esperado es 0 filas. Si sale algo, revisar esos perfiles uno por uno
-- (pudieron haberse colado por este hueco) ANTES de seguir.
-- ============================================================================
begin;

drop policy if exists profiles_insert_propio on public.profiles;
create policy profiles_insert_propio on public.profiles
  for insert to authenticated
  with check (
    id = (select auth.uid())
    and role = any (array['cliente'::text, 'dueno'::text])
    and club_id is null
  );

drop policy if exists profiles_insert_sin_club_restrictiva on public.profiles;
create policy profiles_insert_sin_club_restrictiva on public.profiles
  as restrictive
  for insert to authenticated
  with check (club_id is null);

commit;

-- Verificación (solo lectura):
--   select policyname, permissive, with_check from pg_policies
--    where schemaname = 'public' and tablename = 'profiles' and cmd = 'INSERT';
-- Debe mostrar profiles_insert_propio (PERMISSIVE, con "club_id IS NULL") y
-- profiles_insert_sin_club_restrictiva (RESTRICTIVE, "club_id IS NULL").
