-- ============================================================================
-- AntroApp — Cupos de invitaciones (sueltas + lote), antro sin verificar,
-- revocar con límite y «volver a sacar los enlaces» de un lote (B12 / B1b)
-- Fecha: 2026-11-25 (rama b-equipo, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Rollback: sql/post-junta-2/24-invitaciones-cupos-rollback.sql
-- Requiere: 21-invitaciones.sql y 23-importar-personal.sql.
--
-- Arregla lo que encontró la revisión del carril:
--   1. Los lotes no contaban para el límite de 30 por persona por hora (solo
--      contaba invitacion_envios y el lote no escribía ahí). Ahora TODO envío
--      deja una fila en invitacion_envios (crear, reenviar, lote, relote) y
--      un solo punto, invitacion_revisar_cupo, aplica los topes:
--        - sueltas (crear + reenviar): 30 por persona por hora (como antes);
--        - todo junto (sueltas + lote + volver a sacar): 400 por persona por
--          hora y 1,000 por persona por día;
--        - por antro, todo junto y de quien sea: 800 por día;
--        - antro SIN verificar (estado_verificacion <> 'verificado'), salvo
--          el admin: 20 por día para el antro y 20 por día para la persona,
--          sumando todos sus antros sin verificar (un segundo antro en
--          borrador no da cupo nuevo). Así quien se registra solo en
--          /dueno/signup no puede usar la plataforma para mandar correos en
--          masa a direcciones cualquiera.
--      Revocar ya no libera cupo (el cupo cuenta envíos, no pendientes) y
--      además tiene su propio límite: 150 por persona por hora.
--   2. invitacion_reenviar no tomaba el candado de antro + correo: una
--      reenviada y una nueva al mismo correo, a la vez, podían quedar las dos
--      pendientes. Ahora lo toma, en el mismo orden que crear e importar
--      (persona → antro → correo).
--   3. Si la respuesta del lote se perdía, no había cómo recuperar los
--      enlaces sin reenviar uno por uno (30 por hora). Nuevo
--      invitaciones_reemitir_lote: solo quien importó, dentro de 24 h, hasta
--      3 veces por lote; cambia los tokens de las pendientes del lote (los
--      anteriores dejan de servir) y el servidor los vuelve a emitir y a
--      mandar. Cuenta como envíos de lote (no de las 30 sueltas).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bitácora: tipos nuevos y marca de reemisión en el lote
-- ---------------------------------------------------------------------------
alter table public.invitacion_envios drop constraint invitacion_envios_tipo_check;
alter table public.invitacion_envios
  add constraint invitacion_envios_tipo_check
  check (tipo in ('crear', 'reenviar', 'lote', 'relote', 'revocar'));

alter table public.invitacion_lotes
  add column reemisiones  integer not null default 0 check (reemisiones between 0 and 3),
  add column reemitido_en timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Un solo punto para los cupos. Interna: la llaman las funciones de
--    invitar, ya autorizadas y con sus candados tomados. Lanza el aviso.
--    p_n: cuántas invitaciones salen; p_suelta: crear/reenviar (cuentan
--    también contra las 30 sueltas por hora).
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_revisar_cupo(p_club_id uuid, p_n integer, p_suelta boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_rol        text := public.current_role_name();
  v_verificado boolean;
begin
  if v_uid is null or p_club_id is null or not coalesce(p_n >= 1, false) then
    raise exception 'No puedes invitar a alguien con ese rol en este antro.' using errcode = 'P0001';
  end if;

  if coalesce(p_suelta, true)
     and (select count(*) from public.invitacion_envios e
          where e.hecho_por = v_uid and e.tipo in ('crear', 'reenviar')
            and e.hecho_en > now() - interval '1 hour') + p_n > 30 then
    raise exception 'Llegaste al límite de 30 invitaciones por hora. Intenta más tarde.' using errcode = 'P0001';
  end if;

  if (select count(*) from public.invitacion_envios e
      where e.hecho_por = v_uid and e.tipo <> 'revocar'
        and e.hecho_en > now() - interval '1 hour') + p_n > 400 then
    raise exception 'Llegaste al límite de 400 invitaciones por hora (sueltas y en lote). Intenta más tarde.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.invitacion_envios e
      where e.hecho_por = v_uid and e.tipo <> 'revocar'
        and e.hecho_en > now() - interval '24 hours') + p_n > 1000 then
    raise exception 'Llegaste al límite de 1,000 invitaciones por día. Intenta mañana.' using errcode = 'P0001';
  end if;

  select coalesce(c.estado_verificacion = 'verificado', false) into v_verificado
  from public.clubs c where c.id = p_club_id;
  v_verificado := coalesce(v_verificado, false);

  if v_verificado or v_rol = 'admin' then
    if (select count(*) from public.invitacion_envios e
        join public.invitaciones i on i.id = e.invitacion_id
        where i.club_id = p_club_id and e.tipo <> 'revocar'
          and e.hecho_en > now() - interval '24 hours') + p_n > 800 then
      raise exception 'Este antro llegó al límite de 800 invitaciones por día. Intenta mañana.' using errcode = 'P0001';
    end if;
  else
    if (select count(*) from public.invitacion_envios e
        join public.invitaciones i on i.id = e.invitacion_id
        where i.club_id = p_club_id and e.tipo <> 'revocar'
          and e.hecho_en > now() - interval '24 hours') + p_n > 20
       or (select count(*) from public.invitacion_envios e
           join public.invitaciones i on i.id = e.invitacion_id
           join public.clubs c on c.id = i.club_id
           where e.hecho_por = v_uid and e.tipo <> 'revocar'
             and c.estado_verificacion is distinct from 'verificado'
             and e.hecho_en > now() - interval '24 hours') + p_n > 20 then
      raise exception 'Mientras el antro no esté verificado se pueden mandar hasta 20 invitaciones al día. Termina la verificación en el panel del dueño.' using errcode = 'P0001';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Crear: igual que en el 21, con el candado de antro y el cupo común.
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

  -- Candados, siempre en este orden: persona → antro → antro + correo.
  perform pg_advisory_xact_lock(hashtextextended('invitar:' || v_uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitar_club:' || p_club_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitacion:' || p_club_id::text || ':' || v_correo, 0));

  perform public.invitacion_revisar_cupo(p_club_id, 1, true);
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
-- 4. Reenviar: igual que en el 21, más el candado de antro + correo (la
--    carrera con una invitación nueva al mismo correo) y el cupo común.
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
  perform pg_advisory_xact_lock(hashtextextended('invitar_club:' || v.club_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitacion:' || v.club_id::text || ':' || v.correo, 0));

  perform public.invitacion_revisar_cupo(v.club_id, 1, true);
  if exists (select 1 from public.invitacion_envios e
             where e.invitacion_id = v.id and e.tipo <> 'revocar'
               and e.hecho_en > now() - interval '2 minutes') then
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
-- 5. Revocar: igual que en el 21, con límite de 150 por persona por hora y
--    su fila en la bitácora.
-- ---------------------------------------------------------------------------
create or replace function public.invitacion_revocar(p_id uuid)
returns void
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
  if not found or not coalesce(public.invitacion_puede(v.club_id, v.rol), false) then
    raise exception 'No encontramos esa invitación.' using errcode = 'P0001';
  end if;
  if v.aceptada_en is not null then
    raise exception 'Esa invitación ya se aceptó: si ya no trabaja aquí, dala de baja en Equipo.' using errcode = 'P0001';
  end if;
  if v.revocada_en is not null then
    raise exception 'Esa invitación ya estaba revocada.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invitar:' || v_uid::text, 0));
  if (select count(*) from public.invitacion_envios e
      where e.hecho_por = v_uid and e.tipo = 'revocar'
        and e.hecho_en > now() - interval '1 hour') >= 150 then
    raise exception 'Llegaste al límite de 150 invitaciones revocadas por hora. Intenta más tarde.' using errcode = 'P0001';
  end if;

  update public.invitaciones set revocada_en = now(), revocada_por = v_uid where id = v.id;
  insert into public.invitacion_envios (invitacion_id, hecho_por, tipo) values (v.id, v_uid, 'revocar');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Importar: igual que en el 23, con el candado de antro, el cupo común
--    (el lote entero cuenta) y una fila 'lote' por invitación en la bitácora.
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

  -- Candados: persona → lote → antro → (después) antro + correo.
  perform pg_advisory_xact_lock(hashtextextended('invitar:' || v_uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitacion_lote:' || p_lote_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitar_club:' || p_club_id::text, 0));

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
  -- El lote entero cuenta para los cupos por persona y por antro.
  perform public.invitacion_revisar_cupo(p_club_id, v_n, false);

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

  -- Un candado por antro + correo, el mismo de invitacion_crear y de
  -- invitacion_reenviar: una invitación suelta al mismo correo, al mismo
  -- tiempo, no pasa doble.
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

  with nuevas as (
    insert into public.invitaciones (club_id, rol, correo, nombre, telefono, invitado_por, lote_id)
    select p_club_id, p_rol, x.c, x.n, x.t, v_uid, p_lote_id
    from unnest(v_correos, v_nombres, v_tels) as x(c, n, t)
    returning id
  )
  insert into public.invitacion_envios (invitacion_id, hecho_por, tipo)
  select nuevas.id, v_uid, 'lote' from nuevas;

  return jsonb_build_object('lote_id', p_lote_id, 'creadas', v_n, 'repetido', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Volver a sacar los enlaces de un lote (con la sesión de quien lo
--    importó). Para cuando la respuesta del lote se perdió o fallaron los
--    tokens: limpia el token de las pendientes del lote (los enlaces
--    anteriores dejan de servir) y el servidor los vuelve a emitir con
--    invitaciones_emitir_tokens_lote y a mandar. Solo quien importó, dentro
--    de 24 h, hasta 3 veces por lote, y cuenta para los cupos (no para las
--    30 sueltas). No alarga el vencimiento.
--    Devuelve { lote_id, pendientes, reemisiones }.
-- ---------------------------------------------------------------------------
create or replace function public.invitaciones_reemitir_lote(p_lote_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_lote public.invitacion_lotes%rowtype;
  v_ids  uuid[];
  v_n    integer;
begin
  select * into v_lote from public.invitacion_lotes where id = p_lote_id for update;
  -- Inexistente, de otra persona o sin permiso: el mismo mensaje.
  if not found or v_uid is null or v_lote.hecho_por is distinct from v_uid
     or not coalesce(public.invitacion_puede(v_lote.club_id, v_lote.rol), false) then
    raise exception 'No encontramos esa importación.' using errcode = 'P0001';
  end if;
  if v_lote.hecho_en < now() - interval '24 hours' then
    raise exception 'Esa importación tiene más de 24 horas: usa «Reenviar» en cada invitación.' using errcode = 'P0001';
  end if;
  if v_lote.reemisiones >= 3 then
    raise exception 'Ya sacaste los enlaces de esta importación 3 veces. Usa «Reenviar» en cada invitación.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(i.id order by i.id), '{}') into v_ids
  from (select i.id from public.invitaciones i
        where i.lote_id = p_lote_id and i.aceptada_en is null and i.revocada_en is null and i.expira_en > now()
        order by i.id
        for update) i;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'No queda ninguna invitación pendiente en esa importación.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invitar:' || v_uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('invitar_club:' || v_lote.club_id::text, 0));
  perform public.invitacion_revisar_cupo(v_lote.club_id, v_n, false);

  update public.invitaciones set token_hash = null, token_emitido_en = null where id = any (v_ids);
  insert into public.invitacion_envios (invitacion_id, hecho_por, tipo)
  select x, v_uid, 'relote' from unnest(v_ids) x;
  update public.invitacion_lotes set reemisiones = reemisiones + 1, reemitido_en = now() where id = p_lote_id;

  return jsonb_build_object('lote_id', p_lote_id, 'pendientes', v_n, 'reemisiones', v_lote.reemisiones + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Permisos de ejecución
-- ---------------------------------------------------------------------------
-- Interna: solo la llaman las funciones de arriba (que son del dueño de las
-- funciones). Nadie desde la API.
revoke all on function public.invitacion_revisar_cupo(uuid, integer, boolean) from public, anon, authenticated, service_role;

revoke all on function public.invitacion_crear(uuid, text, text, text) from public, anon;
grant execute on function public.invitacion_crear(uuid, text, text, text) to authenticated, service_role;
revoke all on function public.invitacion_reenviar(uuid) from public, anon;
grant execute on function public.invitacion_reenviar(uuid) to authenticated, service_role;
revoke all on function public.invitacion_revocar(uuid) from public, anon;
grant execute on function public.invitacion_revocar(uuid) to authenticated, service_role;
revoke all on function public.invitaciones_importar(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.invitaciones_importar(uuid, text, uuid, jsonb) to authenticated, service_role;
revoke all on function public.invitaciones_reemitir_lote(uuid) from public, anon;
grant execute on function public.invitaciones_reemitir_lote(uuid) to authenticated, service_role;


notify pgrst, 'reload schema';
