-- Rollback de sql/post-junta-2/10-alta-club-reglas.sql.
-- Regresa admin_alta_club EXACTAMENTE a la versión de sql/post-junta/01-alta-club.sql
-- (copiada tal cual: el alta deja de guardar reglas de RPs y permisos de caja).
-- No borra nada de los antros ya dados de alta: sus reglas, visibilidad,
-- tarifas y permisos se quedan como cualquier configuración hecha a mano.

create or replace function public.admin_alta_club(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_yo       uuid := auth.uid();
  v_club     jsonb := coalesce(p -> 'club', '{}'::jsonb);
  v_publicar boolean := coalesce((p ->> 'publicar')::boolean, false);
  v_grupo    jsonb := coalesce(p -> 'grupo', '{"modo":"ninguno"}'::jsonb);
  v_modo     text := coalesce(v_grupo ->> 'modo', 'ninguno');
  v_club_id  uuid;
  v_grupo_id uuid;
  v_dueno    uuid;
  v_u        jsonb;
  v_m        jsonb;
  v_rol      text;
  v_cuenta   jsonb := '{}'::jsonb;
  v_mesas    int := 0;
  v_alta     uuid;
begin
  if v_yo is null or public.current_role_name() is distinct from 'admin' then
    raise exception 'Solo el admin da de alta antros.' using errcode = 'P0001';
  end if;

  -- Datos mínimos (la ruta ya validó; esto es la última línea).
  if char_length(trim(coalesce(v_club ->> 'nombre', ''))) not between 2 and 120
     or char_length(trim(coalesce(v_club ->> 'direccion', ''))) not between 3 and 300
     or char_length(trim(coalesce(v_club ->> 'horario', ''))) not between 3 and 120
     or char_length(trim(coalesce(v_club ->> 'ciudad', ''))) not between 2 and 80 then
    raise exception 'Faltan datos del antro: nombre, dirección, ciudad u horario.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p -> 'mesas', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p -> 'mesas', '[]'::jsonb)) > 300 then
    raise exception 'Las mesas no son válidas (máximo 300).' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p -> 'usuarios', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p -> 'usuarios', '[]'::jsonb)) > 400 then
    raise exception 'La lista de usuarios no es válida (máximo 400).' using errcode = 'P0001';
  end if;
  if v_modo not in ('ninguno', 'nuevo', 'existente') then
    raise exception 'Modo de grupo inválido.' using errcode = 'P0001';
  end if;
  begin
    v_alta := (p ->> 'alta_id')::uuid;
  exception when invalid_text_representation then
    v_alta := null;
  end;
  if v_alta is null then
    raise exception 'Falta la clave del alta.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.club_altas a where a.alta_id = v_alta) then
    raise exception 'Esta alta ya se hizo.' using errcode = 'P0001';
  end if;
  -- Rangos de lo informativo (zod los revisa antes; aquí por si llaman directo).
  if nullif(v_club ->> 'edad_minima', '') is not null
     and (v_club ->> 'edad_minima')::int not between 18 and 99 then
    raise exception 'La edad mínima va de 18 a 99.' using errcode = 'P0001';
  end if;
  if coalesce(nullif(v_club ->> 'deposito_monto', '')::numeric, 0) not between 0 and 100000 then
    raise exception 'El depósito va de $0 a $100,000.' using errcode = 'P0001';
  end if;
  if char_length(coalesce(v_club ->> 'ambiente', '')) > 500
     or char_length(coalesce(v_club ->> 'tipo_musica', '')) > 200
     or char_length(coalesce(v_club ->> 'codigo_vestimenta', '')) > 200 then
    raise exception 'Ambiente, música o vestimenta son muy largos.' using errcode = 'P0001';
  end if;

  insert into public.clubs (
    nombre, direccion, ciudad, horario, zona_horaria, ambiente, tipo_musica,
    codigo_vestimenta, edad_minima, deposito_monto, cover_modo, cover_monto,
    tolerancia_hora, estado_verificacion, verificado_en, suscripcion_activa,
    suscripcion_activada_en
  ) values (
    trim(v_club ->> 'nombre'),
    trim(v_club ->> 'direccion'),
    trim(v_club ->> 'ciudad'),
    trim(v_club ->> 'horario'),
    coalesce(nullif(v_club ->> 'zona_horaria', ''), 'America/Mexico_City'),
    nullif(trim(coalesce(v_club ->> 'ambiente', '')), ''),
    nullif(trim(coalesce(v_club ->> 'tipo_musica', '')), ''),
    nullif(trim(coalesce(v_club ->> 'codigo_vestimenta', '')), ''),
    nullif(v_club ->> 'edad_minima', '')::int,
    coalesce(nullif(v_club ->> 'deposito_monto', '')::numeric, 0),
    coalesce(nullif(v_club ->> 'cover_modo', ''), 'oculto'),
    nullif(v_club ->> 'cover_monto', '')::numeric,
    nullif(v_club ->> 'tolerancia_hora', '')::time,
    case when v_publicar then 'verificado' else 'borrador' end,
    case when v_publicar then now() end,
    v_publicar,
    case when v_publicar then now() end
  )
  returning id into v_club_id;

  for v_m in select * from jsonb_array_elements(coalesce(p -> 'mesas', '[]'::jsonb)) loop
    if char_length(trim(coalesce(v_m ->> 'numero', ''))) not between 1 and 30
       or coalesce((v_m ->> 'capacidad')::int, 0) not between 1 and 100 then
      raise exception 'Mesa inválida: "%".', coalesce(v_m ->> 'numero', '') using errcode = 'P0001';
    end if;
    if exists (select 1 from public.club_tables t where t.club_id = v_club_id and lower(t.numero) = lower(trim(v_m ->> 'numero'))) then
      raise exception 'La mesa "%" está repetida.', trim(v_m ->> 'numero') using errcode = 'P0001';
    end if;
    insert into public.club_tables (club_id, numero, capacidad)
    values (v_club_id, trim(v_m ->> 'numero'), (v_m ->> 'capacidad')::int);
    v_mesas := v_mesas + 1;
  end loop;

  for v_u in select * from jsonb_array_elements(coalesce(p -> 'usuarios', '[]'::jsonb)) loop
    v_rol := v_u ->> 'rol';
    if v_rol not in ('gerente', 'staff', 'rp', 'dueno', 'dueno_grupo') then
      raise exception 'Rol inválido: %.', coalesce(v_rol, '(vacío)') using errcode = 'P0001';
    end if;
    if char_length(trim(coalesce(v_u ->> 'nombre', ''))) not between 2 and 120 then
      raise exception 'Falta el nombre de un usuario.' using errcode = 'P0001';
    end if;
    -- Solo cuentas que acaba de crear el alta (marcadas por la ruta, de los
    -- últimos 30 minutos, sin borrar ni bloquear) y que todavía no tienen
    -- perfil: ninguna cuenta ajena se puede ligar al antro.
    if not exists (select 1 from auth.users a
                   where a.id = (v_u ->> 'id')::uuid
                     and a.raw_app_meta_data ->> 'alta_club' = 'true'
                     and a.created_at > now() - interval '30 minutes'
                     and a.deleted_at is null
                     and (a.banned_until is null or a.banned_until < now()))
       or exists (select 1 from public.profiles pr where pr.id = (v_u ->> 'id')::uuid) then
      raise exception 'Una de las cuentas no es nueva.' using errcode = 'P0001';
    end if;

    insert into public.profiles (id, nombre, role, club_id, activo)
    values (
      (v_u ->> 'id')::uuid,
      trim(v_u ->> 'nombre'),
      case when v_rol in ('dueno', 'dueno_grupo') then 'dueno' else v_rol end,
      -- El dueño se liga por clubs.dueno_id (como en /dueno/signup), no por club_id.
      case when v_rol in ('dueno', 'dueno_grupo') then null else v_club_id end,
      true
    );

    if v_rol = 'dueno' then
      if v_dueno is not null then
        raise exception 'Un antro tiene un solo dueño.' using errcode = 'P0001';
      end if;
      v_dueno := (v_u ->> 'id')::uuid;
    end if;
    v_cuenta := jsonb_set(v_cuenta, array[v_rol], to_jsonb(coalesce((v_cuenta ->> v_rol)::int, 0) + 1));
  end loop;

  if v_dueno is not null then
    update public.clubs set dueno_id = v_dueno where id = v_club_id;
  end if;

  -- Grupo.
  if v_modo = 'nuevo' then
    if char_length(trim(coalesce(v_grupo ->> 'nombre', ''))) not between 2 and 120 then
      raise exception 'Escribe el nombre del grupo.' using errcode = 'P0001';
    end if;
    insert into public.grupos (nombre) values (trim(v_grupo ->> 'nombre')) returning id into v_grupo_id;
  elsif v_modo = 'existente' then
    select g.id into v_grupo_id from public.grupos g where g.id = nullif(v_grupo ->> 'grupo_id', '')::uuid;
    if v_grupo_id is null then
      raise exception 'El grupo elegido no existe.' using errcode = 'P0001';
    end if;
  end if;

  if v_grupo_id is not null then
    insert into public.grupo_clubs (grupo_id, club_id) values (v_grupo_id, v_club_id);
    insert into public.grupo_miembros (grupo_id, profile_id, rol_grupo)
    select v_grupo_id, (u ->> 'id')::uuid, 'dueno_grupo'
    from jsonb_array_elements(coalesce(p -> 'usuarios', '[]'::jsonb)) u
    where u ->> 'rol' = 'dueno_grupo'
    on conflict do nothing;
    if coalesce((v_grupo ->> 'dueno_antro_es_dueno_grupo')::boolean, false) and v_dueno is not null then
      insert into public.grupo_miembros (grupo_id, profile_id, rol_grupo)
      values (v_grupo_id, v_dueno, 'dueno_grupo')
      on conflict do nothing;
    end if;
  elsif exists (select 1 from jsonb_array_elements(coalesce(p -> 'usuarios', '[]'::jsonb)) u where u ->> 'rol' = 'dueno_grupo') then
    raise exception 'Un dueño de grupo necesita un grupo.' using errcode = 'P0001';
  end if;

  insert into public.club_altas (alta_id, club_id, creado_por, publicado, resumen)
  values (v_alta, v_club_id, v_yo, v_publicar,
          jsonb_build_object('mesas', v_mesas, 'usuarios', v_cuenta, 'grupo', v_modo, 'grupo_id', v_grupo_id));

  return jsonb_build_object('club_id', v_club_id, 'grupo_id', v_grupo_id, 'mesas', v_mesas, 'usuarios', v_cuenta);
end;
$$;

revoke all on function public.admin_alta_club(jsonb) from public, anon;
grant execute on function public.admin_alta_club(jsonb) to authenticated, service_role;  -- adentro exige admin
