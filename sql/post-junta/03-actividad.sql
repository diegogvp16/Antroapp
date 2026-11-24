-- ============================================================================
-- AntroApp — Registro de actividad del antro para el gerente y el dueño
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Requiere: pase 1 (caja_eventos, es_gerente_o_dueno) y
--           sql/post-junta/02-baja-personal.sql (personal_movimientos).
-- Rollback: drop function if exists public.actividad_club(uuid, date, date);
--
-- Quién cuadró, anuló, reabrió o cerró, con hora, mesa, monto y motivo, más
-- las bajas y reactivaciones de personal. Lee de caja_eventos (que ya escriben
-- las funciones de caja) y de personal_movimientos: no guarda nada nuevo.
-- Solo admin, el dueño y los gerentes activos del antro (es_gerente_o_dueno).
-- El rango es por noche operativa (corte 08:00 en la zona del antro).
-- Deja fuera lo de mucho volumen y poco interés (abrir mesa, sentar, puerta).
-- ============================================================================
create or replace function public.actividad_club(p_club_id uuid, p_desde date, p_hasta date)
returns table (
  hecho_en        timestamptz,
  tipo            text,
  mesa            text,
  monto_centavos  bigint,
  motivo          text,
  quien           text,
  quien_rol       text,
  persona         text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz     text;
  v_inicio timestamptz;
  v_fin    timestamptz;
begin
  if not public.es_gerente_o_dueno(p_club_id) then
    raise exception 'Solo el gerente o el dueño ven la actividad del antro.' using errcode = 'P0001';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 92 then
    raise exception 'Elige un rango de hasta 3 meses.' using errcode = 'P0001';
  end if;
  select c.zona_horaria into v_tz from public.clubs c where c.id = p_club_id;
  v_inicio := (p_desde + time '08:00') at time zone coalesce(v_tz, 'America/Mexico_City');
  v_fin    := (p_hasta + 1 + time '08:00') at time zone coalesce(v_tz, 'America/Mexico_City');

  return query
    select e.hecho_en,
           e.tipo,
           t.numero,
           case
             when e.tipo in ('anular_consumo', 'anular_pago') then (e.detalle ->> 'monto_centavos')::bigint
             when e.tipo in ('cuadrar_mesa', 'cerrar_mesa') then (e.detalle ->> 'registrado')::bigint
             when e.tipo = 'cerrar_noche' then (e.detalle ->> 'registrado')::bigint
           end,
           e.detalle ->> 'motivo',
           coalesce(p.nombre, 'Sistema'),
           p.role,
           null::text
    from public.caja_eventos e
    left join public.mesa_sesiones s on s.id = e.sesion_id
    left join public.club_tables t on t.id = s.mesa_id
    left join public.profiles p on p.id = e.hecho_por
    where e.club_id = p_club_id
      and e.hecho_en >= v_inicio and e.hecho_en < v_fin
      and e.tipo in ('cuadrar_mesa', 'anular_consumo', 'anular_pago', 'reabrir_mesa',
                     'cerrar_mesa', 'cerrar_noche', 'nomina_cambiar_estado')
    union all
    select m.hecho_en,
           case m.accion when 'baja' then 'personal_baja' else 'personal_reactivacion' end,
           null::text,
           null::bigint,
           m.motivo,
           h.nombre,
           h.role,
           o.nombre
    from public.personal_movimientos m
    join public.profiles h on h.id = m.hecho_por
    join public.profiles o on o.id = m.profile_id
    where m.club_id = p_club_id
      and m.hecho_en >= v_inicio and m.hecho_en < v_fin
    order by 1 desc
    limit 500;
end;
$$;
revoke all on function public.actividad_club(uuid, date, date) from public, anon;
grant execute on function public.actividad_club(uuid, date, date) to authenticated;
