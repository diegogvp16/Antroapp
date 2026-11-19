-- ============================================================================
-- AntroApp — Estabilidad (bloque 5)
-- Fecha: 2026-11-20
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO, hasta el pase.
-- Requiere: sql/2026-11-20-caja-por-mesa.sql (usa caja_liquidar_cuenta).
-- Rollback: sql/2026-11-20-estabilidad-rollback.sql.
--
-- 1. Una reserva por cliente (con cuenta), antro y noche.
-- 2. registrar_comision_reserva: ya no confía en el navegador. La comisión
--    nace en la caja al cuadrar la mesa; esta función solo vuelve a liquidar
--    (sin duplicar) la cuenta de una mesa ya cuadrada.
-- 3. registrar_pago_dia: la semana y la posición se calculan en la base con
--    la noche de la asistencia; valida contra la fila real y no duplica.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Una reserva por cliente, antro y noche (solo clientes con cuenta).
--    Las anónimas y las de RP (cliente_id nulo) no chocan entre sí: un RP
--    puede traer a dos clientes distintos la misma noche.
--    Cuentan pendiente, confirmada y usada; un estado nuevo (por ejemplo
--    'cancelada') no contaría.
--    En producción, si hay duplicados la creación falla y se revierte todo:
--    antes correr el diagnóstico de sql/2026-11-borrador-una-reserva-por-dia.sql.
-- ----------------------------------------------------------------------------
create unique index if not exists reservations_una_por_cliente_dia
  on public.reservations (cliente_id, club_id, fecha)
  where cliente_id is not null
    and status in ('pendiente', 'confirmada', 'usada');


-- ----------------------------------------------------------------------------
-- 2. registrar_comision_reserva — misma firma (la app vieja la llamaba), sin
--    confiar en ningún dato del navegador: p_consumo_monto, p_week_start y
--    p_week_end se IGNORAN; rp y club se leen de la base.
-- ----------------------------------------------------------------------------
create or replace function public.registrar_comision_reserva(
  p_reservation_id uuid, p_rp_id uuid, p_club_id uuid, p_consumo_monto numeric,
  p_week_start timestamptz, p_week_end timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res public.reservations%rowtype;
  v_cuenta uuid;
  v_estado text;
begin
  select * into v_res from public.reservations where id = p_reservation_id;
  if not found then
    raise exception 'Reserva no encontrada';
  end if;
  if not (public.es_gerente_o_dueno(v_res.club_id)
          or (public.current_role_name() = 'staff' and public.current_club_id() = v_res.club_id)) then
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
$$;


-- ----------------------------------------------------------------------------
-- 3. registrar_pago_dia — misma firma. La semana (lunes a domingo) sale de
--    la NOCHE de la asistencia (rp_attendance.fecha), no del navegador; rp y
--    club se leen de la asistencia; una asistencia genera un solo pago.
--    En modo 'reserva' no hay pago por día.
-- ----------------------------------------------------------------------------
create unique index if not exists rp_pagos_dia_una_por_asistencia
  on public.rp_pagos_dia (rp_attendance_id);

create or replace function public.registrar_pago_dia(
  p_rp_attendance_id uuid, p_rp_id uuid, p_club_id uuid, p_fecha date,
  p_week_start timestamptz, p_week_end timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
  if not (public.es_gerente_o_dueno(v_asis.club_id)
          or (public.current_role_name() = 'staff' and public.current_club_id() = v_asis.club_id)) then
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
$$;

revoke all on function public.registrar_comision_reserva(uuid, uuid, uuid, numeric, timestamptz, timestamptz) from public, anon;
grant execute on function public.registrar_comision_reserva(uuid, uuid, uuid, numeric, timestamptz, timestamptz) to authenticated, service_role;
revoke all on function public.registrar_pago_dia(uuid, uuid, uuid, date, timestamptz, timestamptz) from public, anon;
grant execute on function public.registrar_pago_dia(uuid, uuid, uuid, date, timestamptz, timestamptz) to authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 4. Intentos de login (límite de intentos). Los escribe y lee SOLO la ruta
--    de servidor /api/auth/login con la service role: sin políticas para
--    anon ni authenticated. Correo e IP se guardan como hash (sha256), nunca
--    la contraseña.
-- ----------------------------------------------------------------------------
create table public.login_intentos (
  id          bigint generated always as identity primary key,
  email_hash  text not null,
  ip_hash     text not null,
  exito       boolean not null,
  creado_en   timestamptz not null default now()
);
create index login_intentos_email on public.login_intentos (email_hash, creado_en desc);
create index login_intentos_ip on public.login_intentos (ip_hash, creado_en desc);
alter table public.login_intentos enable row level security;
revoke all on public.login_intentos from public, anon, authenticated;
grant all on public.login_intentos to service_role;
grant usage, select on sequence public.login_intentos_id_seq to service_role;


-- ----------------------------------------------------------------------------
-- 5. Aviso de errores de la app. Los escribe la ruta /api/errores (service
--    role, con límites de tamaño y de frecuencia); solo el admin los lee.
-- ----------------------------------------------------------------------------
create table public.app_errores (
  id          bigint generated always as identity primary key,
  creado_en   timestamptz not null default now(),
  ruta        text check (char_length(ruta) <= 300),
  mensaje     text not null check (char_length(mensaje) <= 1000),
  digest      text check (char_length(digest) <= 100),
  navegador   text check (char_length(navegador) <= 300),
  usuario_id  uuid,
  ip_hash     text
);
create index app_errores_creado on public.app_errores (creado_en desc);
alter table public.app_errores enable row level security;
revoke all on public.app_errores from public, anon, authenticated;
grant select on public.app_errores to authenticated;
grant all on public.app_errores to service_role;
grant usage, select on sequence public.app_errores_id_seq to service_role;
create policy app_errores_select_admin on public.app_errores
  for select to authenticated
  using ((select public.current_role_name()) = 'admin');
