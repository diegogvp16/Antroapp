-- ============================================================================
-- AntroApp — Paso 7d del pase: registrar_comision_reserva y registrar_pago_dia
--             con autorización que nunca queda en NULL
-- Fecha: 2026-11-24 (rama pase-final)
-- Requiere: paso 5 (sql/2026-11-20-estabilidad.sql), que define estas versiones,
--           y el 10a (es_gerente_o_dueno que devuelve false, no NULL).
-- Rollback: sql/2026-11-24-registrar-sin-nulos-rollback.sql (cuerpos del paso 5 tal cual)
--
-- Las versiones del paso 5 autorizan con
--   if not (es_gerente_o_dueno(club) or (rol = 'staff' and club = mi club)) then raise
-- Para una cuenta autenticada SIN perfil eso queda "false or NULL" = NULL y
-- NO rechaza; además la rama del staff no revisaba si está dado de baja.
-- Arreglo mínimo: coalesce(..., false) y "activo" en la rama del staff.
-- Cuerpos tomados del catálogo de dev con el pase aplicado; solo cambia esa
-- condición (una en cada función).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.registrar_comision_reserva(p_reservation_id uuid, p_rp_id uuid, p_club_id uuid, p_consumo_monto numeric, p_week_start timestamp with time zone, p_week_end timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_res public.reservations%rowtype;
  v_cuenta uuid;
  v_estado text;
begin
  select * into v_res from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'Reserva no encontrada';
  end if;
  if not coalesce(public.es_gerente_o_dueno(v_res.club_id)
          or (public.current_role_name() = 'staff' and public.current_club_id() = v_res.club_id
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo)), false) then
    raise exception 'No autorizado para registrar comisiones de este club';
  end if;

  select c.id, s.estado into v_cuenta, v_estado
  from public.mesa_cuentas c join public.mesa_sesiones s on s.id = c.sesion_id
  where c.reservation_id = v_res.id;

  if v_cuenta is null then
    raise exception 'La reserva no está sentada en ninguna mesa de la caja';
  end if;
  if v_estado <> 'cuadrada' then
    raise exception 'La comisión nace al cuadrar la mesa en la caja';
  end if;

  -- Idempotente: si ya se liquidó, no hace nada.
  perform public.caja_liquidar_cuenta(v_cuenta);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.registrar_pago_dia(p_rp_attendance_id uuid, p_rp_id uuid, p_club_id uuid, p_fecha date, p_week_start timestamp with time zone, p_week_end timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_asis public.rp_attendance%rowtype;
  v_modo text;
  v_lunes date;
  v_posicion int;
  v_monto numeric;
begin
  select * into v_asis from public.rp_attendance where id = p_rp_attendance_id;
  if not found or v_asis.rp_id is distinct from p_rp_id or v_asis.club_id is distinct from p_club_id then
    raise exception 'Asistencia inválida';
  end if;
  if not coalesce(public.es_gerente_o_dueno(v_asis.club_id)
          or (public.current_role_name() = 'staff' and public.current_club_id() = v_asis.club_id
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo)), false) then
    raise exception 'No autorizado para registrar pagos de este club';
  end if;

  select pago_rp_modo into v_modo from public.clubs where id = v_asis.club_id;
  if v_modo is distinct from 'dia' then
    return;
  end if;

  -- Semana ISO de la noche de la asistencia.
  v_lunes := v_asis.fecha - (extract(isodow from v_asis.fecha)::int - 1);

  -- Posición: cuántas noches distintas asistió ese RP en esa semana hasta
  -- esta (incluida). Varias marcas el mismo día cuentan una vez.
  select count(distinct a.fecha) into v_posicion
  from public.rp_attendance a
  where a.rp_id = v_asis.rp_id and a.club_id = v_asis.club_id
    and a.fecha between v_lunes and v_asis.fecha;
  v_posicion := greatest(v_posicion, 1);

  -- Tarifa: la del RP si existe para esa posición o una anterior, si no la
  -- del antro; si asiste más días de los configurados, se repite la última.
  select monto into v_monto
  from (
    select distinct on (posicion) posicion, monto
    from (
      select posicion, monto, 1 as prioridad from public.rp_dia_tarifa_overrides
      where club_id = v_asis.club_id and rp_id = v_asis.rp_id
      union all
      select posicion, monto, 0 as prioridad from public.club_dia_tarifas
      where club_id = v_asis.club_id
    ) fuentes
    order by posicion, prioridad desc
  ) tarifa
  where posicion <= v_posicion
  order by posicion desc
  limit 1;

  insert into public.rp_pagos_dia (rp_attendance_id, rp_id, club_id, fecha, posicion, monto, status)
  values (v_asis.id, v_asis.rp_id, v_asis.club_id, v_asis.fecha, v_posicion, coalesce(v_monto, 0), 'pendiente')
  on conflict (rp_attendance_id) do nothing;
end;
$function$
;
