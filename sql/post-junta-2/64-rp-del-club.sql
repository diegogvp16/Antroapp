-- ============================================================================
-- AntroApp — Turnos, asistencias y tarifas solo de RPs del mismo antro;
--            reservas sin cuenta solo en antros publicados
-- Fecha: 2026-11-25 (rama c-rls, auditoría de RLS)
-- Estado: APLICADO Y PROBADO EN DEV (scripts/dev/auditoria-rls.mjs). En producción NO.
-- Rollback: sql/post-junta-2/64-rp-del-club-rollback.sql
--
-- Hallazgos (probados con sesión real en dev; también en PRODUCCIÓN, son
-- las mismas políticas del esquema de producción):
--  1. El staff de A asigna turnos y registra asistencias de un RP de B en
--     el antro A, y el gerente de A le pone tarifa propia (por reserva y por
--     día): las políticas solo revisan club_id = current_club_id(), no que el
--     rp_id sea de ese antro. El RP de B ve esos turnos y esa tarifa en su
--     panel y la asistencia puede generar pagos por día en A. La pantalla del
--     staff ya rechaza un QR de otro antro ("wrong-club"); la base no. Bajo.
--  2. (Defensa en profundidad, NO es hueco.) Reservar sin cuenta o como
--     cliente en un antro que NO está publicado ya lo rechaza hoy la
--     política de INSERT: su subconsulta de clubs.zona_horaria corre con el
--     RLS de quien llama, no ve el borrador, la fecha mínima sale NULL y el
--     INSERT se niega (comprobado el 25/11 con este SQL quitado: ni el
--     anónimo ni el cliente pudieron). Además el trigger del 72 lo rechaza
--     con mensaje para el anónimo. Esta restrictiva deja la regla escrita
--     en un solo lugar (puede_ver_club) por si la política cambia.
--
-- Arreglo: políticas RESTRICTIVAS (AND sobre las de hoy), sin tocar las
-- permisivas: rp_es_del_club(rp, club) en INSERT (y UPDATE donde hay
-- UPDATE) de rp_schedule, rp_attendance, rp_comision_overrides y
-- rp_dia_tarifa_overrides (el admin queda libre); puede_ver_club(club_id)
-- en INSERT de reservations (el RP en su antro, aunque esté en borrador,
-- sigue pudiendo: puede_ver_club incluye al personal del antro).
-- ============================================================================

create or replace function public.rp_es_del_club(p_rp_id uuid, p_club_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  -- Nunca NULL: con datos nulos responde false.
  select coalesce(exists (select 1 from public.profiles p
                          where p.id = p_rp_id and p.role = 'rp' and p.club_id = p_club_id), false);
$function$;
revoke all on function public.rp_es_del_club(uuid, uuid) from public, anon;
grant execute on function public.rp_es_del_club(uuid, uuid) to authenticated, service_role;

create policy rp_schedule_rp_del_club on public.rp_schedule as restrictive for insert to authenticated
  with check (coalesce((select public.current_role_name()) = 'admin', false) or public.rp_es_del_club(rp_id, club_id));
create policy rp_attendance_rp_del_club on public.rp_attendance as restrictive for insert to authenticated
  with check (coalesce((select public.current_role_name()) = 'admin', false) or public.rp_es_del_club(rp_id, club_id));
create policy rp_comision_overrides_rp_del_club on public.rp_comision_overrides as restrictive for insert to authenticated
  with check (coalesce((select public.current_role_name()) = 'admin', false) or public.rp_es_del_club(rp_id, club_id));
create policy rp_comision_overrides_rp_del_club_upd on public.rp_comision_overrides as restrictive for update to authenticated
  using (true)
  with check (coalesce((select public.current_role_name()) = 'admin', false) or public.rp_es_del_club(rp_id, club_id));
create policy rp_dia_tarifa_overrides_rp_del_club on public.rp_dia_tarifa_overrides as restrictive for insert to authenticated
  with check (coalesce((select public.current_role_name()) = 'admin', false) or public.rp_es_del_club(rp_id, club_id));
create policy rp_dia_tarifa_overrides_rp_del_club_upd on public.rp_dia_tarifa_overrides as restrictive for update to authenticated
  using (true)
  with check (coalesce((select public.current_role_name()) = 'admin', false) or public.rp_es_del_club(rp_id, club_id));

create policy reservations_insert_solo_publicados on public.reservations as restrictive for insert to anon, authenticated
  with check (coalesce(public.puede_ver_club(club_id), false));
