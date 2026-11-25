-- ============================================================================
-- AntroApp — Invitaciones de personal por correo (B12)
-- Fecha: 2026-11-24 (rama b-equipo, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Rollback: sql/post-junta-2/21-invitaciones-rollback.sql
-- Requiere: 20-correos-salida.sql (el correo sale por lib/correo.ts).
--
-- Flujo:
--   1. Quien invita llama invitacion_crear CON SU SESIÓN (POST
--      /api/equipo/invitar). La base decide si puede: es la misma matriz de
--      /api/admin/create-staff, pero aquí, con coalesce(…, false):
--        admin          -> gerente | staff | rp en cualquier antro
--        dueño          -> gerente | staff | rp solo en SUS antros
--        gerente, staff -> solo rp, solo en SU antro
--        cualquier otro (cliente, rp, sin perfil, dado de baja, contraseña
--        temporal, anónimo) -> nada
--      El club y el rol quedan FIJOS en la fila: al aceptar se toman de aquí,
--      nunca del formulario.
--   2. El servidor (service_role) pide el token con invitacion_emitir_token:
--      32 bytes al azar, se devuelve UNA vez y en la base solo queda su
--      sha256. Vence a las 72 h.
--   3. La persona abre /invitacion/<token>, elige su contraseña y el servidor
--      crea la cuenta de Auth (con el correo de la invitación) y llama
--      invitacion_aceptar: bloquea la fila, revisa que siga pendiente, que la
--      cuenta sea la recién creada para ESTA invitación y que no tenga
--      perfil, y crea el perfil con el rol y el club de la invitación. Un
--      solo uso.
--   Reenviar cambia el token (el anterior deja de servir) y da otras 72 h.
--   Revocar la cierra. Nada se borra.
--
-- Límites: 30 envíos (crear + reenviar) por persona por hora, 2 minutos
-- entre reenvíos de la misma invitación, 400 pendientes por antro y una sola
-- pendiente por correo y antro. Consultar y aceptar por IP los cuenta la ruta
-- pública en invitacion_intentos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------
create table public.invitaciones (
  id                uuid primary key default gen_random_uuid(),
  club_id           uuid not null references public.clubs (id) on delete cascade,
  rol               text not null check (rol in ('gerente', 'staff', 'rp')),
  correo            text not null check (
                      char_length(correo) between 3 and 254
                      and correo = lower(correo)
                      and correo ~ '^[^@\s,;<>"'']+@[^@\s,;<>"'']+\.[^@\s,;<>"'']+$'),
  nombre            text not null check (char_length(nombre) between 2 and 120 and nombre !~ '[\r\n\t]'),
  -- sha256 del token; el token en claro nunca se guarda. Nulo mientras no se
  -- ha emitido (recién creada o recién reenviada).
  token_hash        bytea unique check (octet_length(token_hash) = 32),
  token_emitido_en  timestamptz,
  envios            integer not null default 0 check (envios >= 0),
  invitado_por      uuid references public.profiles (id) on delete set null,
  creada_en         timestamptz not null default now(),
  expira_en         timestamptz not null default now() + interval '72 hours',
  aceptada_en       timestamptz,
  aceptada_por      uuid references public.profiles (id) on delete set null,
  revocada_en       timestamptz,
  revocada_por      uuid references public.profiles (id) on delete set null,
  check (aceptada_en is null or revocada_en is null)
);
create index invitaciones_club on public.invitaciones (club_id, creada_en desc);
create index invitaciones_club_correo on public.invitaciones (club_id, correo);

-- Bitácora de envíos: sirve para el límite por persona y por invitación.
create table public.invitacion_envios (
  id             bigint generated always as identity primary key,
  invitacion_id  uuid not null references public.invitaciones (id) on delete cascade,
  hecho_por      uuid not null,
  tipo           text not null check (tipo in ('crear', 'reenviar')),
  hecho_en       timestamptz not null default now()
);
create index invitacion_envios_por on public.invitacion_envios (hecho_por, hecho_en desc);
create index invitacion_envios_inv on public.invitacion_envios (invitacion_id, hecho_en desc);

-- Intentos de la página pública (consultar / aceptar) por IP, con la IP en
-- hash. Solo el servidor.
create table public.invitacion_intentos (
  id         bigint generated always as identity primary key,
  ip_hash    text not null check (char_length(ip_hash) = 64),
  accion     text not null check (accion in ('consultar', 'aceptar')),
  creado_en  timestamptz not null default now()
);
create index invitacion_intentos_ip on public.invitacion_intentos (ip_hash, accion, creado_en desc);

alter table public.invitaciones enable row level security;
alter table public.invitacion_envios enable row level security;
alter table public.invitacion_intentos enable row level security;

-- ---------------------------------------------------------------------------
-- 2. ¿Puede la sesión actual invitar (o reenviar / revocar) este rol en este
--    antro? Único punto de la matriz. Siempre true o false, nunca NULL.
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_puede(p_club_id uuid, p_rol text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Nulo para cuenta sin perfil, dada de baja o con contraseña temporal.
  v_rol  text := public.current_role_name();
  v_club uuid;
begin
  if auth.uid() is null or v_rol is null or p_club_id is null
     or not coalesce(p_rol in ('gerente', 'staff', 'rp'), false) then
    return false;
  end if;
  if v_rol = 'admin' then
    return exists (select 1 from public.clubs c where c.id = p_club_id);
  end if;
  if v_rol = 'dueno' then
    return coalesce(public.club_es_dueno(p_club_id), false);
  end if;
  if v_rol in ('gerente', 'staff') then
    select p.club_id into v_club
    from public.profiles p
    where p.id = auth.uid() and p.activo is not false;
    return coalesce(p_rol = 'rp' and v_club = p_club_id, false);
  end if;
  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RLS: cada quien ve las invitaciones que podría gestionar. Escritura
--    solo por funciones (restrictivas en false por si alguien agrega una
--    permisiva después).
-- ---------------------------------------------------------------------------
create policy invitaciones_select on public.invitaciones
  for select to authenticated
  using (coalesce((select public.invitacion_puede(invitaciones.club_id, invitaciones.rol)), false));
create policy invitaciones_restrictiva_insert on public.invitaciones as restrictive for insert to public with check (false);
create policy invitaciones_restrictiva_update on public.invitaciones as restrictive for update to public using (false);
create policy invitaciones_restrictiva_delete on public.invitaciones as restrictive for delete to public using (false);

-- GRANT explícitos. token_hash NO se expone: select por columnas.
revoke all on public.invitaciones from public, anon, authenticated;
grant select (id, club_id, rol, correo, nombre, token_emitido_en, envios, invitado_por,
              creada_en, expira_en, aceptada_en, aceptada_por, revocada_en, revocada_por)
  on public.invitaciones to authenticated;
grant all on public.invitaciones to service_role;

revoke all on public.invitacion_envios from public, anon, authenticated;
grant all on public.invitacion_envios to service_role;
revoke all on public.invitacion_intentos from public, anon, authenticated;
grant all on public.invitacion_intentos to service_role;

-- ---------------------------------------------------------------------------
-- 4. Crear (con la sesión de quien invita). Devuelve solo el id: el token lo
--    emite el servidor, así quien invita nunca lo ve.
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_crear(p_club_id uuid, p_rol text, p_correo text, p_nombre text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_correo text := lower(btrim(coalesce(p_correo, '')));
  v_nombre text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  v_id     uuid;
begin
  if not coalesce(p_rol in ('gerente', 'staff', 'rp'), false) then
    raise exception 'Solo se puede invitar como gerente, staff o RP.' using errcode = 'P0001';
  end if;
  if not coalesce(public.invitacion_puede(p_club_id, p_rol), false) then
    raise exception 'No puedes invitar a alguien con ese rol en este antro.' using errcode = 'P0001';
  end if;
  if not coalesce(char_length(v_correo) between 3 and 254
                  and v_correo ~ '^[^@\s,;<>"'']+@[^@\s,;<>"'']+\.[^@\s,;<>"'']+$', false) then
    raise exception 'Revisa el correo: no parece válido.' using errcode = 'P0001';
  end if;
  if not coalesce(char_length(v_nombre) between 2 and 120, false) then
    raise exception 'Escribe el nombre (de 2 a 120 letras).' using errcode = 'P0001';
  end if;

  -- Candados: uno por persona (límite por hora) y uno por antro + correo
  -- (una sola pendiente), para que dos envíos simultáneos no pasen los dos.
  perform pg_advisory_xact_lock(hashtextextended('invitar:' || v_uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitacion:' || p_club_id::text || ':' || v_correo, 0));

  if (select count(*) from public.invitacion_envios e
      where e.hecho_por = v_uid and e.hecho_en > now() - interval '1 hour') >= 30 then
    raise exception 'Llegaste al límite de 30 invitaciones por hora. Intenta más tarde.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.invitaciones i
      where i.club_id = p_club_id and i.aceptada_en is null and i.revocada_en is null and i.expira_en > now()) >= 400 then
    raise exception 'Este antro ya tiene 400 invitaciones pendientes. Revoca o espera a que venzan.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.invitaciones i
             where i.club_id = p_club_id and i.correo = v_correo
               and i.aceptada_en is null and i.revocada_en is null and i.expira_en > now()) then
    raise exception 'Ya hay una invitación pendiente para ese correo. Puedes reenviarla.' using errcode = 'P0001';
  end if;

  insert into public.invitaciones (club_id, rol, correo, nombre, invitado_por)
  values (p_club_id, p_rol, v_correo, v_nombre, v_uid)
  returning id into v_id;
  insert into public.invitacion_envios (invitacion_id, hecho_por, tipo) values (v_id, v_uid, 'crear');
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reenviar (con la sesión de quien reenvía): invalida el token anterior y
--    da otras 72 h. Sirve también para una vencida. El servidor emite
--    después el token nuevo.
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_reenviar(p_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v     public.invitaciones%rowtype;
begin
  select * into v from public.invitaciones where id = p_id for update;
  -- Sin permiso o inexistente: el mismo mensaje (no revela invitaciones ajenas).
  if not found or not coalesce(public.invitacion_puede(v.club_id, v.rol), false) then
    raise exception 'No encontramos esa invitación.' using errcode = 'P0001';
  end if;
  if v.aceptada_en is not null then
    raise exception 'Esa invitación ya se aceptó.' using errcode = 'P0001';
  end if;
  if v.revocada_en is not null then
    raise exception 'Esa invitación está revocada. Crea una nueva.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invitar:' || v_uid::text, 0));
  if (select count(*) from public.invitacion_envios e
      where e.hecho_por = v_uid and e.hecho_en > now() - interval '1 hour') >= 30 then
    raise exception 'Llegaste al límite de 30 invitaciones por hora. Intenta más tarde.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.invitacion_envios e
             where e.invitacion_id = v.id and e.hecho_en > now() - interval '2 minutes') then
    raise exception 'Acabas de enviarla. Espera un par de minutos antes de reenviarla.' using errcode = 'P0001';
  end if;
  -- Una vencida no se revive si ya hay otra pendiente para el mismo correo.
  if exists (select 1 from public.invitaciones i
             where i.id <> v.id and i.club_id = v.club_id and i.correo = v.correo
               and i.aceptada_en is null and i.revocada_en is null and i.expira_en > now()) then
    raise exception 'Ya hay otra invitación pendiente para ese correo.' using errcode = 'P0001';
  end if;

  update public.invitaciones
     set token_hash = null, token_emitido_en = null, expira_en = now() + interval '72 hours'
   where id = v.id;
  insert into public.invitacion_envios (invitacion_id, hecho_por, tipo) values (v.id, v_uid, 'reenviar');
  return v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Revocar (con la sesión). Una aceptada ya no se revoca: a esa persona se
--    le da de baja en Equipo.
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_revocar(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.invitaciones%rowtype;
begin
  select * into v from public.invitaciones where id = p_id for update;
  if not found or not coalesce(public.invitacion_puede(v.club_id, v.rol), false) then
    raise exception 'No encontramos esa invitación.' using errcode = 'P0001';
  end if;
  if v.aceptada_en is not null then
    raise exception 'Esa invitación ya se aceptó: si ya no trabaja aquí, dala de baja en Equipo.' using errcode = 'P0001';
  end if;
  if v.revocada_en is not null then
    raise exception 'Esa invitación ya estaba revocada.' using errcode = 'P0001';
  end if;
  update public.invitaciones set revocada_en = now(), revocada_por = auth.uid() where id = v.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Emitir el token (solo el servidor, justo después de crear o reenviar).
--    Solo funciona sobre una pendiente SIN token: no sirve para sacar un
--    segundo token de una invitación ya enviada.
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_emitir_token(p_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v       public.invitaciones%rowtype;
  v_token text;
begin
  select * into v from public.invitaciones where id = p_id for update;
  if not found or v.aceptada_en is not null or v.revocada_en is not null
     or v.expira_en <= now() or v.token_hash is not null then
    raise exception 'La invitación no está lista para enviarse.' using errcode = 'P0001';
  end if;
  -- 32 bytes de dos UUID v4 (generador criptográfico de Postgres), sin
  -- depender de pgcrypto. El token son 64 caracteres hexadecimales.
  v_token := encode(sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), 'hex');
  update public.invitaciones
     set token_hash = sha256(convert_to(v_token, 'UTF8')), token_emitido_en = now(), envios = envios + 1
   where id = v.id;
  return v_token;
end;
$$;

-- Estado legible de una fila (para consultar y para el servidor).
create or replace function public.invitacion_estado(p_aceptada timestamptz, p_revocada timestamptz, p_expira timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_aceptada is not null then 'aceptada'
    when p_revocada is not null then 'revocada'
    when p_expira <= now() then 'vencida'
    else 'pendiente'
  end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Consultar por token (solo el servidor; la ruta pública cuenta intentos
--    por IP). Sin token_hash ni ids de personas.
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_consultar(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select jsonb_build_object(
           'id', i.id,
           'estado', public.invitacion_estado(i.aceptada_en, i.revocada_en, i.expira_en),
           'correo', i.correo,
           'nombre', i.nombre,
           'rol', i.rol,
           'club_id', i.club_id,
           'club_nombre', c.nombre,
           'expira_en', i.expira_en)
    into v
  from public.invitaciones i
  join public.clubs c on c.id = i.club_id
  where i.token_hash = sha256(convert_to(p_token, 'UTF8'));
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Aceptar (solo el servidor, después de crear la cuenta de Auth). Todo en
--    una transacción: perfil con el rol y club DE LA INVITACIÓN y la marca de
--    aceptada. Si algo no cuadra, error y el servidor borra la cuenta nueva.
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_aceptar(p_token text, p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v        public.invitaciones%rowtype;
  v_correo text;
  v_creado timestamptz;
  v_meta   jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' or p_user_id is null then
    raise exception 'Esta invitación no existe o ya no sirve.' using errcode = 'P0001';
  end if;
  select * into v from public.invitaciones
  where token_hash = sha256(convert_to(p_token, 'UTF8'))
  for update;
  if not found then
    raise exception 'Esta invitación no existe o ya no sirve.' using errcode = 'P0001';
  end if;
  if v.aceptada_en is not null then
    raise exception 'Esta invitación ya se usó. Inicia sesión con tu correo.' using errcode = 'P0001';
  end if;
  if v.revocada_en is not null then
    raise exception 'Esta invitación fue cancelada. Pide una nueva a quien te invitó.' using errcode = 'P0001';
  end if;
  if v.expira_en <= now() then
    raise exception 'Esta invitación venció. Pide que te la reenvíen.' using errcode = 'P0001';
  end if;

  -- La cuenta tiene que ser la que el servidor acaba de crear PARA esta
  -- invitación: mismo correo, marcada con su id y de hace menos de 10
  -- minutos. Nunca se liga una cuenta que ya existía.
  select lower(u.email), u.created_at, coalesce(u.raw_app_meta_data, '{}'::jsonb)
    into v_correo, v_creado, v_meta
  from auth.users u where u.id = p_user_id;
  if not found or v_correo is distinct from v.correo
     or v_creado < now() - interval '10 minutes'
     or (v_meta ->> 'invitacion_id') is distinct from v.id::text then
    raise exception 'La cuenta no corresponde a esta invitación.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'La cuenta no corresponde a esta invitación.' using errcode = 'P0001';
  end if;

  insert into public.profiles (id, nombre, role, club_id, activo)
  values (p_user_id, v.nombre, v.rol, v.club_id, true);
  update public.invitaciones set aceptada_en = now(), aceptada_por = p_user_id where id = v.id;
  return jsonb_build_object('rol', v.rol, 'club_id', v.club_id, 'correo', v.correo);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Limpieza (tarea diaria): intentos de más de 7 días y envíos de más de
--     30. Las invitaciones se conservan (son la bitácora de quién invitó a
--     quién).
-- ---------------------------------------------------------------------------
create or replace function public.invitaciones_limpiar()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_intentos integer;
  v_envios   integer;
begin
  delete from public.invitacion_intentos where creado_en < now() - interval '7 days';
  get diagnostics v_intentos = row_count;
  delete from public.invitacion_envios where hecho_en < now() - interval '30 days';
  get diagnostics v_envios = row_count;
  return jsonb_build_object('intentos', v_intentos, 'envios', v_envios);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke all on function public.invitacion_puede(uuid, text) from public, anon;
grant execute on function public.invitacion_puede(uuid, text) to authenticated, service_role;

revoke all on function public.invitacion_crear(uuid, text, text, text) from public, anon;
grant execute on function public.invitacion_crear(uuid, text, text, text) to authenticated, service_role;
revoke all on function public.invitacion_reenviar(uuid) from public, anon;
grant execute on function public.invitacion_reenviar(uuid) to authenticated, service_role;
revoke all on function public.invitacion_revocar(uuid) from public, anon;
grant execute on function public.invitacion_revocar(uuid) to authenticated, service_role;

revoke all on function public.invitacion_estado(timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.invitacion_estado(timestamptz, timestamptz, timestamptz) to authenticated, service_role;

-- Solo el servidor.
revoke all on function public.invitacion_emitir_token(uuid) from public, anon, authenticated;
grant execute on function public.invitacion_emitir_token(uuid) to service_role;
revoke all on function public.invitacion_consultar(text) from public, anon, authenticated;
grant execute on function public.invitacion_consultar(text) to service_role;
revoke all on function public.invitacion_aceptar(text, uuid) from public, anon, authenticated;
grant execute on function public.invitacion_aceptar(text, uuid) to service_role;
revoke all on function public.invitaciones_limpiar() from public, anon, authenticated;
grant execute on function public.invitaciones_limpiar() to service_role;

notify pgrst, 'reload schema';
