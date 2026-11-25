-- ============================================================================
-- AntroApp — Bandeja de salida de correos (B7, modo "archivo")
-- Fecha: 2026-11-24 (rama b-equipo, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Rollback: sql/post-junta-2/20-correos-salida-rollback.sql
--
-- Todo correo que manda la app pasa por lib/correo.ts y deja aquí una fila:
-- se haya mandado de verdad (estado 'enviado'), solo archivado (modo
-- "archivo", o vista previa / dev con un destinatario fuera de la lista
-- blanca) o con falla del proveedor ('fallido'). El admin la revisa en
-- /admin/correos. Los correos de Supabase Auth (recuperar contraseña,
-- confirmar registro) NO pasan por aquí: los manda Supabase.
--
-- Guarda datos personales (el correo del destinatario): solo la lee el admin
-- (RLS), nadie la escribe desde el navegador (sin políticas de escritura ni
-- GRANT), solo el servidor con service_role. Las filas de más de 30 días las
-- borra correos_purgar(), que llama la tarea diaria.
-- ============================================================================

create table public.correos_salida (
  id            uuid primary key default gen_random_uuid(),
  creado_en     timestamptz not null default now(),
  -- Qué correo es (p. ej. 'alerta:pico_errores'); sirve para filtrar.
  plantilla     text not null check (plantilla ~ '^[a-z0-9_:.-]{1,80}$'),
  destinatario  text not null check (char_length(destinatario) between 3 and 320 and destinatario ~ '^[^@\s]+@[^@\s]+$'),
  asunto        text not null check (char_length(asunto) between 1 and 200 and asunto !~ '[\r\n]'),
  -- Texto plano, ya sin los secretos que pidió ocultar quien lo mandó.
  cuerpo        text not null check (char_length(cuerpo) <= 20000),
  estado        text not null check (estado in ('archivado', 'enviado', 'fallido')),
  -- Por qué quedó así (modo archivo, fuera de producción, código del proveedor…).
  motivo        text check (char_length(motivo) <= 300),
  -- Entorno de Vercel que lo generó: production, preview, development o local.
  entorno       text not null check (entorno in ('production', 'preview', 'development', 'local')),
  club_id       uuid references public.clubs (id) on delete set null,
  proveedor_id  text check (char_length(proveedor_id) <= 120),
  enviado_en    timestamptz
);
create index correos_salida_creado on public.correos_salida (creado_en desc);
create index correos_salida_estado on public.correos_salida (estado, creado_en desc);

alter table public.correos_salida enable row level security;

-- Solo el admin lee. coalesce: una cuenta sin perfil, dada de baja o con
-- contraseña temporal tiene current_role_name() nulo y no pasa.
create policy correos_salida_select_admin on public.correos_salida
  for select to authenticated
  using (coalesce((select public.current_role_name()) = 'admin', false));

-- Sin políticas de insert/update/delete: desde el navegador nadie escribe.
-- GRANT explícitos (en dev la exposición automática está apagada; en
-- producción está encendida y hay que quitarla).
revoke all on public.correos_salida from public, anon, authenticated;
grant select on public.correos_salida to authenticated;
grant all on public.correos_salida to service_role;

-- Purga: borra lo de más de p_dias días (de 7 a 365). Solo el servidor.
create or replace function public.correos_purgar(p_dias integer default 30)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrados integer;
begin
  if not coalesce(p_dias between 7 and 365, false) then
    raise exception 'Los días a conservar van de 7 a 365.' using errcode = 'P0001';
  end if;
  delete from public.correos_salida where creado_en < now() - make_interval(days => p_dias);
  get diagnostics v_borrados = row_count;
  return v_borrados;
end;
$$;
revoke all on function public.correos_purgar(integer) from public, anon, authenticated;
grant execute on function public.correos_purgar(integer) to service_role;
