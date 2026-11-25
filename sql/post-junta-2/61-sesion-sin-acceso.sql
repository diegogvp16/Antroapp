-- ============================================================================
-- AntroApp — Una sesión dada de baja o con contraseña temporal no ve "lo suyo"
-- Fecha: 2026-11-25 (rama c-rls, auditoría de RLS)
-- Estado: APLICADO Y PROBADO EN DEV (scripts/dev/auditoria-rls.mjs). En producción NO.
-- Rollback: sql/post-junta-2/61-sesion-sin-acceso-rollback.sql
--
-- current_role_name() ya es NULL para un perfil con activo = false o con
-- app_metadata.debe_cambiar (post-junta 02 y 08), y con eso se cierran todas
-- las políticas por rol. Pero varias políticas dejan ver "lo propio" solo con
-- rp_id = auth.uid() o cliente_id = auth.uid(), sin pasar por el rol. Probado
-- en dev con sesión real (auditoría c-rls):
--  * Un RP dado de baja (activo = false; su sesión sigue viva porque la baja
--    de RPs no cierra sesiones) leía sus pagos por día (rp_pagos_dia, es
--    nómina), turnos, asistencias y su tarifa propia. En PRODUCCIÓN también:
--    la restrictiva del pase 1 (soy_rp_dado_de_baja) solo cubre reservations
--    y commissions.
--  * Un RP con contraseña temporal sin cambiar (alta de antros, post-junta)
--    leía sus reservas con nombre y teléfono de sus clientes, comisiones,
--    turnos, asistencias, pagos y tarifa. No aplica a producción todavía
--    (ahí no hay contraseñas temporales).
--
-- Arreglo: un ayudante sesion_sin_acceso() y una política RESTRICTIVA de
-- SELECT (se aplica con AND sobre todas las demás) en cada tabla con
-- "lo propio" de un RP o cliente. Solo afecta a authenticated: el anónimo
-- (reservar sin cuenta, boleto público) no cambia.
-- ============================================================================

create or replace function public.sesion_sin_acceso()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  -- true = la sesión no debe ver nada propio: perfil dado de baja o
  -- contraseña temporal sin cambiar. Nunca devuelve NULL.
  select auth.uid() is not null
     and (exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo is false)
          or coalesce((auth.jwt() -> 'app_metadata' ->> 'debe_cambiar')::boolean, false));
$function$;

revoke all on function public.sesion_sin_acceso() from public, anon;
grant execute on function public.sesion_sin_acceso() to authenticated, service_role;

create policy reservations_sin_acceso on public.reservations as restrictive for select to authenticated
  using (not (select public.sesion_sin_acceso()));
create policy commissions_sin_acceso on public.commissions as restrictive for select to authenticated
  using (not (select public.sesion_sin_acceso()));
create policy rp_pagos_dia_sin_acceso on public.rp_pagos_dia as restrictive for select to authenticated
  using (not (select public.sesion_sin_acceso()));
create policy rp_schedule_sin_acceso on public.rp_schedule as restrictive for select to authenticated
  using (not (select public.sesion_sin_acceso()));
create policy rp_attendance_sin_acceso on public.rp_attendance as restrictive for select to authenticated
  using (not (select public.sesion_sin_acceso()));
create policy rp_comision_overrides_sin_acceso on public.rp_comision_overrides as restrictive for select to authenticated
  using (not (select public.sesion_sin_acceso()));
create policy rp_dia_tarifa_overrides_sin_acceso on public.rp_dia_tarifa_overrides as restrictive for select to authenticated
  using (not (select public.sesion_sin_acceso()));
