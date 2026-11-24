-- ============================================================================
-- AntroApp — Baja y reactivación de staff y gerentes, con motivo y bitácora
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Requiere: el pase 1 (club_es_dueno, caja).
-- Rollback: sql/post-junta/02-baja-personal-rollback.sql
--
-- 1. Un perfil dado de baja (profiles.activo = false) pierde de inmediato
--    todo lo que dependa de su rol, AUNQUE tenga la sesión abierta:
--    current_role_name() y current_club_id() devuelven NULL para él. Todas
--    las políticas de RLS y las funciones pasan por esos dos ayudantes, así
--    que deja de leer y escribir datos del antro en la siguiente consulta.
--    Sigue pudiendo leer su propio perfil (para que la app le diga que está
--    dado de baja).
-- 2. personal_cambiar_estado(): da de baja o reactiva a un staff o gerente,
--    con motivo obligatorio, y deja constancia en personal_movimientos.
--    Además cierra sus sesiones (borra auth.sessions): al vencer su token
--    (≤ 1 h) ya no puede renovarlo. Quién puede:
--      admin  → staff y gerentes de cualquier antro
--      dueño  → staff y gerentes de su antro
--      gerente→ staff de su antro (no a otros gerentes)
--      nadie  → a sí mismo
--    El UPDATE directo de profiles.activo sobre staff y gerentes queda
--    bloqueado (trigger profiles_no_escalar): siempre con motivo.
-- 3. personal_historial(): la bitácora con nombres, para admin, el dueño y
--    los gerentes del antro.
-- ============================================================================

-- 1. Ayudantes: nada para un perfil dado de baja.
create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select role from profiles where id = auth.uid() and activo is not false;
$$;

create or replace function public.current_club_id()
returns uuid
language sql
stable
security definer
set search_path = 'public'
as $$
  select case
    when exists (select 1 from profiles where id = auth.uid() and activo is false) then null
    else coalesce(
      (select club_id from profiles where id = auth.uid()),
      (select id from clubs where dueno_id = auth.uid())
    )
  end;
$$;

-- 2. Bitácora.
create table public.personal_movimientos (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  club_id     uuid not null references public.clubs (id) on delete cascade,
  accion      text not null check (accion in ('baja', 'reactivacion')),
  motivo      text not null check (char_length(motivo) between 3 and 300),
  hecho_por   uuid not null references public.profiles (id),
  hecho_en    timestamptz not null default now()
);
create index personal_movimientos_club on public.personal_movimientos (club_id, hecho_en desc);

alter table public.personal_movimientos enable row level security;
revoke all on public.personal_movimientos from public, anon, authenticated;
grant select on public.personal_movimientos to authenticated;
grant all on public.personal_movimientos to service_role;

create policy personal_movimientos_select on public.personal_movimientos for select to authenticated
  using ((select public.current_role_name()) = 'admin'
         or public.club_es_dueno(club_id)
         or ((select public.current_role_name()) = 'gerente' and club_id = (select public.current_club_id())));
-- Sin políticas de escritura: solo personal_cambiar_estado().

create or replace function public.personal_cambiar_estado(p_profile_id uuid, p_activo boolean, p_motivo text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_yo      uuid := auth.uid();
  v_rol     text := public.current_role_name();
  v_motivo  text := trim(coalesce(p_motivo, ''));
  v_obj     record;
begin
  if v_yo is null or v_rol is null then
    raise exception 'Necesitas iniciar sesión.' using errcode = 'P0001';
  end if;
  if p_activo is null then
    raise exception 'Indica si se da de baja o se reactiva.' using errcode = 'P0001';
  end if;
  if char_length(v_motivo) not between 3 and 300 then
    raise exception 'Escribe el motivo (de 3 a 300 caracteres).' using errcode = 'P0001';
  end if;

  select id, role, club_id, activo, nombre into v_obj
  from public.profiles where id = p_profile_id
  for update;
  if not found or v_obj.role not in ('staff', 'gerente') or v_obj.club_id is null then
    raise exception 'Solo se puede dar de baja o reactivar a staff y gerentes.' using errcode = 'P0001';
  end if;
  if v_obj.id = v_yo then
    raise exception 'No puedes cambiar tu propio estado.' using errcode = 'P0001';
  end if;

  if not (
    v_rol = 'admin'
    or public.club_es_dueno(v_obj.club_id)
    or (v_rol = 'gerente' and public.current_club_id() = v_obj.club_id and v_obj.role = 'staff')
  ) then
    raise exception 'No tienes permiso para cambiar a esta persona.' using errcode = 'P0001';
  end if;

  if v_obj.activo is not distinct from p_activo then
    raise exception '% ya está %.', v_obj.nombre, case when p_activo then 'activo' else 'dado de baja' end using errcode = 'P0001';
  end if;

  perform set_config('antroapp.cambio_personal', 'si', true);
  update public.profiles set activo = p_activo where id = v_obj.id;
  perform set_config('antroapp.cambio_personal', '', true);
  insert into public.personal_movimientos (profile_id, club_id, accion, motivo, hecho_por)
  values (v_obj.id, v_obj.club_id, case when p_activo then 'reactivacion' else 'baja' end, v_motivo, v_yo);

  -- Cierra sus sesiones: ya no puede renovar el token. Si en algún proyecto
  -- no hubiera permiso sobre auth.sessions, la baja vale igual (RLS ya lo
  -- dejó fuera en el paso 1).
  if not p_activo then
    begin
      delete from auth.sessions where user_id = v_obj.id;
    exception when insufficient_privilege then
      null;
    end;
  end if;
end;
$$;
revoke all on function public.personal_cambiar_estado(uuid, boolean, text) from public, anon;
grant execute on function public.personal_cambiar_estado(uuid, boolean, text) to authenticated;

-- El UPDATE directo de activo sobre staff y gerentes (que la política
-- profiles_update_mismo_club permitía al gerente y al dueño) ya no pasa: sin
-- motivo ni bitácora. Los RPs siguen igual que hoy.
create or replace function public.profiles_bloquear_cambio_privilegios()
returns trigger
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'No puedes cambiar el rol de un perfil.';
  end if;
  if new.club_id is distinct from old.club_id then
    raise exception 'No puedes cambiar el club de un perfil.';
  end if;
  if new.activo is distinct from old.activo then
    if old.id = auth.uid() then
      raise exception 'No puedes cambiar tu propio estado activo.';
    end if;
    if public.current_role_name() = 'staff' and old.role <> 'rp' then
      raise exception 'El staff solo da de baja o reactiva RPs.';
    end if;
    -- Staff y gerentes: solo por personal_cambiar_estado() (motivo y bitácora).
    if old.role in ('staff', 'gerente')
       and coalesce(current_setting('antroapp.cambio_personal', true), '') <> 'si' then
      raise exception 'Para dar de baja o reactivar a staff y gerentes usa la pantalla de Equipo (pide motivo).';
    end if;
  end if;
  return new;
end
$$;

-- 3. Historial con nombres (los dueños no comparten club_id con su equipo,
-- así que la lista no se puede armar solo con las políticas de profiles).
create or replace function public.personal_historial(p_club_id uuid, p_limite int default 50)
returns table (
  id uuid, hecho_en timestamptz, accion text, motivo text,
  persona text, persona_rol text, hecho_por text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (
    public.current_role_name() = 'admin'
    or public.club_es_dueno(p_club_id)
    or (public.current_role_name() = 'gerente' and public.current_club_id() = p_club_id)
  ) then
    raise exception 'No tienes permiso para ver este historial.' using errcode = 'P0001';
  end if;
  return query
    select m.id, m.hecho_en, m.accion, m.motivo, p.nombre, p.role, h.nombre
    from public.personal_movimientos m
    join public.profiles p on p.id = m.profile_id
    join public.profiles h on h.id = m.hecho_por
    where m.club_id = p_club_id
    order by m.hecho_en desc
    limit greatest(1, least(coalesce(p_limite, 50), 200));
end;
$$;
revoke all on function public.personal_historial(uuid, int) from public, anon;
grant execute on function public.personal_historial(uuid, int) to authenticated;
