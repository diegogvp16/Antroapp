-- ============================================================================
-- AntroApp — Límite de registros por IP (antiabuso)
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Rollback: sql/post-junta/04-antiabuso-rollback.sql
--
-- POST /api/auth/registro (solo se usa con la bandera del CAPTCHA encendida)
-- cuenta los registros por IP en la última hora: 5 normal, 2 si el CAPTCHA
-- no se pudo verificar (modo degradado). La IP se guarda como hash, sin
-- correo. Solo la escribe y la lee el servidor (service_role): sin políticas
-- para nadie más. Las filas de más de 30 días se borran con
-- antiabuso_limpiar() (docs/operacion.md, revisión semanal).
-- ============================================================================
create table public.registro_intentos (
  id         bigint generated always as identity primary key,
  ip_hash    text not null check (char_length(ip_hash) = 64),
  tipo       text not null check (tipo in ('cliente', 'dueno')),
  degradado  boolean not null default false,
  creado_en  timestamptz not null default now()
);
create index registro_intentos_ip on public.registro_intentos (ip_hash, creado_en desc);

alter table public.registro_intentos enable row level security;
revoke all on public.registro_intentos from public, anon, authenticated;
grant all on public.registro_intentos to service_role;

-- Limpieza de intentos viejos (login y registro). Solo service_role.
create or replace function public.antiabuso_limpiar()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_login int;
  v_registro int;
begin
  delete from public.login_intentos where creado_en < now() - interval '30 days';
  get diagnostics v_login = row_count;
  delete from public.registro_intentos where creado_en < now() - interval '30 days';
  get diagnostics v_registro = row_count;
  return jsonb_build_object('login_intentos', v_login, 'registro_intentos', v_registro);
end;
$$;
revoke all on function public.antiabuso_limpiar() from public, anon, authenticated;
grant execute on function public.antiabuso_limpiar() to service_role;
