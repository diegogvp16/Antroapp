-- ============================================================================
-- AntroApp — post-junta-4, prueba de carga: versión PRODUCCIÓN de
-- sql/post-junta-4/10-indices-carga.sql (mismo contenido; el índice va con
-- CONCURRENTLY para no bloquear escrituras). Motivo, medidas y riesgos:
-- docs/prueba-carga.md. Rollback: 10-indices-carga-prod-rollback.sql
--
-- Cómo correrlo en el SQL Editor:
--   PASO 1: pega y corre el bloque de políticas completo (begin … commit).
--           Es instantáneo; toma un candado breve sobre reservations,
--           commissions y consumption_entries mientras se cambia la política.
--   PASO 2: corre SOLA la línea del índice (CONCURRENTLY no corre dentro de
--           una transacción ni junto con otras sentencias). Si falla a la
--           mitad deja un índice INVALID: bórralo con su línea del rollback y
--           vuelve a correrla. Mejor fuera de horario de operación.
-- Antes: confirma que las 6 políticas siguen como en el rollback (si alguien
-- las cambió después del 2026-11-28, NO lo corras: avisa).
--   select policyname, qual from pg_policies where schemaname = 'public'
--    and policyname in ('reservations_select_admin', 'reservations_select_club_staff', 'reservations_select_cliente_own',
--          'commissions_select_club_staff', 'commissions_select_rp_own', 'consumption_entries_select_club_staff');
-- ============================================================================

-- ---------- PASO 1: políticas (un solo bloque) ----------
begin;

alter policy reservations_select_admin on public.reservations
  using ((select public.current_role_name()) = 'admin'::text);

alter policy reservations_select_club_staff on public.reservations
  using (((select public.current_role_name()) = any (array['staff'::text, 'gerente'::text, 'dueno'::text]))
         and (club_id = (select public.current_club_id())));

alter policy reservations_select_cliente_own on public.reservations
  using (cliente_id = (select auth.uid()));

alter policy commissions_select_club_staff on public.commissions
  using (exists (
    select 1 from public.reservations r
    where r.id = commissions.reservation_id
      and ((((select public.current_role_name()) = any (array['staff'::text, 'gerente'::text, 'dueno'::text]))
            and (r.club_id = (select public.current_club_id())))
           or ((select public.current_role_name()) = 'admin'::text))));

alter policy commissions_select_rp_own on public.commissions
  using (rp_id = (select auth.uid()));

alter policy consumption_entries_select_club_staff on public.consumption_entries
  using (exists (
    select 1 from public.reservations r
    where r.id = consumption_entries.reservation_id
      and ((((select public.current_role_name()) = any (array['staff'::text, 'gerente'::text, 'dueno'::text]))
            and (r.club_id = (select public.current_club_id())))
           or ((select public.current_role_name()) = 'admin'::text))));

commit;

-- ---------- PASO 2: índice (sola, fuera de transacción) ----------
create index concurrently if not exists commissions_created_at on public.commissions (created_at);

-- Verificación:
--   select policyname, qual from pg_policies where schemaname = 'public'
--    and policyname in ('reservations_select_admin', 'reservations_select_club_staff', 'reservations_select_cliente_own',
--          'commissions_select_club_staff', 'commissions_select_rp_own', 'consumption_entries_select_club_staff');
--   -> las 6 dicen "( SELECT current_role_name() AS current_role_name)" / "( SELECT auth.uid() AS uid)"
--   select indexname, indisvalid from pg_indexes i join pg_class c on c.relname = i.indexname
--     join pg_index x on x.indexrelid = c.oid where i.schemaname = 'public' and i.indexname = 'commissions_created_at';
--   -> 1 fila con indisvalid = true
