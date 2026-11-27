-- ============================================================================
-- AntroApp — Banderas de funciones por antro y por grupo (noche 4, base de
-- todo post-junta-3)
-- Fecha: 2026-11-27. Rollback: sql/post-junta-3/00-funciones-club-rollback.sql
-- Prueba (dev): node scripts/dev/probar-funciones-club.mjs
-- Requiere: pase 1 (grupos, grupo_clubs, puede_ver_club, current_role_name).
--
-- Cada función nueva de post-junta-3 va detrás de una bandera, APAGADA por
-- defecto:
--   - club_funciones: el valor de un antro (activa true/false);
--   - grupo_funciones: el valor del grupo (vale para sus antros que no
--     tengan valor propio; un antro pertenece a un solo grupo);
--   - sin fila en ninguna de las dos: apagada.
-- Solo el admin las cambia (funcion_cambiar / grupo_funcion_cambiar), con
-- bitácora en funciones_cambios. Nadie toca las tablas directo por la API.
-- funcion_activa(club, clave) es la que usan las funciones de la base;
-- mis_funciones(club) es la que usa la app (solo si puede ver ese antro).
-- Catálogo fijo (check): agregar una clave = otro SQL con su rollback.
-- ============================================================================
begin;

create table public.club_funciones (
  club_id      uuid not null references public.clubs (id) on delete cascade,
  funcion      text not null check (funcion in ('pos_ventas', 'escaner_respaldo', 'antifraude', 'lista_negra',
                                                'whatsapp', 'reportes_pdf', 'inventario', 'propinas')),
  activa       boolean not null,
  cambiado_por uuid references public.profiles (id) on delete set null,
  cambiado_en  timestamptz not null default now(),
  primary key (club_id, funcion)
);

create table public.grupo_funciones (
  grupo_id     uuid not null references public.grupos (id) on delete cascade,
  funcion      text not null check (funcion in ('pos_ventas', 'escaner_respaldo', 'antifraude', 'lista_negra',
                                                'whatsapp', 'reportes_pdf', 'inventario', 'propinas')),
  activa       boolean not null,
  cambiado_por uuid references public.profiles (id) on delete set null,
  cambiado_en  timestamptz not null default now(),
  primary key (grupo_id, funcion)
);

create table public.funciones_cambios (
  id          bigint generated always as identity primary key,
  club_id     uuid references public.clubs (id) on delete cascade,
  grupo_id    uuid references public.grupos (id) on delete cascade,
  funcion     text not null,
  activa      boolean,               -- null = se quitó el valor propio (sigue al grupo)
  hecho_por   uuid references public.profiles (id) on delete set null,
  hecho_en    timestamptz not null default now(),
  check ((club_id is null) <> (grupo_id is null))
);
create index funciones_cambios_club on public.funciones_cambios (club_id, hecho_en desc);

-- Sin acceso directo por la API (en producción lo nuevo nace abierto a anon
-- y authenticated: se quita explícito). Todo pasa por las funciones.
alter table public.club_funciones enable row level security;
alter table public.grupo_funciones enable row level security;
alter table public.funciones_cambios enable row level security;
revoke all on public.club_funciones, public.grupo_funciones, public.funciones_cambios from public, anon, authenticated;
grant all on public.club_funciones, public.grupo_funciones, public.funciones_cambios to service_role;
revoke all on sequence public.funciones_cambios_id_seq from public, anon, authenticated;
grant usage, select on sequence public.funciones_cambios_id_seq to service_role;

-- Valor efectivo: el del antro, si no el de su grupo, si no apagada.
create function public.funcion_activa(p_club_id uuid, p_funcion text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select cf.activa from public.club_funciones cf where cf.club_id = p_club_id and cf.funcion = p_funcion),
    (select gf.activa from public.grupo_funciones gf
       join public.grupo_clubs gc on gc.grupo_id = gf.grupo_id
      where gc.club_id = p_club_id and gf.funcion = p_funcion),
    false);
$$;
-- Solo para otras funciones de la base (corren como su dueño).
revoke all on function public.funcion_activa(uuid, text) from public, anon, authenticated;
grant execute on function public.funcion_activa(uuid, text) to service_role;

-- Para la app: las funciones encendidas de un antro que quien llama puede ver.
-- Sin permiso (o sin sesión) devuelve vacío, no error.
create function public.mis_funciones(p_club_id uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not coalesce(public.puede_ver_club(p_club_id), false) then
    return;
  end if;
  return query
    select f.funcion
      from unnest(array['pos_ventas', 'escaner_respaldo', 'antifraude', 'lista_negra',
                        'whatsapp', 'reportes_pdf', 'inventario', 'propinas']) as f(funcion)
     where public.funcion_activa(p_club_id, f.funcion);
end;
$$;
revoke all on function public.mis_funciones(uuid) from public, anon;
grant execute on function public.mis_funciones(uuid) to authenticated, service_role;

-- Admin: estado de todas las banderas (propio del antro, del grupo y efectivo).
create function public.funciones_estado()
returns table (club_id uuid, club_nombre text, grupo_id uuid, grupo_nombre text, funcion text,
               valor_club boolean, valor_grupo boolean, efectiva boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin puede ver las funciones en prueba.' using errcode = 'P0001';
  end if;
  return query
    select c.id, c.nombre, g.id, g.nombre, f.funcion,
           cf.activa, gf.activa, coalesce(cf.activa, gf.activa, false)
      from public.clubs c
      cross join unnest(array['pos_ventas', 'escaner_respaldo', 'antifraude', 'lista_negra',
                              'whatsapp', 'reportes_pdf', 'inventario', 'propinas']) as f(funcion)
      left join public.grupo_clubs gc on gc.club_id = c.id
      left join public.grupos g on g.id = gc.grupo_id
      left join public.club_funciones cf on cf.club_id = c.id and cf.funcion = f.funcion
      left join public.grupo_funciones gf on gf.grupo_id = g.id and gf.funcion = f.funcion
     order by c.nombre, f.funcion;
end;
$$;
revoke all on function public.funciones_estado() from public, anon;
grant execute on function public.funciones_estado() to authenticated, service_role;

-- Admin: valor propio de un antro. p_activa null = quitar el valor propio
-- (vuelve a seguir al grupo, o apagada).
create function public.funcion_cambiar(p_club_id uuid, p_funcion text, p_activa boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin puede cambiar las funciones en prueba.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'Ese antro no existe.' using errcode = 'P0001';
  end if;
  if p_funcion is null or p_funcion not in ('pos_ventas', 'escaner_respaldo', 'antifraude', 'lista_negra',
                                            'whatsapp', 'reportes_pdf', 'inventario', 'propinas') then
    raise exception 'Esa función no existe.' using errcode = 'P0001';
  end if;
  if p_activa is null then
    delete from public.club_funciones where club_id = p_club_id and funcion = p_funcion;
  else
    insert into public.club_funciones (club_id, funcion, activa, cambiado_por)
    values (p_club_id, p_funcion, p_activa, auth.uid())
    on conflict (club_id, funcion) do update
      set activa = excluded.activa, cambiado_por = excluded.cambiado_por, cambiado_en = now();
  end if;
  insert into public.funciones_cambios (club_id, funcion, activa, hecho_por)
  values (p_club_id, p_funcion, p_activa, auth.uid());
end;
$$;
revoke all on function public.funcion_cambiar(uuid, text, boolean) from public, anon;
grant execute on function public.funcion_cambiar(uuid, text, boolean) to authenticated, service_role;

create function public.grupo_funcion_cambiar(p_grupo_id uuid, p_funcion text, p_activa boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin puede cambiar las funciones en prueba.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.grupos where id = p_grupo_id) then
    raise exception 'Ese grupo no existe.' using errcode = 'P0001';
  end if;
  if p_funcion is null or p_funcion not in ('pos_ventas', 'escaner_respaldo', 'antifraude', 'lista_negra',
                                            'whatsapp', 'reportes_pdf', 'inventario', 'propinas') then
    raise exception 'Esa función no existe.' using errcode = 'P0001';
  end if;
  if p_activa is null then
    delete from public.grupo_funciones where grupo_id = p_grupo_id and funcion = p_funcion;
  else
    insert into public.grupo_funciones (grupo_id, funcion, activa, cambiado_por)
    values (p_grupo_id, p_funcion, p_activa, auth.uid())
    on conflict (grupo_id, funcion) do update
      set activa = excluded.activa, cambiado_por = excluded.cambiado_por, cambiado_en = now();
  end if;
  insert into public.funciones_cambios (grupo_id, funcion, activa, hecho_por)
  values (p_grupo_id, p_funcion, p_activa, auth.uid());
end;
$$;
revoke all on function public.grupo_funcion_cambiar(uuid, text, boolean) from public, anon;
grant execute on function public.grupo_funcion_cambiar(uuid, text, boolean) to authenticated, service_role;

commit;
