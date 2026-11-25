-- Rollback de sql/post-junta-2/24-invitaciones-cupos.sql.
-- Deja invitacion_crear, invitacion_reenviar e invitacion_revocar como en el
-- 21 e invitaciones_importar como en el 23; quita invitacion_revisar_cupo,
-- invitaciones_reemitir_lote y las columnas reemisiones / reemitido_en de
-- invitacion_lotes. Las filas 'lote', 'relote' y 'revocar' de la bitácora
-- invitacion_envios se BORRAN (son solo conteo para los cupos; las
-- invitaciones no se tocan) para volver a la restricción de tipos del 21.

drop function if exists public.invitaciones_reemitir_lote(uuid);

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

drop function if exists public.invitacion_revisar_cupo(uuid, integer, boolean);

revoke all on function public.invitacion_crear(uuid, text, text, text) from public, anon;
grant execute on function public.invitacion_crear(uuid, text, text, text) to authenticated, service_role;
revoke all on function public.invitacion_reenviar(uuid) from public, anon;
grant execute on function public.invitacion_reenviar(uuid) to authenticated, service_role;
revoke all on function public.invitacion_revocar(uuid) from public, anon;
grant execute on function public.invitacion_revocar(uuid) to authenticated, service_role;
revoke all on function public.invitaciones_importar(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.invitaciones_importar(uuid, text, uuid, jsonb) to authenticated, service_role;

alter table public.invitacion_lotes drop column if exists reemitido_en, drop column if exists reemisiones;

delete from public.invitacion_envios where tipo not in ('crear', 'reenviar');
alter table public.invitacion_envios drop constraint invitacion_envios_tipo_check;
alter table public.invitacion_envios
  add constraint invitacion_envios_tipo_check check (tipo in ('crear', 'reenviar'));

notify pgrst, 'reload schema';
