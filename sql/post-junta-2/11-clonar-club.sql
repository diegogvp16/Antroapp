-- ============================================================================
-- AntroApp — Clonar un antro (B2): plantilla de configuración y alta con
-- copia del catálogo, en la MISMA transacción del alta
-- Fecha: 2026-11-24 (rama b-alta, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Requiere: sql/post-junta-2/10-alta-club-reglas.sql (esta versión de
--           admin_alta_club parte de esa, con todo lo suyo) y lo que el 10
--           requiere. El catálogo (public.productos) es de FASE 2: si la
--           tabla no existe, simplemente no se copia (sin error).
-- Rollback: sql/post-junta-2/11-clonar-club-rollback.sql (regresa la
--           versión EXACTA del 10 y borra admin_club_plantilla).
--
-- Cómo funciona el clon (solo admin):
--   1. /admin → «Clonar» en un antro → el asistente de alta llama a
--      admin_club_plantilla(origen), que devuelve SOLO configuración, con
--      columnas explícitas (nunca to_jsonb de la fila de clubs):
--        datos generales menos nombre y dirección (ciudad, zona horaria,
--        horario), cover y políticas, mesas {numero, capacidad}, modo de pago,
--        regla de comisión vigente, qué ve el RP, tarifas por día, permisos
--        de caja POR ROL, catálogo de productos (sin existencias) y el grupo.
--   2. El asistente queda precargado con eso: el admin lo revisa y lo cambia
--      como en un alta normal (es su vista previa). Lo que viaja en el
--      cuerpo es lo mismo que cualquier alta: el admin puede escribir eso a
--      mano, así que no hay nada nuevo que confiar.
--   3. admin_alta_club(p) con p.clonar_de = origen: además de lo del 10,
--      copia AQUÍ (sin leerlo del cuerpo) el catálogo de productos del
--      origen con existencias = 0 y sin movimientos, y deja en club_altas
--      de qué antro salió y cuánto se copió.
--
-- Lo que NO se copia, por diseño (ni la plantilla lo lee ni el alta lo toca):
--   reservas, consumos, caja (noches, sesiones, cuentas, consumos, pagos,
--   cuadres, eventos), comisiones, pagos por día, turnos, asistencias,
--   fotos (club_photos ni archivos de Storage), documentos de verificación,
--   personal y cuentas (profiles), permisos de caja POR PERSONA, overrides
--   por RP (rp_comision_overrides, rp_dia_tarifa_overrides), existencias y
--   movimientos de inventario, dueño (dueno_id), ubicación (lat/lng),
--   suscripción, estado de verificación (nace en borrador salvo que el admin
--   publique, igual que un alta), bono de plataforma, columnas viejas de
--   comisión (clubs.comision_*), reglas programadas a futuro, la bitácora
--   de cambios y las altas (club_altas) del origen.
--
-- Las condiciones van con coalesce(…, false): un NULL nunca deja pasar nada.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Plantilla de configuración de un antro (solo lectura, solo admin).
-- ----------------------------------------------------------------------------
create or replace function public.admin_club_plantilla(p_club uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c         record;
  v_hoy       date;
  v_regla     jsonb;
  v_prog      date;
  v_productos jsonb;
begin
  if not coalesce(auth.uid() is not null and public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin clona antros.' using errcode = 'P0001';
  end if;

  -- Columnas explícitas: nada de dueño, ubicación, suscripción, verificación,
  -- motivo de rechazo, bono ni columnas viejas de comisión.
  select c.id, c.nombre, c.ciudad, c.zona_horaria, c.horario, c.ambiente, c.tipo_musica,
         c.codigo_vestimenta, c.edad_minima, c.deposito_monto, c.cover_modo, c.cover_monto,
         c.tolerancia_hora, c.pago_rp_modo
    into v_c
  from public.clubs c where c.id = p_club;
  if v_c.id is null then
    raise exception 'El antro de origen no existe.' using errcode = 'P0001';
  end if;

  v_hoy := public.club_fecha_operacion(p_club, now());
  -- La regla que manda HOY (nueva, o la anterior traducida, con su origen).
  v_regla := public.regla_comision_descripcion(p_club, v_hoy);
  select min(r.vigente_desde) into v_prog
  from public.reglas_comision r where r.club_id = p_club and r.vigente_desde > v_hoy;

  -- Catálogo de fase 2, solo si la tabla existe (en producción puede no estar).
  if to_regclass('public.productos') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'nombre', pr.nombre, 'categoria', pr.categoria, 'precio_centavos', pr.precio_centavos,
               'existencias_minimas', pr.existencias_minimas, 'activo', pr.activo)
             order by pr.categoria, pr.nombre), '[]'::jsonb)
      from public.productos pr where pr.club_id = $1
    $q$ into v_productos using p_club;
  end if;

  return jsonb_build_object(
    'origen', jsonb_build_object('id', v_c.id, 'nombre', v_c.nombre),
    'club', jsonb_build_object(
      'ciudad', v_c.ciudad, 'zona_horaria', v_c.zona_horaria, 'horario', v_c.horario,
      'ambiente', v_c.ambiente, 'tipo_musica', v_c.tipo_musica, 'codigo_vestimenta', v_c.codigo_vestimenta,
      'edad_minima', v_c.edad_minima, 'deposito_monto', v_c.deposito_monto, 'cover_modo', v_c.cover_modo,
      'cover_monto', v_c.cover_monto, 'tolerancia_hora', to_char(v_c.tolerancia_hora, 'HH24:MI')),
    'mesas', (select coalesce(jsonb_agg(jsonb_build_object('numero', t.numero, 'capacidad', t.capacidad)
                                         order by t.created_at, t.numero), '[]'::jsonb)
              from public.club_tables t where t.club_id = p_club),
    'modo_pago', coalesce(v_c.pago_rp_modo, 'reserva'),
    'regla', v_regla,
    'regla_programada_desde', v_prog,
    'visibilidad', public.rp_nivel_visibilidad(p_club),
    'tarifas_dia', (select coalesce(jsonb_agg(jsonb_build_object('posicion', d.posicion,
                                               'monto_centavos', round(d.monto * 100)::bigint)
                                             order by d.posicion), '[]'::jsonb)
                    from public.club_dia_tarifas d where d.club_id = p_club),
    -- Solo por ROL: los permisos por persona no tienen a quién ir.
    'caja_permisos', (select coalesce(jsonb_agg(jsonb_build_object('permiso', cp.permiso, 'rol', cp.rol,
                                                 'permitido', cp.permitido) order by cp.rol, cp.permiso), '[]'::jsonb)
                      from public.caja_permisos cp
                      where cp.club_id = p_club and cp.profile_id is null and cp.rol in ('staff', 'gerente')),
    'permisos_por_persona', (select count(*) from public.caja_permisos cp
                             where cp.club_id = p_club and cp.profile_id is not null),
    'productos', v_productos,
    'grupo_id', (select gc.grupo_id from public.grupo_clubs gc where gc.club_id = p_club
                 order by gc.agregado_en limit 1));
end;
$$;

revoke all on function public.admin_club_plantilla(uuid) from public, anon;
grant execute on function public.admin_club_plantilla(uuid) to authenticated, service_role;  -- adentro exige admin


-- ----------------------------------------------------------------------------
-- 2. admin_alta_club: la versión del 10 más p.clonar_de (catálogo).
-- ----------------------------------------------------------------------------
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
  -- Reglas de RPs y caja (post-junta-2).
  v_rp         jsonb := p -> 'rp';
  v_regla      jsonb;
  v_modo_pago  text;
  v_vis        text;
  v_tipo       text;
  v_cuota      int;
  v_bp         int;
  v_monto      bigint;
  v_tarifas    jsonb := '[]'::jsonb;
  v_permisos   jsonb := coalesce(p -> 'caja_permisos', '[]'::jsonb);
  v_x          jsonb;
  v_desde      date;
  v_regla_id   uuid;
  v_resumen_rp jsonb;
  -- Clon (post-junta-2, 11).
  v_origen     uuid;
  v_productos  int := 0;
  v_clon       jsonb;
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

  -- ---------- Reglas de RPs (opcional: sin p.rp, como antes) ----------
  if v_rp is not null and jsonb_typeof(v_rp) <> 'null' then
    if jsonb_typeof(v_rp) <> 'object' then
      raise exception 'Las reglas de RPs no son válidas.' using errcode = 'P0001';
    end if;
    v_modo_pago := v_rp ->> 'modo_pago';
    if not coalesce(v_modo_pago in ('reserva', 'dia'), false) then
      raise exception 'Elige cómo se paga a los RPs: por reserva o por día.' using errcode = 'P0001';
    end if;
    v_vis := v_rp ->> 'visibilidad';
    if not coalesce(v_vis in ('estado', 'estado_monto', 'estado_monto_botellas'), false) then
      raise exception 'Elige qué ven los RPs de sus clientes.' using errcode = 'P0001';
    end if;

    v_regla := v_rp -> 'regla';
    if v_regla is not null and jsonb_typeof(v_regla) = 'null' then
      v_regla := null;
    end if;
    if v_regla is null and v_modo_pago = 'reserva' then
      raise exception 'Con pago por reserva hace falta la regla de comisión.' using errcode = 'P0001';
    end if;
    if v_regla is not null then
      if jsonb_typeof(v_regla) <> 'object' then
        raise exception 'La regla de comisión no es válida.' using errcode = 'P0001';
      end if;
      v_tipo := v_regla ->> 'tipo';
      -- Enteros sin signo, sin decimales ni exponentes (nada de casts que truenen).
      v_cuota := case when coalesce(v_regla ->> 'cuota', '') ~ '^[0-9]{1,9}$' then (v_regla ->> 'cuota')::int end;
      v_bp    := case when coalesce(v_regla ->> 'porcentaje_bp', '') ~ '^[0-9]{1,9}$' then (v_regla ->> 'porcentaje_bp')::int end;
      v_monto := case when coalesce(v_regla ->> 'monto_centavos', '') ~ '^[0-9]{1,12}$' then (v_regla ->> 'monto_centavos')::bigint end;
      -- Mismos rangos y mensajes que config_rp_cambiar_regla (07).
      if not coalesce(v_tipo in ('porcentaje', 'fijo', 'cuota'), false) then
        raise exception 'Tipo de regla inválido.' using errcode = 'P0001';
      elsif v_tipo = 'porcentaje' and not coalesce(v_bp between 1 and 10000, false) then
        raise exception 'El porcentaje va de 0.01 %% a 100 %%.' using errcode = 'P0001';
      elsif v_tipo in ('fijo', 'cuota') and not coalesce(v_monto between 1 and 10000000, false) then
        raise exception 'El monto va de $0.01 a $100,000.' using errcode = 'P0001';
      elsif v_tipo = 'cuota' and not coalesce(v_cuota between 1 and 100, false) then
        raise exception 'La cuota va de 1 a 100 reservas.' using errcode = 'P0001';
      end if;
    end if;

    v_tarifas := coalesce(v_rp -> 'tarifas_dia', '[]'::jsonb);
    if jsonb_typeof(v_tarifas) = 'null' then
      v_tarifas := '[]'::jsonb;
    end if;
    if jsonb_typeof(v_tarifas) <> 'array' or jsonb_array_length(v_tarifas) > 7 then
      raise exception 'Las tarifas por día no son válidas (máximo 7).' using errcode = 'P0001';
    end if;
    for v_x in select * from jsonb_array_elements(v_tarifas) loop
      if jsonb_typeof(v_x) <> 'object'
         -- case (y no "and"): el cast solo se evalúa si el texto es un entero.
         or not coalesce(case when (v_x ->> 'posicion') ~ '^[0-9]{1,2}$'
                              then (v_x ->> 'posicion')::int between 1 and 7 end, false)
         or not coalesce(case when (v_x ->> 'monto_centavos') ~ '^[0-9]{1,12}$'
                              then (v_x ->> 'monto_centavos')::bigint between 0 and 10000000 end, false) then
        raise exception 'Cada tarifa por día va del día 1 al 7 y de $0 a $100,000.' using errcode = 'P0001';
      end if;
    end loop;
    if (select count(distinct e ->> 'posicion') from jsonb_array_elements(v_tarifas) e) <> jsonb_array_length(v_tarifas) then
      raise exception 'Hay un día repetido en las tarifas.' using errcode = 'P0001';
    end if;
    if v_modo_pago = 'dia' and jsonb_array_length(v_tarifas) = 0 then
      raise exception 'Con pago por día hace falta al menos la tarifa del día 1.' using errcode = 'P0001';
    end if;
  end if;

  -- ---------- Permisos de caja por rol (opcional) ----------
  if jsonb_typeof(v_permisos) = 'null' then
    v_permisos := '[]'::jsonb;
  end if;
  if jsonb_typeof(v_permisos) <> 'array' or jsonb_array_length(v_permisos) > 18 then
    raise exception 'Los permisos de caja no son válidos.' using errcode = 'P0001';
  end if;
  for v_x in select * from jsonb_array_elements(v_permisos) loop
    if jsonb_typeof(v_x) <> 'object'
       or not coalesce(v_x ->> 'permiso' in ('puerta', 'abrir_mesa', 'registrar_consumo', 'cobrar', 'cerrar_mesa',
                                             'reabrir_mesa', 'anular', 'cuadrar_mesa', 'cerrar_noche'), false)
       or not coalesce(v_x ->> 'rol' in ('staff', 'gerente'), false)
       or coalesce(jsonb_typeof(v_x -> 'permitido'), '') <> 'boolean' then
      raise exception 'Permiso de caja inválido.' using errcode = 'P0001';
    end if;
  end loop;
  if (select count(distinct (e ->> 'permiso') || '|' || (e ->> 'rol')) from jsonb_array_elements(v_permisos) e) <> jsonb_array_length(v_permisos) then
    raise exception 'Hay un permiso de caja repetido.' using errcode = 'P0001';
  end if;

  -- ---------- Clon (opcional): el origen tiene que existir ----------
  if nullif(p ->> 'clonar_de', '') is not null then
    -- Regex antes del cast: un texto raro no truena, da el aviso.
    if not coalesce((p ->> 'clonar_de') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) then
      raise exception 'El antro de origen no existe.' using errcode = 'P0001';
    end if;
    select c.id into v_origen from public.clubs c where c.id = (p ->> 'clonar_de')::uuid;
    if v_origen is null then
      raise exception 'El antro de origen no existe.' using errcode = 'P0001';
    end if;
  end if;

  insert into public.clubs (
    nombre, direccion, ciudad, horario, zona_horaria, ambiente, tipo_musica,
    codigo_vestimenta, edad_minima, deposito_monto, cover_modo, cover_monto,
    tolerancia_hora, estado_verificacion, verificado_en, suscripcion_activa,
    suscripcion_activada_en, pago_rp_modo
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
    case when v_publicar then now() end,
    coalesce(v_modo_pago, 'reserva')
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

  -- ---------- Reglas de RPs: se guardan ----------
  if v_modo_pago is not null then
    insert into public.club_config_rp (club_id, nivel_visibilidad, actualizado_por, actualizado_en)
    values (v_club_id, v_vis, v_yo, now());
    -- En la bitácora solo si cambia lo de la plataforma ("estado y monto").
    if v_vis <> 'estado_monto' then
      insert into public.config_rp_cambios (club_id, que, antes, despues, vigente_desde, hecho_por)
      values (v_club_id, 'visibilidad', to_jsonb('estado_monto'::text), to_jsonb(v_vis),
              public.club_fecha_operacion(v_club_id, now()), v_yo);
    end if;

    if v_regla is not null then
      -- Desde el lunes de la semana del alta (antro nuevo: nada que respetar).
      v_desde := public.lunes_de(public.club_fecha_operacion(v_club_id, now()));
      insert into public.reglas_comision (club_id, tipo, cuota, porcentaje_bp, monto_centavos, vigente_desde, creada_por)
      values (v_club_id, v_tipo,
              case when v_tipo = 'cuota' then v_cuota else 0 end,
              case when v_tipo = 'porcentaje' then v_bp end,
              case when v_tipo in ('fijo', 'cuota') then v_monto end,
              v_desde, v_yo)
      returning id into v_regla_id;
      insert into public.config_rp_cambios (club_id, que, antes, despues, vigente_desde, hecho_por)
      values (v_club_id, 'regla_comision', null,
              jsonb_build_object('tipo', v_tipo, 'cuota', case when v_tipo = 'cuota' then v_cuota else 0 end,
                'porcentaje_bp', case when v_tipo = 'porcentaje' then v_bp end,
                'monto_centavos', case when v_tipo in ('fijo', 'cuota') then v_monto end,
                'alta', true),
              v_desde, v_yo);
    end if;

    insert into public.club_dia_tarifas (club_id, posicion, monto)
    select v_club_id, (e ->> 'posicion')::int, round((e ->> 'monto_centavos')::bigint / 100.0, 2)
    from jsonb_array_elements(v_tarifas) e;

    v_resumen_rp := jsonb_build_object(
      'modo_pago', v_modo_pago, 'visibilidad', v_vis,
      'regla', case when v_regla_id is null then null else v_tipo end,
      'regla_desde', v_desde, 'tarifas_dia', jsonb_array_length(v_tarifas));
  end if;

  insert into public.caja_permisos (club_id, permiso, rol, permitido, actualizado_por)
  select v_club_id, e ->> 'permiso', e ->> 'rol', (e ->> 'permitido')::boolean, v_yo
  from jsonb_array_elements(v_permisos) e;

  -- ---------- Clon: catálogo de productos, sin existencias ----------
  -- Se lee del ORIGEN aquí (no del cuerpo). Existencias en 0 y sin
  -- movimientos (como producto_guardar con existencias iniciales 0). La
  -- tabla es de fase 2: si no existe, no hay catálogo que copiar.
  if v_origen is not null then
    if to_regclass('public.productos') is not null then
      execute $q$
        insert into public.productos (club_id, nombre, categoria, precio_centavos, existencias,
                                      existencias_minimas, activo, creado_por)
        select $1, pr.nombre, pr.categoria, pr.precio_centavos, 0, pr.existencias_minimas, pr.activo, $2
        from public.productos pr where pr.club_id = $3
      $q$ using v_club_id, v_yo, v_origen;
      get diagnostics v_productos = row_count;
    end if;
    v_clon := jsonb_build_object('clonado_de', v_origen, 'productos', v_productos);
  end if;

  insert into public.club_altas (alta_id, club_id, creado_por, publicado, resumen)
  values (v_alta, v_club_id, v_yo, v_publicar,
          jsonb_build_object('mesas', v_mesas, 'usuarios', v_cuenta, 'grupo', v_modo, 'grupo_id', v_grupo_id,
                             'rp', v_resumen_rp, 'caja_permisos', jsonb_array_length(v_permisos),
                             'clon', v_clon));

  return jsonb_build_object('club_id', v_club_id, 'grupo_id', v_grupo_id, 'mesas', v_mesas, 'usuarios', v_cuenta,
                            'rp', v_resumen_rp, 'caja_permisos', jsonb_array_length(v_permisos),
                            'clon', v_clon);
end;
$$;

revoke all on function public.admin_alta_club(jsonb) from public, anon;
grant execute on function public.admin_alta_club(jsonb) to authenticated, service_role;  -- adentro exige admin
