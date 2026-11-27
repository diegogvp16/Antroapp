-- Rollback de sql/2026-11-25-perfil-sin-club-ajeno.sql: deja la política
-- como estaba (REABRE el hueco crítico; solo si el arreglo rompiera el registro).
begin;

drop policy if exists profiles_insert_sin_club_restrictiva on public.profiles;
drop policy if exists profiles_insert_propio on public.profiles;
create policy profiles_insert_propio on public.profiles
  for insert to authenticated
  with check (
    id = (select auth.uid())
    and role = any (array['cliente'::text, 'dueno'::text])
  );

commit;
