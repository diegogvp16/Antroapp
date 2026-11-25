-- ============================================================================
-- Rollback de sql/post-junta-2/41-rp-visibilidad.sql
-- Deja exactamente lo de hoy (copiado del catálogo de dev antes de aplicar
-- el 41): rp_mis_reservas con sus 17 columnas y los renglones de concepto
-- libre, la política reservations_select_rp_own y el EXECUTE de
-- rp_nivel_visibilidad para authenticated.
-- OJO: vuelve a abrir la fuga (el RP lee consumo_monto directo aunque su
-- antro tenga «solo el estado»).
-- ORDEN: antes del rollback de 07 (07 redefine rp_nivel_visibilidad).
-- ============================================================================

create policy reservations_select_rp_own on public.reservations
  for select to authenticated
  using (rp_id = auth.uid());

grant execute on function public.rp_nivel_visibilidad(uuid) to authenticated;

drop function if exists public.rp_mis_reservas(date, date);

CREATE FUNCTION public.rp_mis_reservas(p_desde date, p_hasta date)
 RETURNS TABLE(reservation_id uuid, cliente_nombre text, cliente_telefono text, fecha date, personas integer, estado text, mesa text, consumo_centavos bigint, renglones jsonb, creada_en timestamp with time zone, llego_en timestamp with time zone, sentado_en timestamp with time zone, primer_consumo_en timestamp with time zone, cuadrada_en timestamp with time zone, comision_centavos bigint, comision_estado text, nivel text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_rp    uuid := auth.uid();
  v_club  uuid := public.current_club_id();
  v_nivel text;
  v_hoy   date;
begin
  if v_rp is null or public.current_role_name() is distinct from 'rp' or v_club is null then
    raise exception 'Solo para RPs';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_rp and p.activo is false) then
    raise exception 'Tu cuenta está desactivada';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 62 then
    raise exception 'Rango de fechas inválido (máximo 62 días)';
  end if;
  v_nivel := public.rp_nivel_visibilidad(v_club);
  v_hoy := public.club_fecha_operacion(v_club, now());

  return query
  with
  res as (
    select r.* from public.reservations r
    where r.rp_id = v_rp and r.club_id = v_club and r.source = 'rp'
      and r.fecha between p_desde and p_hasta
  ),
  cta as (
    select distinct on (c.reservation_id)
           c.reservation_id, c.id as cuenta_id, c.creada_en, s.cuadrada_en, t.numero as mesa
    from public.mesa_cuentas c
    join public.mesa_sesiones s on s.id = c.sesion_id
    join public.club_tables t on t.id = s.mesa_id
    where c.reservation_id in (select id from res)
    order by c.reservation_id, c.creada_en
  ),
  con as (
    select k.cuenta_id,
           coalesce(sum(k.monto_centavos) filter (where not k.anulado), 0)::bigint as cent,
           min(k.registrado_en) filter (where not k.anulado) as primero,
           jsonb_agg(jsonb_build_object('concepto', k.concepto, 'monto_centavos', k.monto_centavos)
                     order by k.registrado_en) filter (where not k.anulado) as renglones
    from public.caja_consumos k
    where k.cuenta_id in (select cuenta_id from cta)
    group by k.cuenta_id
  ),
  noc as (
    select n.fecha_operacion, n.estado from public.caja_noches n
    where n.club_id = v_club and n.fecha_operacion between p_desde and p_hasta
  )
  select r.id, r.cliente_nombre, r.cliente_telefono, r.fecha, r.personas,
         case
           when coalesce(con.cent, 0) > 0 then 'consumio'
           when coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end) = 'entro' then 'llego_sin_consumo'
           when noc.estado = 'cerrada' or r.fecha < v_hoy then 'no_llego'
           else 'por_llegar'
         end,
         cta.mesa,
         case when v_nivel in ('estado_monto', 'estado_monto_botellas') then coalesce(con.cent, 0) end,
         case when v_nivel = 'estado_monto_botellas' then con.renglones end,
         r.created_at, r.entrada_en, cta.creada_en, con.primero, cta.cuadrada_en,
         round(cm.monto * 100)::bigint, cm.status, v_nivel
  from res r
  left join cta on cta.reservation_id = r.id
  left join con on con.cuenta_id = cta.cuenta_id
  left join noc on noc.fecha_operacion = r.fecha
  left join public.commissions cm on cm.reservation_id = r.id and cm.tipo = 'rp'
  order by r.fecha desc, r.created_at desc;
end;
$function$
;

revoke all on function public.rp_mis_reservas(date, date) from public, anon;
grant execute on function public.rp_mis_reservas(date, date) to authenticated;
