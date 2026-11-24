-- Rollback de sql/post-junta/07-config-rp.sql.
-- 1. Regresa caja_liquidar_cuenta, rp_progreso_cuota y rp_nivel_visibilidad a
--    su versión del pase 1 (copiadas del catálogo de dev antes de aplicar 07).
-- 2. Quita la columna commissions.regla_id y las tablas nuevas. Las
--    comisiones ya calculadas con una regla nueva conservan su monto.
-- ANTES, si ya se usó: exportar reglas_comision y config_rp_cambios.
CREATE OR REPLACE FUNCTION public.caja_liquidar_cuenta(p_cuenta_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cuenta public.mesa_cuentas%rowtype;
  v_res public.reservations%rowtype;
  v_club public.clubs%rowtype;
  v_fecha date;
  v_lunes date;
  v_base bigint;
  v_tipo text;
  v_monto numeric;
  v_desbloqueo int;
  v_conteo int;
  v_centavos bigint;
begin
  select * into v_cuenta from public.mesa_cuentas where id = p_cuenta_id for update;
  if not found or v_cuenta.liquidada_en is not null then
    return;
  end if;

  select coalesce(sum(monto_centavos), 0) into v_base
  from public.caja_consumos where cuenta_id = v_cuenta.id and not anulado;

  if v_base > 0 and v_cuenta.reservation_id is not null then
    select * into v_res from public.reservations where id = v_cuenta.reservation_id;
    select * into v_club from public.clubs where id = v_cuenta.club_id;
    -- La semana sale de la fecha operativa de la noche, que ya se calculó en
    -- la zona del antro: no hace falta volver a convertir zonas aquí.
    select n.fecha_operacion into v_fecha
    from public.mesa_sesiones s join public.caja_noches n on n.id = s.noche_id
    where s.id = v_cuenta.sesion_id;
    v_lunes := v_fecha - (extract(isodow from v_fecha)::int - 1);

    if v_res.source = 'rp' and v_cuenta.rp_id is not null and v_club.pago_rp_modo = 'reserva' then
      select o.comision_tipo, o.comision_monto, o.comision_desbloqueo_reservas
        into v_tipo, v_monto, v_desbloqueo
      from public.rp_comision_overrides o
      where o.club_id = v_club.id and o.rp_id = v_cuenta.rp_id;
      if not found then
        v_tipo := v_club.comision_tipo;
        v_monto := v_club.comision_monto;
        v_desbloqueo := v_club.comision_desbloqueo_reservas;
      end if;

      -- Un candado por RP y semana: dos cuadres simultáneos del mismo RP no
      -- leen el mismo conteo. Las comisiones anuladas no cuentan.
      perform pg_advisory_xact_lock(hashtextextended(v_cuenta.rp_id::text || '|' || v_lunes::text, 0));
      select count(*) into v_conteo
      from public.commissions c
      join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.rp_id = v_cuenta.rp_id and r.club_id = v_club.id
        and c.status <> 'anulada'
        and r.fecha between v_lunes and v_lunes + 6;

      -- Misma fórmula de desbloqueo que la función actual (ver decisión 6).
      v_centavos := case
        when (v_conteo + 1) < coalesce(v_desbloqueo, 0) then 0
        when v_tipo = 'fijo' then round(coalesce(v_monto, 0) * 100)
        else round(v_base * coalesce(v_monto, 0) / 100)
      end;

      insert into public.commissions (reservation_id, rp_id, tipo, monto, status)
      values (v_res.id, v_cuenta.rp_id, 'rp', round(v_centavos / 100.0, 2), 'pendiente')
      on conflict (reservation_id) do nothing;
    end if;
    -- No hay bono de plataforma por reserva orgánica: las columnas
    -- clubs.bono_organica_* se conservan pero no se usan.

    -- Compatibilidad: el consumo total queda también en la reserva.
    update public.reservations set consumo_monto = round(v_base / 100.0, 2) where id = v_res.id;
  end if;

  update public.mesa_cuentas set liquidada_en = now() where id = v_cuenta.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.rp_progreso_cuota()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_rp     uuid := auth.uid();
  v_club   uuid := public.current_club_id();
  v_modo   text;
  v_tipo   text;
  v_monto  numeric;
  v_n      int;
  v_lunes  date;
  v_llevas int;
  v_hoy    date;
begin
  if v_rp is null or public.current_role_name() is distinct from 'rp' or v_club is null then
    raise exception 'Solo para RPs';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_rp and p.activo is false) then
    raise exception 'Tu cuenta está desactivada';
  end if;
  select c.pago_rp_modo into v_modo from public.clubs c where c.id = v_club;
  -- Regla del RP si tiene una propia; si no, la del antro (igual que la caja).
  select o.comision_tipo, o.comision_monto, o.comision_desbloqueo_reservas
    into v_tipo, v_monto, v_n
  from public.rp_comision_overrides o
  where o.club_id = v_club and o.rp_id = v_rp;
  if not found then
    select c.comision_tipo, c.comision_monto, c.comision_desbloqueo_reservas
      into v_tipo, v_monto, v_n
    from public.clubs c where c.id = v_club;
  end if;

  if v_modo is distinct from 'reserva' or coalesce(v_n, 0) <= 1 then  -- con 1, la primera ya paga: no hay cuota
    return jsonb_build_object('tiene_cuota', false);
  end if;

  v_hoy := public.club_fecha_operacion(v_club, now());
  v_lunes := v_hoy - (extract(isodow from v_hoy)::int - 1);
  select count(*) into v_llevas
  from public.commissions c join public.reservations r on r.id = c.reservation_id
  where c.tipo = 'rp' and c.rp_id = v_rp and r.club_id = v_club and c.status <> 'anulada'
    and r.fecha between v_lunes and v_lunes + 6;

  return jsonb_build_object(
    'tiene_cuota', true,
    'cuota', v_n,
    'llevas', v_llevas,
    'semana_desde', v_lunes,
    'semana_hasta', v_lunes + 6,
    'tipo', v_tipo,
    'monto', v_monto,
    -- La siguiente reserva que consuma es la número llevas + 1: paga si ya
    -- llega a la cuota.
    'siguiente_paga', (v_llevas + 1) >= v_n);
end;
$function$;

CREATE OR REPLACE FUNCTION public.rp_nivel_visibilidad(p_club_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select 'estado_monto'::text;
$function$;

drop function if exists public.config_rp_historial(uuid);
drop function if exists public.config_rp_cambiar_regla(uuid, text, int, int, bigint);
drop function if exists public.config_rp_cambiar_visibilidad(uuid, text);
drop function if exists public.config_rp_actual(uuid);
drop function if exists public.regla_comision_descripcion(uuid, date);
drop function if exists public.regla_comision_vigente(uuid, date);
drop function if exists public.lunes_de(date);
alter table public.commissions drop column if exists regla_id;
drop table if exists public.config_rp_cambios;
drop table if exists public.reglas_comision;
drop table if exists public.club_config_rp;
