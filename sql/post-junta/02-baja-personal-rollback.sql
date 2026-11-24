-- Rollback de sql/post-junta/02-baja-personal.sql.
-- Regresa current_role_name() y current_club_id() a como estaban (un perfil
-- dado de baja vuelve a "ver" con su rol si conserva la sesión) y quita la
-- función y la bitácora. NO reactiva a nadie: los perfiles con activo = false
-- se quedan así.
drop function if exists public.personal_historial(uuid, int);
drop function if exists public.personal_cambiar_estado(uuid, boolean, text);
drop table if exists public.personal_movimientos;

create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.current_club_id()
returns uuid
language sql
stable
security definer
set search_path = 'public'
as $$
  select coalesce(
    (select club_id from profiles where id = auth.uid()),
    (select id from clubs where dueno_id = auth.uid())
  );
$$;

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
  end if;
  return new;
end
$$;
