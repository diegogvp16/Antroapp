-- ============================================================================
-- AntroApp — /grupo: conversión y rendimiento por RP (noche 2, rama noche2)
-- Fecha: 2026-11-21
-- Estado: APLICADO Y PROBADO SOLO EN DEV. En producción NO.
-- Requiere: sql/2026-11-20-nomina-y-grupo.sql (reemplaza su grupo_resumen).
-- Rollback: sql/2026-11-21-grupo-conversion-rollback.sql.
--
-- Por qué: las cifras de /grupo se iban a mostrar al cliente y algunas
-- confundían (docs/numeros-dashboards.md):
--   * El % de entrada contaba como "no entraron" las reservas de noches que
--     todavía no llegan (las de mañana dentro de "esta semana").
--   * No había conversión real (reservas que CONSUMEN / reservas) ni
--     rendimiento por RP.
--   * El consumo mezclaba con y sin reserva sin decirlo.
--
-- Cambios:
--   1. grupo_resumen: columnas nuevas al final (las de antes no cambian):
--        reservas_por_venir        reservas de noches posteriores a la noche
--                                  en curso del antro (aún no pueden entrar)
--        reservas_con_consumo      reservas cuya cuenta tiene consumo vigente
--        consumo_con_reserva_centavos  consumo de cuentas que vienen de reserva
--   2. grupo_rendimiento_rp(club, desde, hasta): una fila por RP del antro con
--      reservas, por venir, entraron, consumieron, consumo, ticket y
--      comisiones (comisión + pago por día, sin anulados). Mismo acceso que
--      grupo_resumen para ese antro: admin, su dueño, el dueño de su grupo y
--      su gerente activo. Staff, RP y cliente: nada.
-- ============================================================================

drop function public.grupo_resumen(date, date);

create function public.grupo_resumen(p_desde date, p_hasta date)
returns table (
  club_id                       uuid,
  nombre                        text,
  ciudad                        text,
  zona_horaria                  text,
  publicado                     boolean,
  reservas                      int,
  entraron                      int,
  cuentas_con_consumo           int,
  consumo_centavos              bigint,
  ticket_promedio_centavos      bigint,
  comisiones_centavos           bigint,
  noches_cerradas               int,
  reservas_por_venir            int,
  reservas_con_consumo          int,
  consumo_con_reserva_centavos  bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 93 then
    raise exception 'Rango de fechas inválido (máximo 93 días)';
  end if;

  return query
  with mis as (
    select c.id, c.nombre, c.ciudad, c.zona_horaria,
           (c.estado_verificacion = 'verificado' and c.suscripcion_activa) as publicado,
           public.club_fecha_operacion(c.id) as hoy
    from public.clubs c
    where v_rol = 'admin'
       or public.club_es_dueno(c.id)
       or public.club_es_dueno_grupo(c.id)
       or (v_rol = 'gerente' and c.id = public.current_club_id()
           and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo))
  ),
  res as (
    select r.club_id, count(*)::int as n,
           count(*) filter (where coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end)
                                  is not distinct from 'entro')::int as entraron,
           count(*) filter (where r.fecha > mis.hoy)::int as por_venir,
           count(*) filter (where exists (
             select 1 from public.mesa_cuentas mc join public.caja_consumos k on k.cuenta_id = mc.id
             where mc.reservation_id = r.id and not k.anulado))::int as con_consumo
    from public.reservations r
    join mis on mis.id = r.club_id
    where r.fecha between p_desde and p_hasta
    group by r.club_id
  ),
  con as (
    select k.club_id, count(distinct k.cuenta_id)::int as cuentas, sum(k.monto_centavos)::bigint as cent,
           coalesce(sum(k.monto_centavos) filter (where k.reservation_id is not null), 0)::bigint as cent_reserva
    from public.caja_consumos k
    join public.caja_noches n on n.id = k.noche_id
    where k.club_id in (select id from mis) and not k.anulado
      and n.fecha_operacion between p_desde and p_hasta
    group by k.club_id
  ),
  com as (
    select x.club_id, sum(x.cent)::bigint as cent from (
      select r.club_id, round(c.monto * 100)::bigint as cent
      from public.commissions c join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.status <> 'anulada'
        and r.club_id in (select id from mis) and r.fecha between p_desde and p_hasta
      union all
      select d.club_id, round(d.monto * 100)::bigint
      from public.rp_pagos_dia d
      where d.status <> 'anulada' and d.club_id in (select id from mis) and d.fecha between p_desde and p_hasta
    ) x group by x.club_id
  ),
  noc as (
    select n.club_id, count(*) filter (where n.estado = 'cerrada')::int as cerradas
    from public.caja_noches n
    where n.club_id in (select id from mis) and n.fecha_operacion between p_desde and p_hasta
    group by n.club_id
  )
  select mis.id, mis.nombre, mis.ciudad, mis.zona_horaria, mis.publicado,
         coalesce(res.n, 0), coalesce(res.entraron, 0),
         coalesce(con.cuentas, 0), coalesce(con.cent, 0),
         case when coalesce(con.cuentas, 0) > 0 then round(con.cent::numeric / con.cuentas)::bigint else 0 end,
         coalesce(com.cent, 0), coalesce(noc.cerradas, 0),
         coalesce(res.por_venir, 0), coalesce(res.con_consumo, 0), coalesce(con.cent_reserva, 0)
  from mis
  left join res on res.club_id = mis.id
  left join con on con.club_id = mis.id
  left join com on com.club_id = mis.id
  left join noc on noc.club_id = mis.id
  order by mis.ciudad nulls last, mis.nombre;
end;
$$;


create function public.grupo_rendimiento_rp(p_club_id uuid, p_desde date, p_hasta date)
returns table (
  rp_id               uuid,
  rp_nombre           text,
  rp_activo           boolean,
  reservas            int,
  por_venir           int,
  entraron            int,
  consumieron         int,
  consumo_centavos    bigint,
  ticket_centavos     bigint,
  comisiones_centavos bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rol text := public.current_role_name();
  v_hoy date;
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión';
  end if;
  if not (v_rol = 'admin'
          or public.club_es_dueno(p_club_id)
          or public.club_es_dueno_grupo(p_club_id)
          or (v_rol = 'gerente' and p_club_id = public.current_club_id()
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.activo))) then
    raise exception 'No tienes acceso a este antro';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 93 then
    raise exception 'Rango de fechas inválido (máximo 93 días)';
  end if;
  v_hoy := public.club_fecha_operacion(p_club_id);

  return query
  with res as (
    select r.rp_id, count(*)::int as n,
           count(*) filter (where r.fecha > v_hoy)::int as por_venir,
           count(*) filter (where coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end)
                                  is not distinct from 'entro')::int as entraron,
           count(*) filter (where exists (
             select 1 from public.mesa_cuentas mc join public.caja_consumos k on k.cuenta_id = mc.id
             where mc.reservation_id = r.id and not k.anulado))::int as consumieron
    from public.reservations r
    where r.club_id = p_club_id and r.source = 'rp' and r.rp_id is not null
      and r.fecha between p_desde and p_hasta
    group by r.rp_id
  ),
  con as (
    -- Consumo de las cuentas que vienen de reservas del RP en el rango.
    select r.rp_id, sum(k.monto_centavos)::bigint as cent
    from public.reservations r
    join public.mesa_cuentas mc on mc.reservation_id = r.id
    join public.caja_consumos k on k.cuenta_id = mc.id and not k.anulado
    where r.club_id = p_club_id and r.source = 'rp' and r.rp_id is not null
      and r.fecha between p_desde and p_hasta
    group by r.rp_id
  ),
  com as (
    select x.rp_id, sum(x.cent)::bigint as cent from (
      select c.rp_id, round(c.monto * 100)::bigint as cent
      from public.commissions c join public.reservations r on r.id = c.reservation_id
      where c.tipo = 'rp' and c.status <> 'anulada' and r.club_id = p_club_id
        and r.fecha between p_desde and p_hasta
      union all
      select d.rp_id, round(d.monto * 100)::bigint
      from public.rp_pagos_dia d
      where d.status <> 'anulada' and d.club_id = p_club_id and d.fecha between p_desde and p_hasta
    ) x group by x.rp_id
  ),
  rps as (
    select p.id from public.profiles p where p.role = 'rp' and p.club_id = p_club_id
    union select res.rp_id from res
    union select com.rp_id from com
  )
  select rps.id, p.nombre, coalesce(p.activo, true),
         coalesce(res.n, 0), coalesce(res.por_venir, 0), coalesce(res.entraron, 0), coalesce(res.consumieron, 0),
         coalesce(con.cent, 0),
         case when coalesce(res.consumieron, 0) > 0 then round(coalesce(con.cent, 0)::numeric / res.consumieron)::bigint else 0 end,
         coalesce(com.cent, 0)
  from rps
  left join public.profiles p on p.id = rps.id
  left join res on res.rp_id = rps.id
  left join con on con.rp_id = rps.id
  left join com on com.rp_id = rps.id
  where rps.id is not null
  order by coalesce(con.cent, 0) desc, p.nombre;
end;
$$;

revoke all on function public.grupo_resumen(date, date) from public, anon;
grant execute on function public.grupo_resumen(date, date) to authenticated;
revoke all on function public.grupo_rendimiento_rp(uuid, date, date) from public, anon;
grant execute on function public.grupo_rendimiento_rp(uuid, date, date) to authenticated;
