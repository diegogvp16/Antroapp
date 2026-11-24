-- ============================================================================
-- AntroApp — Constancia de aceptación de términos y aviso de privacidad
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Rollback: sql/post-junta/05-legales-rollback.sql
--
-- Con la bandera NEXT_PUBLIC_LEGALES encendida, el registro del cliente y la
-- primera entrada del RP piden aceptar los Términos y el Aviso de
-- privacidad (borradores en docs/legal/). Aquí queda quién aceptó qué
-- versión y cuándo. Cada quien inserta y lee SOLO lo suyo; el admin lee todo.
-- Nadie modifica ni borra (constancia). Sin datos más allá del id.
-- ============================================================================
create table public.aceptaciones_legales (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  documento   text not null check (documento in ('terminos', 'privacidad')),
  version     text not null check (char_length(version) between 1 and 40),
  aceptado_en timestamptz not null default now(),
  unique (profile_id, documento, version)
);

alter table public.aceptaciones_legales enable row level security;
revoke all on public.aceptaciones_legales from public, anon, authenticated;
grant select, insert on public.aceptaciones_legales to authenticated;
grant all on public.aceptaciones_legales to service_role;

create policy aceptaciones_insert_propia on public.aceptaciones_legales for insert to authenticated
  with check (profile_id = (select auth.uid()));
create policy aceptaciones_select on public.aceptaciones_legales for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.current_role_name()) = 'admin');
-- aceptado_en lo pone la base: no se acepta una fecha del navegador.
create or replace function public.aceptaciones_fecha_servidor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.aceptado_en := now();
  return new;
end;
$$;
create trigger aceptaciones_fecha_servidor before insert on public.aceptaciones_legales
  for each row execute function public.aceptaciones_fecha_servidor();
