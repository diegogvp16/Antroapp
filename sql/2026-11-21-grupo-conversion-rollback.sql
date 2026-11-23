-- ============================================================================
-- Rollback de sql/2026-11-21-grupo-conversion.sql
-- Deja grupo_resumen exactamente como en sql/2026-11-20-nomina-y-grupo.sql
-- (sin las columnas nuevas) y quita grupo_rendimiento_rp.
-- ============================================================================

drop function public.grupo_rendimiento_rp(uuid, date, date);
drop function public.grupo_resumen(date, date);

create function public.grupo_resumen(p_desde date, p_hasta date)
returns table (
  club_id                   uuid,
  nombre                    text,
  ciudad                    text,
  zona_horaria              text,
  publicado                 boolean,
  reservas                  int,
  entraron                  int,
  cuentas_con_consumo       int,
  consumo_centavos          bigint,
  ticket_promedio_centavos  bigint,
  comisiones_centavos       bigint,
  noches_cerradas           int
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
           (c.estado_verificacion = 'verificado' and c.suscripcion_activa) as publicado
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
                                  is not distinct from 'entro')::int as entraron
    from public.reservations r
    where r.club_id in (select id from mis) and r.fecha between p_desde and p_hasta
    group by r.club_id
  ),
  con as (
    select k.club_id, count(distinct k.cuenta_id)::int as cuentas, sum(k.monto_centavos)::bigint as cent
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
         coalesce(com.cent, 0), coalesce(noc.cerradas, 0)
  from mis
  left join res on res.club_id = mis.id
  left join con on con.club_id = mis.id
  left join com on com.club_id = mis.id
  left join noc on noc.club_id = mis.id
  order by mis.ciudad nulls last, mis.nombre;
end;
$$;

revoke all on function public.grupo_resumen(date, date) from public, anon;
grant execute on function public.grupo_resumen(date, date) to authenticated;
