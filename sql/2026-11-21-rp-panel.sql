-- ============================================================================
-- AntroApp — Datos del panel del RP (rediseño de /rp/panel)
-- Fecha: 2026-11-21
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO, hasta el pase.
-- Requiere: sql/2026-11-20-caja-por-mesa.sql y sql/2026-11-20-nomina-y-grupo.sql.
-- Rollback: sql/2026-11-21-rp-panel-rollback.sql.
--
-- El RP no lee las tablas de la caja (RLS, a propósito). Estas funciones le
-- devuelven SOLO lo suyo, ya calculado en la base:
--   rp_nivel_visibilidad(club)  -> qué ve el RP (un solo punto de decisión).
--   rp_mis_reservas(desde, hasta) -> sus reservas con estado por consumo,
--                                    mesa, monto, línea de tiempo y comisión.
--   rp_progreso_cuota()         -> progreso de la regla con cuota (hoy: el
--                                  desbloqueo semanal), o "sin cuota".
-- ============================================================================


-- 1. Qué ve el RP de cada reserva. ÚNICO punto de decisión:
--      'estado'                 -> solo el estado
--      'estado_monto'           -> estado y monto consumido (hoy, fijo)
--      'estado_monto_botellas'  -> además, los renglones de consumo
--    Para hacerlo configurable por antro: agregar clubs.rp_visibilidad y
--    leerla aquí. Nada más cambia.
create or replace function public.rp_nivel_visibilidad(p_club_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'estado_monto'::text;
$$;


-- 2. Reservas del RP que llama, con su estado por consumo:
--      consumio           -> ocupó mesa y su cuenta tiene consumo vigente
--                            (único estado que cuenta para comisión)
--      llego_sin_consumo  -> entrada confirmada, sin consumo todavía
--      no_llego           -> la noche ya cerró (o ya pasó) y no entró
--      por_llegar         -> la noche sigue abierta y no ha entrado
create or replace function public.rp_mis_reservas(p_desde date, p_hasta date)
returns table (
  reservation_id      uuid,
  cliente_nombre      text,
  cliente_telefono    text,
  fecha               date,
  personas            int,
  estado              text,
  mesa                text,
  consumo_centavos    bigint,   -- nulo si el nivel no incluye el monto
  renglones           jsonb,    -- nulo si el nivel no incluye las botellas
  creada_en           timestamptz,
  llego_en            timestamptz,
  sentado_en          timestamptz,
  primer_consumo_en   timestamptz,
  cuadrada_en         timestamptz,
  comision_centavos   bigint,
  comision_estado     text,
  nivel               text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
$$;


-- 3. Progreso de la regla con cuota del RP que llama, en la semana de la
--    noche en curso (lunes a domingo). Hoy la única regla con cuota es el
--    desbloqueo semanal (comision_desbloqueo_reservas, del RP o del antro, en
--    modo 'reserva'), con la fórmula de caja_liquidar_cuenta: la reserva
--    número N es la primera que paga. Si no hay cuota: {"tiene_cuota": false}.
--    Cuando exista la tabla de reglas (docs/reglas-comision.md) solo cambia
--    esta función; la pantalla ya lee este mismo JSON.
create or replace function public.rp_progreso_cuota()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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

  if v_modo is distinct from 'reserva' or coalesce(v_n, 0) <= 0 then
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
$$;


-- 4. Permisos: solo con sesión (las funciones revisan que sea un RP).
revoke all on function public.rp_nivel_visibilidad(uuid) from public, anon;
grant execute on function public.rp_nivel_visibilidad(uuid) to authenticated;
revoke all on function public.rp_mis_reservas(date, date) from public, anon;
grant execute on function public.rp_mis_reservas(date, date) to authenticated;
revoke all on function public.rp_progreso_cuota() from public, anon;
grant execute on function public.rp_progreso_cuota() to authenticated;


-- 5. RP dado de baja: no lee reservas ni comisiones aunque conserve una
-- sesión abierta (el login ya lo rechaza, pero un token emitido antes de la
-- baja sigue vivo hasta una hora y se renueva). Restrictivas: se aplican con
-- AND sobre las permisivas. La consulta al perfil va en una función
-- security definer para no evaluar las políticas de profiles desde aquí.
create or replace function public.soy_rp_dado_de_baja()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'rp' and p.activo is false);
$$;
revoke all on function public.soy_rp_dado_de_baja() from public, anon;
grant execute on function public.soy_rp_dado_de_baja() to authenticated;

drop policy if exists reservations_rp_dado_de_baja on public.reservations;
create policy reservations_rp_dado_de_baja on public.reservations
  as restrictive for select to authenticated
  using (not (select public.soy_rp_dado_de_baja()));

drop policy if exists commissions_rp_dado_de_baja on public.commissions;
create policy commissions_rp_dado_de_baja on public.commissions
  as restrictive for select to authenticated
  using (not (select public.soy_rp_dado_de_baja()));
