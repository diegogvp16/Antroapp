-- ============================================================================
-- AntroApp — RPs y staff en lote desde un CSV: invitaciones en lote (B1b)
-- Fecha: 2026-11-25 (rama b-equipo, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Rollback: sql/post-junta-2/23-importar-personal-rollback.sql
-- Requiere: 20-correos-salida.sql y 21-invitaciones.sql.
--
-- Decisión: la alta masiva NO crea cuentas con contraseña temporal; crea
-- INVITACIONES de B12 en lote. Así:
--   - es todo o nada de verdad: una sola transacción de Postgres, sin
--     cuentas de Auth creadas a medias que luego haya que borrar;
--   - nadie maneja contraseñas ajenas: cada persona elige la suya al
--     aceptar, con el enlace (un solo uso, vence a las 72 h);
--   - el rol y el antro quedan fijos en la invitación, con la misma matriz
--     de create-staff (invitacion_puede, siempre con coalesce);
--   - revocar, reenviar y la lista de Equipo ya funcionan para ellas.
--
-- Qué agrega:
--   1. invitaciones.telefono (opcional, 10 dígitos) e invitaciones.lote_id.
--      Al aceptar, el teléfono pasa al perfil.
--   2. invitacion_lotes: bitácora de cada importación (quién, cuándo,
--      cuántas). Su id es la clave de idempotencia que manda la pantalla:
--      si la respuesta se pierde y se reintenta, no se duplica nada.
--   3. invitaciones_importar(p_club_id, p_rol, p_lote_id, p_filas): con la
--      SESIÓN de quien importa. Valida TODO antes de escribir; un error en
--      cualquier fila («Línea N: …») y no se guarda ninguna.
--      Límites: 400 filas por lote, 5 lotes por persona por hora, 400
--      pendientes por antro (contando las del lote) y una sola pendiente
--      por correo y antro. No acepta un correo que ya es del equipo de ESE
--      antro (no dice nada de otros antros: no sirve para averiguar quién
--      tiene cuenta en la plataforma).
--   4. invitaciones_emitir_tokens_lote(p_lote_id): solo el servidor; emite
--      los tokens de todas las invitaciones del lote en una llamada (la
--      base guarda solo su sha256) y los devuelve UNA vez.
--   5. invitacion_aceptar: igual que en el 21, más el teléfono al perfil.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bitácora de lotes y columnas nuevas
-- ---------------------------------------------------------------------------
create table public.invitacion_lotes (
  id         uuid primary key,
  club_id    uuid not null references public.clubs (id) on delete cascade,
  rol        text not null check (rol in ('gerente', 'staff', 'rp')),
  hecho_por  uuid references public.profiles (id) on delete set null,
  hecho_en   timestamptz not null default now(),
  total      integer not null check (total between 1 and 400)
);
create index invitacion_lotes_por on public.invitacion_lotes (hecho_por, hecho_en desc);
create index invitacion_lotes_club on public.invitacion_lotes (club_id, hecho_en desc);

alter table public.invitaciones
  add column telefono text check (telefono ~ '^[0-9]{10}$'),
  add column lote_id  uuid references public.invitacion_lotes (id) on delete set null;
create index invitaciones_lote on public.invitaciones (lote_id) where lote_id is not null;

alter table public.invitacion_lotes enable row level security;

create policy invitacion_lotes_select on public.invitacion_lotes
  for select to authenticated
  using (coalesce((select public.invitacion_puede(invitacion_lotes.club_id, invitacion_lotes.rol)), false));
create policy invitacion_lotes_restrictiva_insert on public.invitacion_lotes as restrictive for insert to public with check (false);
create policy invitacion_lotes_restrictiva_update on public.invitacion_lotes as restrictive for update to public using (false);
create policy invitacion_lotes_restrictiva_delete on public.invitacion_lotes as restrictive for delete to public using (false);

revoke all on public.invitacion_lotes from public, anon, authenticated;
grant select on public.invitacion_lotes to authenticated;
grant all on public.invitacion_lotes to service_role;

-- Las columnas nuevas, legibles para quien ya ve la invitación (la RLS de
-- invitaciones no cambia). token_hash sigue sin exponerse.
grant select (telefono, lote_id) on public.invitaciones to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Teléfono mexicano a 10 dígitos. Nulo si viene vacío O si no es válido
--    (quien llama distingue: texto con algo y resultado nulo = inválido).
--    Acepta espacios, guiones, paréntesis, puntos y +52 / 52 / 521.
-- ---------------------------------------------------------------------------
create or replace function public.telefono_mx_10(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d ~ '^[0-9]{10}$' then d
    when d ~ '^52[0-9]{10}$' then substr(d, 3)
    when d ~ '^521[0-9]{10}$' then substr(d, 4)
  end
  from (select regexp_replace(coalesce(p, ''), '[[:space:]().+-]', '', 'g') as d) x;
$$;

-- ---------------------------------------------------------------------------
-- 3. Importar (con la sesión de quien importa)
--    p_filas: [ { linea?: int, nombre: text, correo: text, telefono?: text } ]
--    Devuelve { lote_id, creadas, repetido }.
-- ---------------------------------------------------------------------------
create or replace function public.invitaciones_importar(p_club_id uuid, p_rol text, p_lote_id uuid, p_filas jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_lote     public.invitacion_lotes%rowtype;
  v_fila     jsonb;
  v_pos      integer := 0;
  v_linea    integer;
  v_nombre   text;
  v_correo   text;
  v_tel      text;
  v_lineas   integer[] := '{}';
  v_nombres  text[] := '{}';
  v_correos  text[] := '{}';
  v_tels     text[] := '{}';
  v_n        integer;
  v_choque   integer;
begin
  if not coalesce(p_rol in ('gerente', 'staff', 'rp'), false) then
    raise exception 'Solo se puede invitar como gerente, staff o RP.' using errcode = 'P0001';
  end if;
  if not coalesce(public.invitacion_puede(p_club_id, p_rol), false) then
    raise exception 'No puedes invitar a alguien con ese rol en este antro.' using errcode = 'P0001';
  end if;
  if p_lote_id is null then
    raise exception 'Falta la clave de la importación.' using errcode = 'P0001';
  end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) = 0 then
    raise exception 'No viene ninguna persona.' using errcode = 'P0001';
  end if;
  v_n := jsonb_array_length(p_filas);
  if v_n > 400 then
    raise exception 'Máximo 400 personas por importación (vienen %).', v_n using errcode = 'P0001';
  end if;

  -- Mismo candado por persona que invitacion_crear, más uno por lote.
  perform pg_advisory_xact_lock(hashtextextended('invitar:' || v_uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitacion_lote:' || p_lote_id::text, 0));

  -- Idempotencia: el mismo lote reintentado devuelve lo que ya se guardó.
  select * into v_lote from public.invitacion_lotes where id = p_lote_id;
  if found then
    if v_lote.hecho_por is distinct from v_uid or v_lote.club_id <> p_club_id or v_lote.rol <> p_rol then
      raise exception 'Esa clave de importación ya se usó. Vuelve a revisar la lista.' using errcode = 'P0001';
    end if;
    return jsonb_build_object('lote_id', v_lote.id, 'creadas', v_lote.total, 'repetido', true);
  end if;

  if (select count(*) from public.invitacion_lotes l
      where l.hecho_por = v_uid and l.hecho_en > now() - interval '1 hour') >= 5 then
    raise exception 'Llegaste al límite de 5 importaciones por hora. Intenta más tarde.' using errcode = 'P0001';
  end if;

  -- Se valida TODO antes de escribir.
  for v_fila in select value from jsonb_array_elements(p_filas) loop
    v_pos := v_pos + 1;
    v_linea := case when jsonb_typeof(v_fila -> 'linea') = 'number'
                     and (v_fila ->> 'linea') ~ '^\d{1,6}$' then (v_fila ->> 'linea')::integer
                    else v_pos end;
    if jsonb_typeof(v_fila) <> 'object' then
      raise exception 'Línea %: la fila no es válida.', v_linea using errcode = 'P0001';
    end if;
    v_nombre := btrim(regexp_replace(coalesce(v_fila ->> 'nombre', ''), '\s+', ' ', 'g'));
    if not coalesce(char_length(v_nombre) between 2 and 120, false) then
      raise exception 'Línea %: el nombre va de 2 a 120 letras.', v_linea using errcode = 'P0001';
    end if;
    v_correo := lower(btrim(coalesce(v_fila ->> 'correo', '')));
    if not coalesce(char_length(v_correo) between 3 and 254
                    and v_correo ~ '^[^@\s,;<>"'']+@[^@\s,;<>"'']+\.[^@\s,;<>"'']+$', false) then
      raise exception 'Línea %: revisa el correo, no parece válido.', v_linea using errcode = 'P0001';
    end if;
    v_tel := public.telefono_mx_10(v_fila ->> 'telefono');
    if v_tel is null and btrim(coalesce(v_fila ->> 'telefono', '')) <> '' then
      raise exception 'Línea %: el teléfono debe tener 10 dígitos.', v_linea using errcode = 'P0001';
    end if;
    if v_correo = any (v_correos) then
      raise exception 'Línea %: el correo % viene repetido en la lista.', v_linea, v_correo using errcode = 'P0001';
    end if;
    v_lineas := v_lineas || v_linea;
    v_nombres := v_nombres || v_nombre;
    v_correos := v_correos || v_correo;
    v_tels := v_tels || v_tel;
  end loop;

  -- Un candado por antro + correo, el mismo de invitacion_crear: una
  -- invitación suelta al mismo correo, al mismo tiempo, no pasa doble.
  perform pg_advisory_xact_lock(hashtextextended('invitacion:' || p_club_id::text || ':' || c, 0))
  from unnest(v_correos) c order by c;

  if (select count(*) from public.invitaciones i
      where i.club_id = p_club_id and i.aceptada_en is null and i.revocada_en is null and i.expira_en > now()) + v_n > 400 then
    raise exception 'El antro pasaría de 400 invitaciones pendientes. Revoca algunas o importa menos a la vez.' using errcode = 'P0001';
  end if;

  select x.l into v_choque
  from unnest(v_lineas, v_correos) as x(l, c)
  where exists (select 1 from public.invitaciones i
                where i.club_id = p_club_id and i.correo = x.c
                  and i.aceptada_en is null and i.revocada_en is null and i.expira_en > now())
  order by x.l limit 1;
  if v_choque is not null then
    raise exception 'Línea %: ya hay una invitación pendiente para ese correo. Puedes reenviarla desde Equipo.', v_choque using errcode = 'P0001';
  end if;

  -- Ya es del equipo de ESTE antro (o es su dueño). Solo este antro: no se
  -- revela si el correo tiene cuenta en otro lado.
  select x.l into v_choque
  from unnest(v_lineas, v_correos) as x(l, c)
  where exists (select 1 from auth.users u
                join public.profiles p on p.id = u.id
                where lower(u.email) = x.c
                  and (p.club_id = p_club_id
                       or exists (select 1 from public.clubs cl where cl.id = p_club_id and cl.dueno_id = u.id)))
  order by x.l limit 1;
  if v_choque is not null then
    raise exception 'Línea %: ese correo ya es del equipo de este antro.', v_choque using errcode = 'P0001';
  end if;

  insert into public.invitacion_lotes (id, club_id, rol, hecho_por, total)
  values (p_lote_id, p_club_id, p_rol, v_uid, v_n);

  insert into public.invitaciones (club_id, rol, correo, nombre, telefono, invitado_por, lote_id)
  select p_club_id, p_rol, x.c, x.n, x.t, v_uid, p_lote_id
  from unnest(v_correos, v_nombres, v_tels) as x(c, n, t);

  return jsonb_build_object('lote_id', p_lote_id, 'creadas', v_n, 'repetido', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Emitir los tokens de un lote (solo el servidor, justo después de
--    importar). Solo las pendientes SIN token: no sirve para sacar otra vez
--    los enlaces de un lote ya emitido (para eso está «Reenviar»).
--    Devuelve [ { id, token } ].
-- ---------------------------------------------------------------------------
create or replace function public.invitaciones_emitir_tokens_lote(p_lote_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_token  text;
  v_salida jsonb := '[]'::jsonb;
begin
  for v_id in
    select i.id from public.invitaciones i
    where i.lote_id = p_lote_id and i.aceptada_en is null and i.revocada_en is null
      and i.expira_en > now() and i.token_hash is null
    order by i.creada_en, i.id
    for update
  loop
    v_token := encode(sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), 'hex');
    update public.invitaciones
       set token_hash = sha256(convert_to(v_token, 'UTF8')), token_emitido_en = now(), envios = envios + 1
     where id = v_id;
    v_salida := v_salida || jsonb_build_object('id', v_id, 'token', v_token);
  end loop;
  return v_salida;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Aceptar: el mismo del 21, y el teléfono de la invitación pasa al perfil.
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

  insert into public.profiles (id, nombre, telefono, role, club_id, activo)
  values (p_user_id, v.nombre, v.telefono, v.rol, v.club_id, true);
  update public.invitaciones set aceptada_en = now(), aceptada_por = p_user_id where id = v.id;
  return jsonb_build_object('rol', v.rol, 'club_id', v.club_id, 'correo', v.correo);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke all on function public.telefono_mx_10(text) from public, anon;
grant execute on function public.telefono_mx_10(text) to authenticated, service_role;

revoke all on function public.invitaciones_importar(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.invitaciones_importar(uuid, text, uuid, jsonb) to authenticated, service_role;

revoke all on function public.invitaciones_emitir_tokens_lote(uuid) from public, anon, authenticated;
grant execute on function public.invitaciones_emitir_tokens_lote(uuid) to service_role;

revoke all on function public.invitacion_aceptar(text, uuid) from public, anon, authenticated;
grant execute on function public.invitacion_aceptar(text, uuid) to service_role;

notify pgrst, 'reload schema';
