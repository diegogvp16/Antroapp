-- ============================================================================
-- AntroApp — ROLLBACK de sql/post-junta-4/10-indices-carga-prod.sql
-- PASO 1: el bloque de políticas (begin … commit) las deja exactamente como
-- estaban (texto de pg_policies de producción del 2026-11-28).
-- PASO 2: corre SOLA la línea del índice (CONCURRENTLY, fuera de transacción).
-- ============================================================================

-- ---------- PASO 1: políticas ----------
begin;

alter policy reservations_select_admin on public.reservations
  using ((current_role_name() = 'admin'::text));

alter policy reservations_select_club_staff on public.reservations
  using (((current_role_name() = any (array['staff'::text, 'gerente'::text, 'dueno'::text])) and (club_id = current_club_id())));

alter policy reservations_select_cliente_own on public.reservations
  using ((cliente_id = auth.uid()));

alter policy commissions_select_club_staff on public.commissions
  using ((exists ( select 1
     from reservations r
    where ((r.id = commissions.reservation_id) and (((current_role_name() = any (array['staff'::text, 'gerente'::text, 'dueno'::text])) and (r.club_id = current_club_id())) or (current_role_name() = 'admin'::text))))));

alter policy commissions_select_rp_own on public.commissions
  using ((rp_id = auth.uid()));

alter policy consumption_entries_select_club_staff on public.consumption_entries
  using ((exists ( select 1
     from reservations r
    where ((r.id = consumption_entries.reservation_id) and (((current_role_name() = any (array['staff'::text, 'gerente'::text, 'dueno'::text])) and (r.club_id = current_club_id())) or (current_role_name() = 'admin'::text))))));

commit;

-- ---------- PASO 2: índice ----------
drop index concurrently if exists public.commissions_created_at;
