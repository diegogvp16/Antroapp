-- Rollback de sql/post-junta/08-revision-seguridad.sql (regresa a como quedó
-- con 02, 05 y 06). Las aceptaciones y suscripciones guardadas se conservan.
drop function if exists public.mensualidad_vencimientos();
drop function if exists public.mensualidad_aplicar_suscripcion(uuid, text, text, text, timestamptz, timestamptz, boolean, text);
drop function if exists public.mensualidad_rango_status(text);
drop function if exists public.siguiente_corte(timestamptz, text);
alter table public.stripe_eventos drop column if exists procesando_desde;

drop policy if exists aceptaciones_insert_propia on public.aceptaciones_legales;
create policy aceptaciones_insert_propia on public.aceptaciones_legales for insert to authenticated
  with check (profile_id = (select auth.uid()));
drop table if exists public.versiones_legales;

create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select role from profiles where id = auth.uid() and activo is not false;
$$;

create or replace function public.club_es_dueno(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (select 1 from public.clubs c where c.id = p_club_id and c.dueno_id = auth.uid());
$$;

create or replace function public.club_es_dueno_grupo(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and exists (
       select 1
       from public.grupo_miembros m
       join public.grupo_clubs gc on gc.grupo_id = m.grupo_id
       where m.profile_id = auth.uid()
         and m.rol_grupo = 'dueno_grupo'
         and gc.club_id = p_club_id);
$$;
