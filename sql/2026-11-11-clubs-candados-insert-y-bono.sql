-- ============================================================================
-- AntroApp — Candados de clubs: INSERT y bono de plataforma
-- Fecha: 2026-11-11
-- Estado: YA APLICADO en producción (copia tal cual de lo que se corrió).
--
-- Complementa a clubs_candado_verificacion
-- (sql/2026-10-27-verificacion-bucket-y-candado.sql). Los tres dejan pasar
-- sin restricción al service role (auth.uid() nulo) y al admin.
--
-- clubs_candado_insert (BEFORE INSERT)
--   Cierra: que un dueño cree directo contra la API un antro que nazca ya
--   'verificado' (o con verificado_en / motivo_rechazo puestos) o con un
--   bono de plataforma a su gusto. No da error: corrige en silencio y el
--   antro nace en 'borrador', sin datos de verificación y con el bono por
--   defecto (fijo, 0). Por eso /dueno/signup sigue funcionando igual.
--   NO toca suscripcion_activa (ver CLAUDE.md, sección 7).
--
-- clubs_candado_bono (BEFORE UPDATE)
--   Cierra: que un dueño (o staff) cambie bono_organica_tipo o
--   bono_organica_monto de su antro. El bono lo define solo AntroApp; un
--   intento de cambiarlo falla con "El bono de plataforma solo lo define
--   AntroApp." Los demás campos del antro se editan normal.
--
-- Comportamiento verificado con usuarios de prueba el 11/11/2026.
-- ============================================================================

begin;

create or replace function public.clubs_candado_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;
  new.estado_verificacion := 'borrador';
  new.motivo_rechazo := null;
  new.verificado_en := null;
  new.bono_organica_tipo := 'fijo';
  new.bono_organica_monto := 0;
  return new;
end $$;

drop trigger if exists clubs_candado_insert on public.clubs;
create trigger clubs_candado_insert
  before insert on public.clubs
  for each row execute function public.clubs_candado_insert();

create or replace function public.clubs_candado_bono()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;
  if new.bono_organica_tipo is distinct from old.bono_organica_tipo
     or new.bono_organica_monto is distinct from old.bono_organica_monto then
    raise exception 'El bono de plataforma solo lo define AntroApp.';
  end if;
  return new;
end $$;

drop trigger if exists clubs_candado_bono on public.clubs;
create trigger clubs_candado_bono
  before update on public.clubs
  for each row execute function public.clubs_candado_bono();

commit;
