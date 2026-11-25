-- ============================================================================
-- AntroApp — Configuración por grupo (B3): valores por defecto del grupo que
-- los antros heredan mientras no los sobrescriban
-- Fecha: 2026-11-25 (rama b-alta, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Requiere: sql/post-junta/07-config-rp.sql (reglas_comision, club_config_rp,
--           config_rp_cambios, regla_comision_vigente, lunes_de),
--           pase 1 (grupos, grupo_clubs, grupo_miembros, caja_permisos,
--           club_fecha_operacion, club_es_dueno, club_es_dueno_grupo,
--           es_gerente_o_dueno) y sql/post-junta-2/11-clonar-club.sql
--           (este archivo envuelve SU admin_alta_club).
-- Rollback: sql/post-junta-2/12-config-grupo-rollback.sql
--
-- Qué hace
--   El grupo define valores por defecto (grupo_config), por clave:
--     regla_comision  regla de comisión por reserva   VALE DESDE EL LUNES SIGUIENTE
--     visibilidad_rp  qué ve el RP de sus clientes    al momento (no es dinero)
--     modo_pago       por reserva o por día (+ tarifas por día)   al momento*
--     caja_permisos   permisos de caja POR ROL        al momento
--     cover           cover informativo               al momento
--     tolerancia      hora límite de llegada          al momento
--   (*) EXCEPCIÓN EXPLÍCITA a «vale desde el lunes siguiente»: como hoy
--       cuando el dueño lo cambia en «Reglas de pago», el modo y las tarifas
--       por día cambian al momento, ahora en todos los antros que siguen al
--       grupo (la pantalla del grupo pide confirmarlo). Decisión pendiente
--       de Diego si debe esperar al lunes (docs/post-junta-2/b-alta.md).
--       Pasar a «por reserva» un antro SIN ninguna regla le pone antes la
--       regla del grupo (desde el lunes de esa semana) o se rechaza: nunca
--       queda calculando con las columnas viejas clubs.comision_*.
--
--   Concurrencia: un cambio del grupo y uno del antro al mismo tiempo no se
--   pisan. Los dos toman el candado del antro en esa clave
--   ('config_club|club|clave'; la regla, antes, 'regla_comision|club') y el
--   del grupo vuelve a revisar «propio» ya con el candado: si el antro ganó,
--   se respeta y cuenta como propio.
--
--   Modelo de «empujar»: el valor EFECTIVO sigue viviendo en las tablas de
--   cada antro (reglas_comision, club_config_rp, clubs, club_dia_tarifas,
--   caja_permisos). Así el cálculo de comisiones y lo que ve el RP siguen
--   leyendo de UN solo punto en la base (regla_comision_vigente,
--   rp_nivel_visibilidad, caja_tiene_permiso, clubs.pago_rp_modo), sin
--   tocar el camino del dinero, y la historia por antro (vigencias) queda
--   intacta: nada es retroactivo.
--
--   Herencia: un antro del grupo SIGUE al grupo en una clave mientras no
--   tenga una fila en club_config_propia para esa clave. Cuando el grupo
--   cambia un valor, se aplica a los antros que lo siguen (la regla, desde
--   el lunes siguiente de cada antro, en su zona horaria).
--   Sobrescribir: cualquier cambio hecho en el antro (por las funciones de
--   siempre o el UPDATE del dueño) lo marca «propio» (triggers de abajo).
--   «Volver a heredar» (club_config_heredar) borra la marca y aplica el
--   valor del grupo. «Bloqueado»: el grupo puede impedir que sus antros
--   cambien una clave (configurable, no personalizable).
--
--   Quién edita lo del grupo: el dueño del grupo (grupo_miembros.rol_grupo
--   = 'dueno_grupo', con perfil activo de dueño) y el admin. Nadie más.
--   Todo queda en la bitácora grupo_config_cambios (y la regla y la
--   visibilidad, además, en config_rp_cambios de cada antro).
--
--   Alta y clon: admin_alta_club pasa a ser una envoltura de la versión del
--   11 (renombrada _admin_alta_club_base): si el antro entra a un grupo
--   existente, aplica los valores del grupo (p.grupo_config = 'heredar', por
--   defecto) o deja todo como propio (p.grupo_config = 'propio'), menos lo que
--   el grupo bloqueó.
--
--   Antros que YA estaban en un grupo al aplicar este archivo: quedan como
--   «propio» en todas las claves (no cambia nada en silencio). Igual con un
--   antro que el admin agregue a un grupo directo en la tabla.
--
-- Las condiciones de autorización van con coalesce(…, false): un NULL nunca
-- deja pasar nada (hueco del pase 1).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tablas
-- ----------------------------------------------------------------------------
create table public.grupo_config (
  grupo_id        uuid not null references public.grupos (id) on delete cascade,
  clave           text not null check (clave in ('regla_comision', 'visibilidad_rp', 'modo_pago',
                                                 'caja_permisos', 'cover', 'tolerancia')),
  valor           jsonb not null,
  bloqueado       boolean not null default false,
  actualizado_por uuid references public.profiles (id) on delete set null,
  actualizado_en  timestamptz not null default now(),
  primary key (grupo_id, clave)
);

-- Una fila = el antro sobrescribe esa clave (no sigue al grupo).
create table public.club_config_propia (
  club_id uuid not null references public.clubs (id) on delete cascade,
  clave   text not null check (clave in ('regla_comision', 'visibilidad_rp', 'modo_pago',
                                         'caja_permisos', 'cover', 'tolerancia')),
  desde   timestamptz not null default now(),
  por     uuid references public.profiles (id) on delete set null,
  primary key (club_id, clave)
);

create table public.grupo_config_cambios (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos (id) on delete cascade,
  club_id       uuid references public.clubs (id) on delete set null,
  clave         text not null check (clave in ('regla_comision', 'visibilidad_rp', 'modo_pago',
                                               'caja_permisos', 'cover', 'tolerancia', 'todas')),
  accion        text not null check (accion in ('grupo_define', 'grupo_quita', 'club_sobrescribe',
                                                'club_hereda', 'alta_hereda', 'alta_propia')),
  antes         jsonb,
  despues       jsonb,
  bloqueado     boolean,
  vigente_desde date,
  antros        int,
  hecho_por     uuid references public.profiles (id) on delete set null,
  hecho_en      timestamptz not null default now()
);
create index grupo_config_cambios_grupo on public.grupo_config_cambios (grupo_id, hecho_en desc);

-- Sin políticas: nadie con sesión lee ni escribe directo. Todo pasa por las
-- funciones de abajo (security definer), que autorizan.
alter table public.grupo_config enable row level security;
alter table public.club_config_propia enable row level security;
alter table public.grupo_config_cambios enable row level security;
revoke all on public.grupo_config, public.club_config_propia, public.grupo_config_cambios from public, anon, authenticated;
grant all on public.grupo_config, public.club_config_propia, public.grupo_config_cambios to service_role;

-- ----------------------------------------------------------------------------
-- 2. Quién edita lo del grupo
-- ----------------------------------------------------------------------------
-- Dueño del grupo: sesión, perfil ACTIVO de dueño (current_role_name es nulo
-- sin perfil, dado de baja o con contraseña temporal) y miembro dueno_grupo.
create or replace function public.es_dueno_de_grupo(p_grupo uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    auth.uid() is not null
    and public.current_role_name() = 'dueno'
    and exists (select 1 from public.grupo_miembros m
                where m.grupo_id = p_grupo and m.profile_id = auth.uid() and m.rol_grupo = 'dueno_grupo'),
    false);
$$;
revoke all on function public.es_dueno_de_grupo(uuid) from public, anon, authenticated;

create or replace function public.grupo_puede_editar(p_grupo uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.uid() is not null and public.current_role_name() = 'admin', false)
      or public.es_dueno_de_grupo(p_grupo);
$$;
revoke all on function public.grupo_puede_editar(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Validación y forma única de cada valor (la misma para el grupo y para
--    leer el de un antro, para poder compararlos con =).
-- ----------------------------------------------------------------------------
create or replace function public._config_normalizar(p_clave text, p_valor jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_tipo  text;
  v_cuota int;
  v_bp    int;
  v_monto bigint;
  v_x     jsonb;
  v_lista jsonb;
  v_modo  text;
  v_hora  text;
begin
  if p_valor is null or jsonb_typeof(p_valor) = 'null' then
    raise exception 'Falta el valor.' using errcode = 'P0001';
  end if;

  if p_clave = 'regla_comision' then
    if jsonb_typeof(p_valor) <> 'object' then
      raise exception 'La regla de comisión no es válida.' using errcode = 'P0001';
    end if;
    v_tipo := p_valor ->> 'tipo';
    -- Regex antes del cast: nada de casts que truenen.
    v_cuota := case when coalesce(p_valor ->> 'cuota', '') ~ '^[0-9]{1,9}$' then (p_valor ->> 'cuota')::int end;
    v_bp    := case when coalesce(p_valor ->> 'porcentaje_bp', '') ~ '^[0-9]{1,9}$' then (p_valor ->> 'porcentaje_bp')::int end;
    v_monto := case when coalesce(p_valor ->> 'monto_centavos', '') ~ '^[0-9]{1,12}$' then (p_valor ->> 'monto_centavos')::bigint end;
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
    return jsonb_build_object(
      'tipo', v_tipo,
      'cuota', case when v_tipo = 'cuota' then v_cuota else 0 end,
      'porcentaje_bp', case when v_tipo = 'porcentaje' then v_bp end,
      'monto_centavos', case when v_tipo in ('fijo', 'cuota') then v_monto end);

  elsif p_clave = 'visibilidad_rp' then
    if jsonb_typeof(p_valor) <> 'string'
       or not coalesce(p_valor #>> '{}' in ('estado', 'estado_monto', 'estado_monto_botellas'), false) then
      raise exception 'Opción inválida.' using errcode = 'P0001';
    end if;
    return p_valor;

  elsif p_clave = 'modo_pago' then
    if jsonb_typeof(p_valor) <> 'object' then
      raise exception 'El modo de pago no es válido.' using errcode = 'P0001';
    end if;
    v_modo := p_valor ->> 'modo';
    if not coalesce(v_modo in ('reserva', 'dia'), false) then
      raise exception 'Elige cómo se paga a los RPs: por reserva o por día.' using errcode = 'P0001';
    end if;
    v_lista := coalesce(p_valor -> 'tarifas_dia', '[]'::jsonb);
    if jsonb_typeof(v_lista) = 'null' then
      v_lista := '[]'::jsonb;
    end if;
    if jsonb_typeof(v_lista) <> 'array' or jsonb_array_length(v_lista) > 7 then
      raise exception 'Las tarifas por día no son válidas (máximo 7).' using errcode = 'P0001';
    end if;
    for v_x in select * from jsonb_array_elements(v_lista) loop
      if jsonb_typeof(v_x) <> 'object'
         or not coalesce(case when (v_x ->> 'posicion') ~ '^[0-9]{1,2}$'
                              then (v_x ->> 'posicion')::int between 1 and 7 end, false)
         or not coalesce(case when (v_x ->> 'monto_centavos') ~ '^[0-9]{1,12}$'
                              then (v_x ->> 'monto_centavos')::bigint between 0 and 10000000 end, false) then
        raise exception 'Cada tarifa por día va del día 1 al 7 y de $0 a $100,000.' using errcode = 'P0001';
      end if;
    end loop;
    if (select count(distinct e ->> 'posicion') from jsonb_array_elements(v_lista) e) <> jsonb_array_length(v_lista) then
      raise exception 'Hay un día repetido en las tarifas.' using errcode = 'P0001';
    end if;
    if v_modo = 'dia' and jsonb_array_length(v_lista) = 0 then
      raise exception 'Con pago por día hace falta al menos la tarifa del día 1.' using errcode = 'P0001';
    end if;
    -- Por reserva, las tarifas no cuentan: no se guardan en el grupo.
    return jsonb_build_object('modo', v_modo, 'tarifas_dia', case when v_modo = 'reserva' then '[]'::jsonb else
      (select coalesce(jsonb_agg(jsonb_build_object('posicion', (e ->> 'posicion')::int,
                                                    'monto_centavos', (e ->> 'monto_centavos')::bigint)
                                 order by (e ->> 'posicion')::int), '[]'::jsonb)
       from jsonb_array_elements(v_lista) e) end);

  elsif p_clave = 'caja_permisos' then
    if jsonb_typeof(p_valor) <> 'array' or jsonb_array_length(p_valor) > 18 then
      raise exception 'Los permisos de caja no son válidos.' using errcode = 'P0001';
    end if;
    for v_x in select * from jsonb_array_elements(p_valor) loop
      if jsonb_typeof(v_x) <> 'object'
         or not coalesce(v_x ->> 'permiso' in ('puerta', 'abrir_mesa', 'registrar_consumo', 'cobrar', 'cerrar_mesa',
                                               'reabrir_mesa', 'anular', 'cuadrar_mesa', 'cerrar_noche'), false)
         or not coalesce(v_x ->> 'rol' in ('staff', 'gerente'), false)
         or coalesce(jsonb_typeof(v_x -> 'permitido'), '') <> 'boolean' then
        raise exception 'Permiso de caja inválido.' using errcode = 'P0001';
      end if;
    end loop;
    if (select count(distinct (e ->> 'permiso') || '|' || (e ->> 'rol')) from jsonb_array_elements(p_valor) e) <> jsonb_array_length(p_valor) then
      raise exception 'Hay un permiso de caja repetido.' using errcode = 'P0001';
    end if;
    return (select coalesce(jsonb_agg(jsonb_build_object('permiso', e ->> 'permiso', 'rol', e ->> 'rol',
                                                         'permitido', (e ->> 'permitido')::boolean)
                                      order by e ->> 'permiso', e ->> 'rol'), '[]'::jsonb)
            from jsonb_array_elements(p_valor) e);

  elsif p_clave = 'cover' then
    if jsonb_typeof(p_valor) <> 'object'
       or not coalesce(p_valor ->> 'cover_modo' in ('oculto', 'monto', 'libre', 'consultar'), false) then
      raise exception 'Elige cómo se muestra el cover.' using errcode = 'P0001';
    end if;
    v_monto := case when coalesce(p_valor ->> 'cover_monto_centavos', '') ~ '^[0-9]{1,12}$'
                    then (p_valor ->> 'cover_monto_centavos')::bigint end;
    if p_valor ->> 'cover_modo' = 'monto' and not coalesce(v_monto between 1 and 10000000, false) then
      raise exception 'El cover va de $0.01 a $100,000.' using errcode = 'P0001';
    end if;
    return jsonb_build_object('cover_modo', p_valor ->> 'cover_modo',
                              'cover_monto_centavos', case when p_valor ->> 'cover_modo' = 'monto' then v_monto end);

  elsif p_clave = 'tolerancia' then
    if jsonb_typeof(p_valor) <> 'object' then
      raise exception 'La hora límite no es válida.' using errcode = 'P0001';
    end if;
    v_hora := nullif(p_valor ->> 'tolerancia_hora', '');
    if v_hora is not null and not coalesce(v_hora ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$', false) then
      raise exception 'La hora límite va en formato HH:MM.' using errcode = 'P0001';
    end if;
    return jsonb_build_object('tolerancia_hora', v_hora);
  end if;

  raise exception 'Configuración desconocida.' using errcode = 'P0001';
end;
$$;
revoke all on function public._config_normalizar(text, jsonb) from public, anon, authenticated;

-- Valor ACTUAL de un antro en la misma forma (para comparar y mostrar).
-- La regla es la que vale hoy en el antro (nula si sigue con lo anterior).
create or replace function public._config_valor_club(p_club uuid, p_clave text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c public.clubs%rowtype;
  v_r public.reglas_comision;
begin
  select * into v_c from public.clubs where id = p_club;
  if not found then
    return null;
  end if;
  if p_clave = 'regla_comision' then
    v_r := public.regla_comision_vigente(p_club, public.club_fecha_operacion(p_club, now()));
    if v_r.id is null then
      return null;
    end if;
    return jsonb_build_object('tipo', v_r.tipo, 'cuota', v_r.cuota, 'porcentaje_bp', v_r.porcentaje_bp,
                              'monto_centavos', v_r.monto_centavos);
  elsif p_clave = 'visibilidad_rp' then
    return to_jsonb(public.rp_nivel_visibilidad(p_club));
  elsif p_clave = 'modo_pago' then
    return jsonb_build_object('modo', v_c.pago_rp_modo, 'tarifas_dia', case when v_c.pago_rp_modo = 'reserva' then '[]'::jsonb else
      (select coalesce(jsonb_agg(jsonb_build_object('posicion', d.posicion, 'monto_centavos', round(d.monto * 100)::bigint)
                                 order by d.posicion), '[]'::jsonb)
       from public.club_dia_tarifas d where d.club_id = p_club) end);
  elsif p_clave = 'caja_permisos' then
    return (select coalesce(jsonb_agg(jsonb_build_object('permiso', cp.permiso, 'rol', cp.rol, 'permitido', cp.permitido)
                                      order by cp.permiso, cp.rol), '[]'::jsonb)
            from public.caja_permisos cp where cp.club_id = p_club and cp.rol is not null);
  elsif p_clave = 'cover' then
    return jsonb_build_object('cover_modo', v_c.cover_modo,
                              'cover_monto_centavos', case when v_c.cover_modo = 'monto' then round(v_c.cover_monto * 100)::bigint end);
  elsif p_clave = 'tolerancia' then
    return jsonb_build_object('tolerancia_hora', to_char(v_c.tolerancia_hora, 'HH24:MI'));
  end if;
  return null;
end;
$$;
revoke all on function public._config_valor_club(uuid, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Aplicador interno: escribe el valor en las tablas del antro.
--    SIN autorización (la hacen quienes lo llaman) y sin EXECUTE para nadie
--    con sesión: llamarlo por rpc daría permiso denegado.
--    p_desde: solo para la regla; nulo = el lunes siguiente del antro.
--    p_forzar: false (un cambio del grupo) = si el antro es «propio» en
--      esta clave no se toca, revisado DESPUÉS de tomar los candados (un
--      cambio del antro que llegó al mismo tiempo gana y se respeta);
--      true («volver al del grupo», bloqueo, alta) = se aplica y el antro
--      queda siguiendo al grupo (se borra su marca de propio).
--    Devuelve true si cambió algo.
--
--    Candados, siempre en este orden (el mismo que toma un cambio hecho en
--    el antro, para no trabarse entre los dos):
--      regla           'regla_comision|club' (config_rp_cambiar_regla) y
--                      luego el del antro en la clave
--      visibilidad,    el del antro en la clave ('config_club|club|clave',
--      caja_permisos   que toma _config_marcar_propia en el trigger BEFORE
--                      INSERT, antes de tocar la fila)
--      modo_pago,      la fila de clubs (for no key update, como el UPDATE
--      cover,          del dueño, que la toma antes de su trigger) y luego
--      tolerancia      el del antro en la clave
-- ----------------------------------------------------------------------------
create or replace function public._config_aplicar_club(
  p_club uuid, p_clave text, p_valor jsonb, p_por uuid, p_desde date default null, p_forzar boolean default false)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_valor   jsonb := public._config_normalizar(p_clave, p_valor);
  v_por     uuid := (select pr.id from public.profiles pr where pr.id = p_por);
  v_prev_g  text := coalesce(current_setting('antroapp.config_grupo', true), '');
  v_prev_rp text := coalesce(current_setting('antroapp.config_rp', true), '');
  v_hoy     date;
  v_desde   date;
  v_actual  public.reglas_comision;
  v_abierta public.reglas_comision;
  v_antes   jsonb;
  v_regla_g jsonb;
  v_nombre  text;
  v_cambio  boolean := false;
begin
  -- 1. Candados (ver el orden arriba).
  if p_clave = 'regla_comision' then
    perform pg_advisory_xact_lock(hashtextextended('regla_comision|' || p_club::text, 0));
  elsif p_clave in ('modo_pago', 'cover', 'tolerancia') then
    perform 1 from public.clubs c where c.id = p_club for no key update;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('config_club|' || p_club::text || '|' || p_clave, 0));

  -- 2. Con los candados tomados (y una lectura nueva: lo que otro confirmó
  --    mientras se esperaba ya se ve), ¿el antro es propio en esta clave?
  if coalesce(p_forzar, false) then
    delete from public.club_config_propia where club_id = p_club and clave = p_clave;
  elsif exists (select 1 from public.club_config_propia p where p.club_id = p_club and p.clave = p_clave) then
    return false;
  end if;

  -- Marca para los triggers: lo que se escribe aquí viene del grupo y NO
  -- vuelve «propio» al antro. Solo dura la transacción; al final se deja
  -- como estaba (esta función se puede llamar dentro de sí misma).
  perform set_config('antroapp.config_grupo', 'on', true);
  -- Por si otro bloque pone candado a las columnas de pago de clubs.
  perform set_config('antroapp.config_rp', 'on', true);

  if p_clave = 'regla_comision' then
    v_hoy := public.club_fecha_operacion(p_club, now());
    v_desde := coalesce(p_desde, public.lunes_de(v_hoy) + 7);
    -- Si desde esa fecha ya vale exactamente esa regla (y nada después la
    -- cambia), no hay nada que hacer.
    v_actual := public.regla_comision_vigente(p_club, v_desde);
    if not (v_actual.id is not null and v_actual.vigente_hasta is null
            and jsonb_build_object('tipo', v_actual.tipo, 'cuota', v_actual.cuota,
                                   'porcentaje_bp', v_actual.porcentaje_bp, 'monto_centavos', v_actual.monto_centavos) = v_valor
            and not exists (select 1 from public.reglas_comision r where r.club_id = p_club and r.vigente_desde > v_desde)) then
      v_antes := coalesce(
        (select jsonb_build_object('tipo', r.tipo, 'cuota', r.cuota, 'porcentaje_bp', r.porcentaje_bp,
           'monto_centavos', r.monto_centavos, 'vigente_desde', r.vigente_desde, 'programada', true)
         from public.reglas_comision r where r.club_id = p_club and r.vigente_desde >= v_desde
         order by r.vigente_desde desc limit 1),
        public.regla_comision_descripcion(p_club, v_hoy));
      -- Igual que config_rp_cambiar_regla: lo programado (aún no vigente) se
      -- reemplaza y lo vigente se cierra el domingo anterior. Nunca se toca
      -- una regla que ya valió.
      delete from public.reglas_comision where club_id = p_club and vigente_desde >= v_desde;
      select * into v_abierta from public.reglas_comision where club_id = p_club and vigente_hasta is null for update;
      if v_abierta.id is not null then
        update public.reglas_comision set vigente_hasta = v_desde - 1 where id = v_abierta.id;
      end if;
      insert into public.reglas_comision (club_id, tipo, cuota, porcentaje_bp, monto_centavos, vigente_desde, creada_por)
      values (p_club, v_valor ->> 'tipo', (v_valor ->> 'cuota')::int, (v_valor ->> 'porcentaje_bp')::int,
              (v_valor ->> 'monto_centavos')::bigint, v_desde,
              coalesce(v_por, (select c.dueno_id from public.clubs c where c.id = p_club),
                       (select r.creada_por from public.reglas_comision r where r.club_id = p_club limit 1)));
      if v_por is not null then
        insert into public.config_rp_cambios (club_id, que, antes, despues, vigente_desde, hecho_por)
        values (p_club, 'regla_comision', v_antes, v_valor || jsonb_build_object('grupo', true), v_desde, v_por);
      end if;
      v_cambio := true;
    end if;

  elsif p_clave = 'visibilidad_rp' then
    v_antes := to_jsonb(public.rp_nivel_visibilidad(p_club));
    if v_antes is distinct from v_valor then
      insert into public.club_config_rp (club_id, nivel_visibilidad, actualizado_por, actualizado_en)
      values (p_club, v_valor #>> '{}', v_por, now())
      on conflict (club_id) do update set nivel_visibilidad = excluded.nivel_visibilidad,
        actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;
      if v_por is not null then
        insert into public.config_rp_cambios (club_id, que, antes, despues, vigente_desde, hecho_por)
        values (p_club, 'visibilidad', v_antes, v_valor, public.club_fecha_operacion(p_club, now()), v_por);
      end if;
      v_cambio := true;
    end if;

  elsif p_clave = 'modo_pago' then
    if public._config_valor_club(p_club, 'modo_pago') is distinct from v_valor then
      -- Pasar a «por reserva» un antro sin ninguna regla de comisión lo
      -- dejaría calculando con las columnas viejas (clubs.comision_*, $0):
      -- se le pone antes la regla del grupo (desde el lunes de esta semana:
      -- el antro no tenía ninguna, no hay nada que respetar) o se rechaza.
      if v_valor ->> 'modo' = 'reserva'
         and (select c.pago_rp_modo from public.clubs c where c.id = p_club) is distinct from 'reserva'
         and not exists (select 1 from public.reglas_comision r where r.club_id = p_club) then
        select gcf.valor into v_regla_g
        from public.grupo_clubs gc
        join public.grupo_config gcf on gcf.grupo_id = gc.grupo_id and gcf.clave = 'regla_comision'
        where gc.club_id = p_club;
        if v_regla_g is null then
          select c.nombre into v_nombre from public.clubs c where c.id = p_club;
          raise exception 'Para pagar por reserva en «%» hace falta la regla de comisión: defínela en el grupo o en el antro antes de cambiar el modo de pago.', v_nombre
            using errcode = 'P0001';
        end if;
        perform public._config_aplicar_club(p_club, 'regla_comision', v_regla_g, p_por,
                                            public.lunes_de(public.club_fecha_operacion(p_club, now())), true);
        -- (Esa llamada deja las marcas como las encontró: siguen en 'on'.)
      end if;
      update public.clubs set pago_rp_modo = v_valor ->> 'modo'
      where id = p_club and pago_rp_modo is distinct from v_valor ->> 'modo';
      -- Por día: las tarifas del grupo reemplazan las del antro. Por
      -- reserva no se tocan (no cuentan).
      if v_valor ->> 'modo' = 'dia' then
        delete from public.club_dia_tarifas where club_id = p_club;
        insert into public.club_dia_tarifas (club_id, posicion, monto)
        select p_club, (e ->> 'posicion')::int, round((e ->> 'monto_centavos')::bigint / 100.0, 2)
        from jsonb_array_elements(v_valor -> 'tarifas_dia') e;
      end if;
      v_cambio := true;
    end if;

  elsif p_clave = 'caja_permisos' then
    if public._config_valor_club(p_club, 'caja_permisos') is distinct from v_valor then
      -- Las casillas POR ROL quedan exactamente como las del grupo (lo que el
      -- grupo no define vuelve al valor de la plataforma). Las casillas por
      -- persona no se tocan: siguen ganando sobre el rol.
      delete from public.caja_permisos cp
      where cp.club_id = p_club and cp.rol is not null
        and not exists (select 1 from jsonb_array_elements(v_valor) e
                        where e ->> 'permiso' = cp.permiso and e ->> 'rol' = cp.rol);
      insert into public.caja_permisos as cp (club_id, permiso, rol, permitido, actualizado_por)
      select p_club, e ->> 'permiso', e ->> 'rol', (e ->> 'permitido')::boolean, v_por
      from jsonb_array_elements(v_valor) e
      on conflict (club_id, permiso, rol) where rol is not null
      do update set permitido = excluded.permitido, actualizado_por = excluded.actualizado_por, actualizado_en = now()
      where cp.permitido is distinct from excluded.permitido;
      v_cambio := true;
    end if;

  elsif p_clave = 'cover' then
    if public._config_valor_club(p_club, 'cover') is distinct from v_valor then
      update public.clubs
      set cover_modo = v_valor ->> 'cover_modo',
          cover_monto = case when v_valor ->> 'cover_modo' = 'monto'
                             then round((v_valor ->> 'cover_monto_centavos')::bigint / 100.0, 2) end
      where id = p_club;
      v_cambio := true;
    end if;

  elsif p_clave = 'tolerancia' then
    if public._config_valor_club(p_club, 'tolerancia') is distinct from v_valor then
      update public.clubs set tolerancia_hora = (v_valor ->> 'tolerancia_hora')::time where id = p_club;
      v_cambio := true;
    end if;
  end if;

  perform set_config('antroapp.config_rp', v_prev_rp, true);
  perform set_config('antroapp.config_grupo', v_prev_g, true);
  return v_cambio;
end;
$$;
revoke all on function public._config_aplicar_club(uuid, text, jsonb, uuid, date, boolean) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. Triggers: un cambio hecho EN el antro lo vuelve «propio» (y, si el
--    grupo bloqueó esa clave, se rechaza). Lo que escribe el grupo trae la
--    marca antroapp.config_grupo y no cuenta.
-- ----------------------------------------------------------------------------
create or replace function public._config_marcar_propia(p_club uuid, p_clave text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grupo  uuid;
  v_nombre text;
  v_yo     uuid := (select pr.id from public.profiles pr where pr.id = auth.uid());
  v_n      int;
begin
  if coalesce(current_setting('antroapp.config_grupo', true), '') = 'on' then
    return;
  end if;
  select gc.grupo_id, g.nombre into v_grupo, v_nombre
  from public.grupo_clubs gc join public.grupos g on g.id = gc.grupo_id
  where gc.club_id = p_club;
  if v_grupo is null then
    return;
  end if;
  -- Candado del antro en esta clave (el mismo que toma _config_aplicar_club
  -- antes de volver a revisar si el antro es propio): un cambio del grupo
  -- que llega al mismo tiempo espera a que este termine y ya lo ve propio.
  perform pg_advisory_xact_lock(hashtextextended('config_club|' || p_club::text || '|' || p_clave, 0));
  -- Bloqueado por el grupo: solo el admin (o un proceso sin sesión, como
  -- las herramientas de dev) lo cambia en el antro.
  if exists (select 1 from public.grupo_config g where g.grupo_id = v_grupo and g.clave = p_clave and g.bloqueado)
     and auth.uid() is not null
     and not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Esto lo define el grupo «%» para todos sus antros. Pídele al dueño del grupo que lo cambie.', v_nombre
      using errcode = 'P0001';
  end if;
  insert into public.club_config_propia (club_id, clave, por)
  values (p_club, p_clave, v_yo)
  on conflict (club_id, clave) do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 and exists (select 1 from public.grupo_config g where g.grupo_id = v_grupo and g.clave = p_clave) then
    insert into public.grupo_config_cambios (grupo_id, club_id, clave, accion, hecho_por)
    values (v_grupo, p_club, p_clave, 'club_sobrescribe', v_yo);
  end if;
end;
$$;
revoke all on function public._config_marcar_propia(uuid, text) from public, anon, authenticated;

create or replace function public._trg_config_propia_regla()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._config_marcar_propia(new.club_id, 'regla_comision');
  return new;
end;
$$;

create or replace function public._trg_config_propia_visibilidad()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.nivel_visibilidad is not distinct from old.nivel_visibilidad then
      return new;
    end if;
  end if;
  perform public._config_marcar_propia(new.club_id, 'visibilidad_rp');
  return new;
end;
$$;

create or replace function public._trg_config_propia_permisos()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Solo las casillas por rol son configuración del grupo.
  if new.rol is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.permitido is not distinct from old.permitido and new.rol is not distinct from old.rol
       and new.permiso is not distinct from old.permiso then
      return new;
    end if;
  end if;
  perform public._config_marcar_propia(new.club_id, 'caja_permisos');
  return new;
end;
$$;

create or replace function public._trg_config_propia_tarifas()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Al borrar el antro (cascada), el antro ya no existe: nada que marcar.
    if exists (select 1 from public.clubs c where c.id = old.club_id) then
      perform public._config_marcar_propia(old.club_id, 'modo_pago');
    end if;
    return old;
  end if;
  perform public._config_marcar_propia(new.club_id, 'modo_pago');
  return new;
end;
$$;

create or replace function public._trg_config_propia_clubs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Ifs separados (en plpgsql un "and" evalúa las dos partes).
  if new.pago_rp_modo is distinct from old.pago_rp_modo then
    perform public._config_marcar_propia(new.id, 'modo_pago');
  end if;
  if new.cover_modo is distinct from old.cover_modo or new.cover_monto is distinct from old.cover_monto then
    perform public._config_marcar_propia(new.id, 'cover');
  end if;
  if new.tolerancia_hora is distinct from old.tolerancia_hora then
    perform public._config_marcar_propia(new.id, 'tolerancia');
  end if;
  return new;
end;
$$;

-- Al entrar a un grupo por fuera del alta (el admin, directo en la tabla), el
-- antro conserva lo suyo: todo queda «propio». Al salir, se borran sus marcas.
create or replace function public._trg_config_grupo_clubs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.club_config_propia where club_id = old.club_id;
    return old;
  end if;
  if coalesce(current_setting('antroapp.config_grupo', true), '') = 'on' then
    return new;
  end if;
  insert into public.club_config_propia (club_id, clave, por)
  select new.club_id, k, (select pr.id from public.profiles pr where pr.id = auth.uid())
  from unnest(array['regla_comision', 'visibilidad_rp', 'modo_pago', 'caja_permisos', 'cover', 'tolerancia']) k
  on conflict (club_id, clave) do nothing;
  return new;
end;
$$;

revoke all on function public._trg_config_propia_regla() from public, anon, authenticated;
revoke all on function public._trg_config_propia_visibilidad() from public, anon, authenticated;
revoke all on function public._trg_config_propia_permisos() from public, anon, authenticated;
revoke all on function public._trg_config_propia_tarifas() from public, anon, authenticated;
revoke all on function public._trg_config_propia_clubs() from public, anon, authenticated;
revoke all on function public._trg_config_grupo_clubs() from public, anon, authenticated;

create trigger reglas_comision_config_grupo before insert on public.reglas_comision
  for each row execute function public._trg_config_propia_regla();
create trigger club_config_rp_config_grupo before insert or update on public.club_config_rp
  for each row execute function public._trg_config_propia_visibilidad();
create trigger caja_permisos_config_grupo before insert or update on public.caja_permisos
  for each row execute function public._trg_config_propia_permisos();
create trigger club_dia_tarifas_config_grupo before insert or update or delete on public.club_dia_tarifas
  for each row execute function public._trg_config_propia_tarifas();
create trigger clubs_config_grupo before update of pago_rp_modo, cover_modo, cover_monto, tolerancia_hora on public.clubs
  for each row execute function public._trg_config_propia_clubs();
create trigger grupo_clubs_config_grupo after insert or delete on public.grupo_clubs
  for each row execute function public._trg_config_grupo_clubs();

-- Antros que ya estaban en un grupo: conservan lo suyo (todo «propio»).
insert into public.club_config_propia (club_id, clave)
select gc.club_id, k
from public.grupo_clubs gc
cross join unnest(array['regla_comision', 'visibilidad_rp', 'modo_pago', 'caja_permisos', 'cover', 'tolerancia']) k
on conflict (club_id, clave) do nothing;

-- ----------------------------------------------------------------------------
-- 6. Funciones públicas
-- ----------------------------------------------------------------------------

-- Grupos que puede configurar quien llama (admin: todos).
create or replace function public.grupo_config_mis_grupos()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'nombre', g.nombre,
           'antros', (select count(*) from public.grupo_clubs gc where gc.grupo_id = g.id))
         order by g.nombre), '[]'::jsonb)
  from public.grupos g
  where public.grupo_puede_editar(g.id);
$$;
revoke all on function public.grupo_config_mis_grupos() from public, anon;
grant execute on function public.grupo_config_mis_grupos() to authenticated;

-- Todo lo del grupo para su pantalla: valores, antros con el origen de cada
-- clave y la bitácora. Solo el dueño del grupo y el admin.
create or replace function public.grupo_config_actual(p_grupo uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_nombre text;
begin
  if not coalesce(public.grupo_puede_editar(p_grupo), false) then
    raise exception 'Solo el dueño del grupo o el admin ven la configuración del grupo.' using errcode = 'P0001';
  end if;
  select g.nombre into v_nombre from public.grupos g where g.id = p_grupo;
  if v_nombre is null then
    raise exception 'El grupo no existe.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'grupo', jsonb_build_object('id', p_grupo, 'nombre', v_nombre),
    'siguiente_lunes', public.lunes_de((now() at time zone 'America/Mexico_City' - interval '8 hours')::date) + 7,
    'claves', (select coalesce(jsonb_object_agg(c.clave, jsonb_build_object(
                 'valor', c.valor, 'bloqueado', c.bloqueado, 'actualizado_en', c.actualizado_en,
                 'quien', (select pr.nombre from public.profiles pr where pr.id = c.actualizado_por))), '{}'::jsonb)
               from public.grupo_config c where c.grupo_id = p_grupo),
    'antros', (select coalesce(jsonb_agg(jsonb_build_object(
                 'club_id', cl.id, 'nombre', cl.nombre, 'ciudad', cl.ciudad,
                 'origen', (select jsonb_object_agg(k, case
                              when exists (select 1 from public.club_config_propia p
                                           where p.club_id = cl.id and p.clave = k) then 'propio'
                              when exists (select 1 from public.grupo_config c
                                           where c.grupo_id = p_grupo and c.clave = k) then 'grupo'
                              else 'sin_valor' end)
                            from unnest(array['regla_comision', 'visibilidad_rp', 'modo_pago',
                                              'caja_permisos', 'cover', 'tolerancia']) k))
                 order by cl.ciudad nulls last, cl.nombre), '[]'::jsonb)
               from public.grupo_clubs gc join public.clubs cl on cl.id = gc.club_id
               where gc.grupo_id = p_grupo),
    'historial', (select coalesce(jsonb_agg(h order by h.hecho_en desc), '[]'::jsonb) from (
                    select x.hecho_en, x.clave, x.accion, x.antes, x.despues, x.bloqueado, x.vigente_desde, x.antros,
                           (select cl.nombre from public.clubs cl where cl.id = x.club_id) as antro,
                           (select pr.nombre from public.profiles pr where pr.id = x.hecho_por) as quien
                    from public.grupo_config_cambios x
                    where x.grupo_id = p_grupo
                    order by x.hecho_en desc
                    limit 50) h));
end;
$$;
revoke all on function public.grupo_config_actual(uuid) from public, anon;
grant execute on function public.grupo_config_actual(uuid) to authenticated;

-- El grupo define (o cambia) un valor y lo aplica a sus antros que lo
-- siguen. Con p_bloqueado, además lo aplica a TODOS (también a los que lo
-- tenían propio) y ningún antro lo puede cambiar.
create or replace function public.grupo_config_cambiar(
  p_grupo uuid, p_clave text, p_valor jsonb, p_bloqueado boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_yo      uuid := auth.uid();
  v_valor   jsonb;
  v_antes   jsonb;
  v_club    uuid;
  v_aplic   int := 0;
  v_siguen  int := 0;
  v_propios int := 0;
  v_desde   date;
  v_cambio  boolean;
begin
  if not coalesce(public.grupo_puede_editar(p_grupo), false) then
    raise exception 'Solo el dueño del grupo o el admin cambian la configuración del grupo.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.grupos g where g.id = p_grupo) then
    raise exception 'El grupo no existe.' using errcode = 'P0001';
  end if;
  if not coalesce(p_clave in ('regla_comision', 'visibilidad_rp', 'modo_pago', 'caja_permisos', 'cover', 'tolerancia'), false) then
    raise exception 'Configuración desconocida.' using errcode = 'P0001';
  end if;
  v_valor := public._config_normalizar(p_clave, p_valor);

  perform pg_advisory_xact_lock(hashtextextended('grupo_config|' || p_grupo::text, 0));
  select c.valor into v_antes from public.grupo_config c where c.grupo_id = p_grupo and c.clave = p_clave;

  insert into public.grupo_config (grupo_id, clave, valor, bloqueado, actualizado_por, actualizado_en)
  values (p_grupo, p_clave, v_valor, coalesce(p_bloqueado, false), v_yo, now())
  on conflict (grupo_id, clave) do update set valor = excluded.valor, bloqueado = excluded.bloqueado,
    actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;

  if coalesce(p_bloqueado, false) then
    delete from public.club_config_propia p
    using public.grupo_clubs gc
    where gc.grupo_id = p_grupo and p.club_id = gc.club_id and p.clave = p_clave;
  end if;

  -- _config_aplicar_club vuelve a revisar «propio» con el candado del antro
  -- tomado: si el gerente o el dueño lo cambió en ese mismo momento, su
  -- cambio gana y aquí se cuenta como propio (antes se perdía en silencio).
  -- Con bloqueo se aplica a todos (p_forzar).
  for v_club in
    select gc.club_id from public.grupo_clubs gc where gc.grupo_id = p_grupo order by gc.club_id
  loop
    if not coalesce(p_bloqueado, false)
       and exists (select 1 from public.club_config_propia p where p.club_id = v_club and p.clave = p_clave) then
      v_propios := v_propios + 1;
      continue;
    end if;
    v_cambio := public._config_aplicar_club(v_club, p_clave, v_valor, v_yo, null, coalesce(p_bloqueado, false));
    if not coalesce(p_bloqueado, false)
       and exists (select 1 from public.club_config_propia p where p.club_id = v_club and p.clave = p_clave) then
      v_propios := v_propios + 1;
      continue;
    end if;
    v_siguen := v_siguen + 1;
    if v_cambio then
      v_aplic := v_aplic + 1;
    end if;
    if p_clave = 'regla_comision' and v_desde is null then
      v_desde := public.lunes_de(public.club_fecha_operacion(v_club, now())) + 7;
    end if;
  end loop;

  insert into public.grupo_config_cambios (grupo_id, clave, accion, antes, despues, bloqueado, vigente_desde, antros, hecho_por)
  values (p_grupo, p_clave, 'grupo_define', v_antes, v_valor, coalesce(p_bloqueado, false), v_desde, v_siguen,
          (select pr.id from public.profiles pr where pr.id = v_yo));

  return jsonb_build_object('siguen', v_siguen, 'cambiaron', v_aplic, 'propios', v_propios,
                            'vigente_desde', v_desde, 'valor', v_valor);
end;
$$;
revoke all on function public.grupo_config_cambiar(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.grupo_config_cambiar(uuid, text, jsonb, boolean) to authenticated;

-- El grupo deja de definir una clave: los antros CONSERVAN lo que tienen
-- (nada cambia en ellos) y cada uno vuelve a decidir lo suyo.
create or replace function public.grupo_config_quitar(p_grupo uuid, p_clave text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_antes jsonb;
begin
  if not coalesce(public.grupo_puede_editar(p_grupo), false) then
    raise exception 'Solo el dueño del grupo o el admin cambian la configuración del grupo.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('grupo_config|' || p_grupo::text, 0));
  delete from public.grupo_config c where c.grupo_id = p_grupo and c.clave = p_clave
  returning c.valor into v_antes;
  if v_antes is null then
    return;
  end if;
  insert into public.grupo_config_cambios (grupo_id, clave, accion, antes, hecho_por)
  values (p_grupo, p_clave, 'grupo_quita', v_antes, (select pr.id from public.profiles pr where pr.id = auth.uid()));
end;
$$;
revoke all on function public.grupo_config_quitar(uuid, text) from public, anon;
grant execute on function public.grupo_config_quitar(uuid, text) to authenticated;

-- Quién decide, en UN antro, si sigue al grupo en una clave: el admin, el
-- dueño del antro, el dueño de su grupo y, solo para la regla y lo que ven
-- los RPs (lo que ya edita hoy), el gerente del antro.
create or replace function public._club_config_puede(p_club uuid, p_clave text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.uid() is not null and public.current_role_name() = 'admin', false)
      or coalesce(public.club_es_dueno(p_club), false)
      or coalesce(public.es_dueno_de_grupo((select gc.grupo_id from public.grupo_clubs gc where gc.club_id = p_club)), false)
      or coalesce(p_clave in ('regla_comision', 'visibilidad_rp') and public.es_gerente_o_dueno(p_club), false);
$$;
revoke all on function public._club_config_puede(uuid, text) from public, anon, authenticated;

-- «Volver al del grupo»: el antro deja de sobrescribir y toma el valor del
-- grupo (la regla, desde su lunes siguiente).
create or replace function public.club_config_heredar(p_club uuid, p_clave text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grupo uuid;
  v_valor jsonb;
  v_antes jsonb;
  v_desde date;
  v_yo    uuid := (select pr.id from public.profiles pr where pr.id = auth.uid());
begin
  if not coalesce(public._club_config_puede(p_club, p_clave), false) then
    raise exception 'No puedes cambiar de dónde sale esta configuración en este antro.' using errcode = 'P0001';
  end if;
  select gc.grupo_id into v_grupo from public.grupo_clubs gc where gc.club_id = p_club;
  if v_grupo is null then
    raise exception 'Este antro no está en un grupo.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('grupo_config|' || v_grupo::text, 0));
  select c.valor into v_valor from public.grupo_config c where c.grupo_id = v_grupo and c.clave = p_clave;
  if v_valor is null then
    raise exception 'El grupo no tiene un valor para esto.' using errcode = 'P0001';
  end if;
  v_antes := public._config_valor_club(p_club, p_clave);
  delete from public.club_config_propia where club_id = p_club and clave = p_clave;
  -- Forzado: el antro decidió seguir al grupo (borra su marca de propio).
  perform public._config_aplicar_club(p_club, p_clave, v_valor, v_yo, null, true);
  if p_clave = 'regla_comision' then
    v_desde := public.lunes_de(public.club_fecha_operacion(p_club, now())) + 7;
  end if;
  insert into public.grupo_config_cambios (grupo_id, club_id, clave, accion, antes, despues, vigente_desde, hecho_por)
  values (v_grupo, p_club, p_clave, 'club_hereda', v_antes, v_valor, v_desde, v_yo);
  return jsonb_build_object('vigente_desde', v_desde, 'valor', v_valor);
end;
$$;
revoke all on function public.club_config_heredar(uuid, text) from public, anon;
grant execute on function public.club_config_heredar(uuid, text) to authenticated;

-- «Usar el valor propio» sin cambiarlo: el antro deja de seguir al grupo en
-- esa clave y se queda con lo que tiene hoy.
create or replace function public.club_config_sobrescribir(p_club uuid, p_clave text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grupo uuid;
begin
  if not coalesce(public._club_config_puede(p_club, p_clave), false) then
    raise exception 'No puedes cambiar de dónde sale esta configuración en este antro.' using errcode = 'P0001';
  end if;
  if not coalesce(p_clave in ('regla_comision', 'visibilidad_rp', 'modo_pago', 'caja_permisos', 'cover', 'tolerancia'), false) then
    raise exception 'Configuración desconocida.' using errcode = 'P0001';
  end if;
  select gc.grupo_id into v_grupo from public.grupo_clubs gc where gc.club_id = p_club;
  if v_grupo is null then
    raise exception 'Este antro no está en un grupo.' using errcode = 'P0001';
  end if;
  -- Revisa el bloqueo y deja la marca (y la bitácora) igual que un cambio.
  perform set_config('antroapp.config_grupo', 'off', true);
  perform public._config_marcar_propia(p_club, p_clave);
end;
$$;
revoke all on function public.club_config_sobrescribir(uuid, text) from public, anon;
grant execute on function public.club_config_sobrescribir(uuid, text) to authenticated;

-- Configuración efectiva de un antro y de dónde sale cada valor, para su
-- pantalla. Leen el admin, el dueño y el gerente del antro y el dueño de su
-- grupo (el staff y el RP no: ahí van sueldos).
create or replace function public.club_config_efectiva(p_club uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_grupo  uuid;
  v_nombre text;
begin
  if not coalesce(public.es_gerente_o_dueno(p_club) or public.club_es_dueno_grupo(p_club), false) then
    raise exception 'Solo el dueño, el gerente o el dueño del grupo ven esta configuración.' using errcode = 'P0001';
  end if;
  select gc.grupo_id, g.nombre into v_grupo, v_nombre
  from public.grupo_clubs gc join public.grupos g on g.id = gc.grupo_id where gc.club_id = p_club;
  return jsonb_build_object(
    'grupo', case when v_grupo is null then null else jsonb_build_object('id', v_grupo, 'nombre', v_nombre) end,
    'puede_editar_grupo', case when v_grupo is null then false else coalesce(public.grupo_puede_editar(v_grupo), false) end,
    'claves', (select jsonb_object_agg(k, jsonb_build_object(
                 'origen', case
                   when v_grupo is null then 'sin_grupo'
                   when exists (select 1 from public.club_config_propia p where p.club_id = p_club and p.clave = k) then 'propio'
                   when c.valor is not null then 'grupo'
                   else 'sin_valor' end,
                 'bloqueado', coalesce(c.bloqueado, false),
                 'valor', public._config_valor_club(p_club, k),
                 'valor_grupo', c.valor,
                 'puede_cambiar', v_grupo is not null and coalesce(public._club_config_puede(p_club, k), false)))
               from unnest(array['regla_comision', 'visibilidad_rp', 'modo_pago', 'caja_permisos', 'cover', 'tolerancia']) k
               left join public.grupo_config c on c.grupo_id = v_grupo and c.clave = k));
end;
$$;
revoke all on function public.club_config_efectiva(uuid) from public, anon;
grant execute on function public.club_config_efectiva(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. Alta y clon dentro de un grupo: admin_alta_club envuelve la versión del
--    11 (que se conserva intacta con otro nombre y sin EXECUTE para nadie
--    con sesión) y al final aplica los valores del grupo.
--      p.grupo_config = 'heredar' (por defecto): el antro sigue al grupo en
--        todo; lo que el grupo ya define reemplaza lo del alta (la regla,
--        desde el lunes de la semana del alta: el antro es nuevo).
--      p.grupo_config = 'propio': se queda con lo del alta en todo, MENOS en
--        lo que el grupo bloqueó (eso vale para todos sus antros).
-- ----------------------------------------------------------------------------
alter function public.admin_alta_club(jsonb) rename to _admin_alta_club_base;
revoke all on function public._admin_alta_club_base(jsonb) from public, anon, authenticated;
grant execute on function public._admin_alta_club_base(jsonb) to service_role;

create function public.admin_alta_club(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_yo     uuid := auth.uid();
  v_pref   text := coalesce(nullif(p ->> 'grupo_config', ''), 'heredar');
  v_res    jsonb;
  v_club   uuid;
  v_grupo  uuid;
  v_desde  date;
  v_g      record;
  v_claves text[] := '{}';
  v_info   jsonb;
  v_tenia_regla boolean;
begin
  if v_yo is null or public.current_role_name() is distinct from 'admin' then
    raise exception 'Solo el admin da de alta antros.' using errcode = 'P0001';
  end if;
  if not coalesce(v_pref in ('heredar', 'propio'), false) then
    raise exception 'Elige si el antro usa la configuración del grupo.' using errcode = 'P0001';
  end if;

  -- Lo que escribe el alta no cuenta como «propio»: eso se decide abajo.
  perform set_config('antroapp.config_grupo', 'on', true);
  v_res := public._admin_alta_club_base(p);
  perform set_config('antroapp.config_grupo', 'off', true);

  v_club := (v_res ->> 'club_id')::uuid;
  v_grupo := nullif(v_res ->> 'grupo_id', '')::uuid;
  if v_grupo is null then
    return v_res;
  end if;

  -- Lo del grupo se aplica: todo con «heredar»; con «propio», solo lo que
  -- el grupo BLOQUEÓ (eso vale para todos sus antros).
  v_desde := public.lunes_de(public.club_fecha_operacion(v_club, now()));
  v_tenia_regla := exists (select 1 from public.reglas_comision r where r.club_id = v_club);
  -- Por reserva hace falta una regla: si el grupo pasa el antro a «por
  -- reserva» y ni el alta ni el grupo traen regla, se dice aquí (con el
  -- mensaje del alta) antes de que _config_aplicar_club lo rechace.
  if not v_tenia_regla
     and (select c.pago_rp_modo from public.clubs c where c.id = v_club) is distinct from 'reserva'
     and exists (select 1 from public.grupo_config c
                 where c.grupo_id = v_grupo and c.clave = 'modo_pago' and c.valor ->> 'modo' = 'reserva'
                   and (v_pref = 'heredar' or c.bloqueado))
     and not exists (select 1 from public.grupo_config c where c.grupo_id = v_grupo and c.clave = 'regla_comision') then
    raise exception 'Con la configuración del grupo el antro paga por reserva, pero no hay regla de comisión: elige «Usar lo de este alta» o define la regla en el grupo.'
      using errcode = 'P0001';
  end if;
  for v_g in
    select c.clave, c.valor from public.grupo_config c
    where c.grupo_id = v_grupo and (v_pref = 'heredar' or c.bloqueado)
    order by c.clave
  loop
    perform public._config_aplicar_club(v_club, v_g.clave, v_g.valor, v_yo, v_desde, true);
    v_claves := v_claves || v_g.clave;
  end loop;
  -- Si el modo por reserva del grupo le puso la regla del grupo (el antro no
  -- tenía), esa regla también sale del grupo: no se marca propia.
  if not v_tenia_regla and not ('regla_comision' = any (v_claves))
     and exists (select 1 from public.reglas_comision r where r.club_id = v_club) then
    v_claves := v_claves || 'regla_comision'::text;
  end if;
  if v_pref = 'propio' then
    insert into public.club_config_propia (club_id, clave, por)
    select v_club, k, v_yo
    from unnest(array['regla_comision', 'visibilidad_rp', 'modo_pago', 'caja_permisos', 'cover', 'tolerancia']) k
    where not (k = any (v_claves))
    on conflict (club_id, clave) do nothing;
  end if;
  -- Misma regla que el alta: por reserva hace falta la regla de comisión.
  if (p -> 'rp') is not null and jsonb_typeof(p -> 'rp') = 'object'
     and (select c.pago_rp_modo from public.clubs c where c.id = v_club) = 'reserva'
     and not exists (select 1 from public.reglas_comision r where r.club_id = v_club) then
    raise exception 'Con la configuración del grupo el antro paga por reserva, pero no hay regla de comisión: elige «Usar lo de este alta» o define la regla en el grupo.'
      using errcode = 'P0001';
  end if;
  insert into public.grupo_config_cambios (grupo_id, club_id, clave, accion, despues, vigente_desde, hecho_por)
  values (v_grupo, v_club, 'todas', case when v_pref = 'heredar' then 'alta_hereda' else 'alta_propia' end, to_jsonb(v_claves),
          case when 'regla_comision' = any (v_claves) then v_desde end, v_yo);

  v_info := jsonb_build_object('modo', v_pref, 'del_grupo', to_jsonb(v_claves));
  update public.club_altas set resumen = resumen || jsonb_build_object('grupo_config', v_info)
  where club_id = v_club and alta_id = (p ->> 'alta_id')::uuid;
  return v_res || jsonb_build_object('grupo_config', v_info);
end;
$$;

revoke all on function public.admin_alta_club(jsonb) from public, anon;
grant execute on function public.admin_alta_club(jsonb) to authenticated, service_role;  -- adentro exige admin
