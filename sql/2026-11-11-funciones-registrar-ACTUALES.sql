-- ============================================================================
-- Versión ACTUAL en producción (11/11/2026). Confía en datos que manda el
-- navegador (consumo, semana) y no cruza reserva con RP; ver CLAUDE.md,
-- pendientes 1 y 2. NO volver a correr tal cual.
--
-- Copia de pg_get_functiondef de registrar_comision_reserva y
-- registrar_pago_dia, solo para tener registro.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.registrar_comision_reserva(p_reservation_id uuid, p_rp_id uuid, p_club_id uuid, p_consumo_monto numeric, p_week_start timestamp with time zone, p_week_end timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tipo text;
  v_monto numeric;
  v_desbloqueo int;
  v_count_semana int;
  v_monto_final numeric;
begin
  if not (
    (public.current_role_name() in ('staff', 'gerente', 'dueno') and p_club_id = public.current_club_id())
    or public.current_role_name() = 'admin'
  ) then
    raise exception 'No autorizado para registrar comisiones de este club';
  end if;

  select comision_tipo, comision_monto, comision_desbloqueo_reservas
    into v_tipo, v_monto, v_desbloqueo
  from public.rp_comision_overrides
  where club_id = p_club_id and rp_id = p_rp_id;

  if not found then
    select comision_tipo, comision_monto, comision_desbloqueo_reservas
      into v_tipo, v_monto, v_desbloqueo
    from public.clubs
    where id = p_club_id;
  end if;

  select count(*) into v_count_semana
  from public.commissions c
  join public.reservations r on r.id = c.reservation_id
  where c.rp_id = p_rp_id
    and r.club_id = p_club_id
    and c.created_at >= p_week_start
    and c.created_at <= p_week_end;

  v_monto_final := case
    when (v_count_semana + 1) < v_desbloqueo then 0
    when v_tipo = 'fijo' then v_monto
    else (v_monto / 100) * p_consumo_monto
  end;

  insert into public.commissions (reservation_id, rp_id, tipo, monto, status)
  values (p_reservation_id, p_rp_id, 'rp', v_monto_final, 'pendiente');
end;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_pago_dia(p_rp_attendance_id uuid, p_rp_id uuid, p_club_id uuid, p_fecha date, p_week_start timestamp with time zone, p_week_end timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_posicion int;
  v_monto numeric;
begin
  if not (
    (public.current_role_name() in ('staff', 'gerente', 'dueno') and p_club_id = public.current_club_id())
    or public.current_role_name() = 'admin'
  ) then
    raise exception 'No autorizado para registrar pagos de este club';
  end if;

  if not exists (
    select 1 from public.rp_attendance
    where id = p_rp_attendance_id and rp_id = p_rp_id and club_id = p_club_id
  ) then
    raise exception 'Asistencia inválida';
  end if;

  select count(*) into v_posicion
  from public.rp_attendance
  where rp_id = p_rp_id
    and club_id = p_club_id
    and scanned_at >= p_week_start
    and scanned_at <= p_week_end;

  if v_posicion = 0 then
    v_posicion := 1;
  end if;

  select monto into v_monto
  from (
    select distinct on (posicion) posicion, monto
    from (
      select posicion, monto, 1 as prioridad
      from public.rp_dia_tarifa_overrides
      where club_id = p_club_id and rp_id = p_rp_id
      union all
      select posicion, monto, 0 as prioridad
      from public.club_dia_tarifas
      where club_id = p_club_id
    ) fuentes
    order by posicion, prioridad desc
  ) tarifa_efectiva
  where posicion <= v_posicion
  order by posicion desc
  limit 1;

  if v_monto is null then
    v_monto := 0;
  end if;

  insert into public.rp_pagos_dia (rp_attendance_id, rp_id, club_id, fecha, posicion, monto, status)
  values (p_rp_attendance_id, p_rp_id, p_club_id, p_fecha, v_posicion, v_monto, 'pendiente');
end;
$function$;
