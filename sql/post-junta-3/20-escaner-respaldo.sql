-- ============================================================================
-- AntroApp — Escáner de respaldo (noche 4, bloque 2): código a mano y
-- entradas sin señal, detrás de la bandera `escaner_respaldo`.
-- Fecha: 2026-11-27. Rollback: sql/post-junta-3/20-escaner-respaldo-rollback.sql
-- Pruebas (dev): node scripts/dev/probar-escaner-respaldo-base.mjs
--                node scripts/dev/probar-escaner-respaldo.mjs [url]
-- Requiere: sql/post-junta-3/00-funciones-club.sql (funcion_activa) y las
-- funciones de puerta (sql/post-junta-2/65-concurrencia-puerta-cobro.sql).
--
-- No cambia ninguna función existente. Las tres funciones de puerta nuevas
-- terminan SIEMPRE en puerta_escanear / puerta_confirmar_entrada (las mismas
-- que usa el escáner con cámara): mismo permiso 'puerta', misma noche
-- operativa del antro, mismo candado contra dos confirmaciones a la vez.
--
--   puerta_copia_noche(club)            copia mínima de las reservas de esta
--                                       noche para validar sin señal: sin
--                                       teléfono, sin consumo y SIN el código
--                                       QR (solo su huella SHA-256 y los 6
--                                       últimos caracteres). A quien ya
--                                       entró no se le manda el nombre. Si
--                                       hay más de 3,000 lo dice (truncada).
--   puerta_escanear_codigo(club, cod    el código corto del boleto (6 a 12
--     [, reserva])                      caracteres del final del QR). Solo
--                                       reservas de ESTA noche y de ESTE
--                                       antro. Si 2 a 5 coinciden devuelve
--                                       las opciones con el nombre recortado
--                                       ("Ana G.") para elegir viendo la
--                                       identificación; con la reserva
--                                       elegida (que también tiene que
--                                       coincidir con el código) sigue.
--                                       Luego puerta_escanear.
--   puerta_entrada_diferida(club, id,   envía una entrada que se confirmó sin
--     clave, escaneado_en)              señal: puerta_escanear +
--                                       puerta_confirmar_entrada en una sola
--                                       transacción. Reintento con la misma
--                                       clave y la misma reserva =
--                                       "ya_enviada" (aunque la bandera se
--                                       haya apagado mientras); si otra
--                                       persona u otro teléfono ya la
--                                       registró = "ya_entro" (no es error).
--                                       La hora del teléfono solo se anota en
--                                       caja_eventos (índice parcial propio
--                                       para buscar la clave).
--   boleto_muestra_codigo(qr)           el boleto (/r/[codigo], sin sesión)
--                                       muestra el código corto solo si el
--                                       antro tiene la bandera encendida.
--
-- Todas: autorización primero, luego la bandera ('Esta función no está
-- activa para este antro.'). Errores para la persona con P0001.
-- ============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1) Copia de la noche para la puerta sin señal
-- ---------------------------------------------------------------------------
create function public.puerta_copia_noche(p_club_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_noche date;
  v_zona text;
  v_total int;
  v_reservas jsonb;
begin
  if not coalesce(public.caja_tiene_permiso(p_club_id, 'puerta'), false) then
    raise exception 'No tienes permiso para la puerta de este antro.' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'escaner_respaldo'), false) then
    raise exception 'Esta función no está activa para este antro.' using errcode = 'P0001';
  end if;

  select coalesce(c.zona_horaria, 'America/Mexico_City') into v_zona from public.clubs c where c.id = p_club_id;
  v_noche := public.club_fecha_operacion(p_club_id, now());

  select count(*) into v_total
  from public.reservations r
  where r.club_id = p_club_id and r.fecha = v_noche and r.qr_code is not null;

  -- Tope de 3,000 (unos 600 KB en el teléfono). Si una noche lo pasa, van
  -- primero las que faltan por entrar y la copia dice "truncada".
  select coalesce(jsonb_agg(x.fila order by x.orden, x.id), '[]'::jsonb) into v_reservas
  from (
    select r.id,
           (coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end) is not distinct from 'entro') as orden,
           jsonb_build_object(
             'reservation_id', r.id,
             'qr_sha256', encode(sha256(convert_to(r.qr_code, 'UTF8')), 'hex'),
             'sufijo', upper(right(r.qr_code, 6)),
             'entro', coalesce(coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end) = 'entro', false),
             'entrada_en', r.entrada_en,
             -- Nombre y RP solo de quien falta por entrar.
             'cliente_nombre', case when coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end)
                                         is distinct from 'entro' then r.cliente_nombre end,
             'personas', r.personas,
             'source', r.source,
             'rp_nombre', case when coalesce(r.puerta_estado, case when r.status = 'usada' then 'entro' end)
                                    is distinct from 'entro'
                               then (select p.nombre from public.profiles p where p.id = r.rp_id) end
           ) as fila
    from public.reservations r
    where r.club_id = p_club_id
      and r.fecha = v_noche
      and r.qr_code is not null
    order by 2, r.id
    limit 3000
  ) x;

  return jsonb_build_object(
    'club_id', p_club_id,
    'noche', v_noche,
    'generada_en', now(),
    -- La copia no sirve después de las 08:00 del día siguiente (hora del antro).
    'vence_en', ((v_noche + 1)::timestamp + interval '8 hours') at time zone v_zona,
    'total', v_total,
    'truncada', v_total > 3000,
    'reservas', v_reservas);
end;
$$;
revoke all on function public.puerta_copia_noche(uuid) from public, anon, authenticated;
grant execute on function public.puerta_copia_noche(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Código corto del boleto (cámara que no lee, QR roto)
-- ---------------------------------------------------------------------------
create function public.puerta_escanear_codigo(p_club_id uuid, p_codigo text, p_reservation_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_codigo text;
  v_noche date;
  v_coinciden jsonb;
  v_n int;
  v_qr text;
begin
  if not coalesce(public.caja_tiene_permiso(p_club_id, 'puerta'), false) then
    raise exception 'No tienes permiso para la puerta de este antro.' using errcode = 'P0001';
  end if;
  if not coalesce(public.funcion_activa(p_club_id, 'escaner_respaldo'), false) then
    raise exception 'Esta función no está activa para este antro.' using errcode = 'P0001';
  end if;

  -- Se aceptan espacios y guiones (el boleto lo muestra "AB1 2C3").
  v_codigo := lower(regexp_replace(coalesce(p_codigo, ''), '[\s-]', '', 'g'));
  if v_codigo !~ '^[0-9a-f]*$' then
    raise exception 'El código solo lleva números y letras de la A a la F.' using errcode = 'P0001';
  end if;
  if length(v_codigo) < 6 then
    raise exception 'Escribe los 6 caracteres del código del boleto.' using errcode = 'P0001';
  end if;
  if length(v_codigo) > 12 then
    raise exception 'El código es más largo que el del boleto. Escribe solo el código o escanea el QR.' using errcode = 'P0001';
  end if;

  -- Solo reservas de esta noche y de este antro, a lo más 6 (para saber si
  -- son más de 5).
  v_noche := public.club_fecha_operacion(p_club_id, now());
  select jsonb_agg(q.fila), count(*) into v_coinciden, v_n
  from (
    select jsonb_build_object(
             'reservation_id', r.id,
             'qr', r.qr_code,
             -- Nombre recortado: el de pila y la inicial del siguiente.
             'nombre', split_part(btrim(r.cliente_nombre), ' ', 1)
                       || coalesce(' ' || nullif(left(split_part(btrim(r.cliente_nombre), ' ', 2), 1), '') || '.', ''),
             'personas', r.personas) as fila
    from public.reservations r
    where r.club_id = p_club_id
      and r.fecha = v_noche
      and r.qr_code is not null
      and lower(right(r.qr_code, length(v_codigo))) = v_codigo
    order by r.created_at, r.id
    limit 6
  ) q;

  if coalesce(v_n, 0) = 0 then
    raise exception 'No hay ninguna reserva de esta noche con ese código.' using errcode = 'P0001';
  end if;

  if p_reservation_id is not null then
    -- La elegida de la lista: tiene que ser una de las que coinciden.
    select e ->> 'qr' into v_qr from jsonb_array_elements(v_coinciden) e
    where (e ->> 'reservation_id')::uuid = p_reservation_id;
    if v_qr is null then
      raise exception 'No hay ninguna reserva de esta noche con ese código.' using errcode = 'P0001';
    end if;
  elsif v_n = 1 then
    v_qr := v_coinciden -> 0 ->> 'qr';
  elsif v_n <= 5 then
    -- Varias: se devuelven para elegir (sin QR), nunca se escanea a ciegas.
    return jsonb_build_object(
      'ambiguo', true,
      'opciones', (select jsonb_agg(e - 'qr') from jsonb_array_elements(v_coinciden) e));
  else
    raise exception 'Hay más de una reserva de esta noche con ese código. Escribe más caracteres o escanea el QR.' using errcode = 'P0001';
  end if;

  -- El mismo camino que la cámara.
  return public.puerta_escanear(v_qr);
end;
$$;
revoke all on function public.puerta_escanear_codigo(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.puerta_escanear_codigo(uuid, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Entrada confirmada sin señal, enviada al volver la señal
-- ---------------------------------------------------------------------------
-- Buscar la clave de un envío sin recorrer todos los eventos del antro.
create index caja_eventos_puerta_clave on public.caja_eventos (club_id, (detalle ->> 'clave'))
  where tipo = 'puerta_entrada_diferida';

create function public.puerta_entrada_diferida(p_club_id uuid, p_reservation_id uuid, p_clave uuid,
                                               p_escaneado_en timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_qr text;
  v_res public.reservations%rowtype;
  v_zona text;
  v_previa text;
begin
  if not coalesce(public.caja_tiene_permiso(p_club_id, 'puerta'), false) then
    raise exception 'No tienes permiso para la puerta de este antro.' using errcode = 'P0001';
  end if;
  if p_reservation_id is null or p_clave is null then
    raise exception 'Faltan datos de la entrada.' using errcode = 'P0001';
  end if;
  -- hora_local: la hora de la entrada en la zona del antro, para la pantalla.
  select coalesce(c.zona_horaria, 'America/Mexico_City') into v_zona from public.clubs c where c.id = p_club_id;

  -- Reintento del mismo envío (respuesta perdida): ya quedó, no es error.
  -- Va ANTES de revisar la bandera: si la apagaron entre el envío y el
  -- reintento, lo que sí se guardó se reporta como guardado. La clave vale
  -- solo para su reserva y su antro.
  select e.detalle ->> 'reservation_id' into v_previa
  from public.caja_eventos e
  where e.club_id = p_club_id
    and e.tipo = 'puerta_entrada_diferida'
    and e.detalle ->> 'clave' = p_clave::text
    and e.hecho_por = auth.uid()
  limit 1;
  if v_previa is not null then
    if v_previa is distinct from p_reservation_id::text then
      raise exception 'Esa clave de envío ya se usó con otra reserva.' using errcode = 'P0001';
    end if;
    select * into v_res from public.reservations r where r.id = p_reservation_id and r.club_id = p_club_id;
    return jsonb_build_object('resultado', 'ya_enviada', 'entrada_en', v_res.entrada_en,
      'hora_local', to_char(v_res.entrada_en at time zone v_zona, 'HH24:MI'));
  end if;

  if not coalesce(public.funcion_activa(p_club_id, 'escaner_respaldo'), false) then
    raise exception 'Esta función no está activa para este antro.' using errcode = 'P0001';
  end if;

  select r.qr_code into v_qr from public.reservations r
  where r.id = p_reservation_id and r.club_id = p_club_id;
  if v_qr is null then
    raise exception 'Reserva no encontrada en tu antro' using errcode = 'P0001';
  end if;

  begin
    perform public.puerta_escanear(v_qr);
    perform public.puerta_confirmar_entrada(p_reservation_id);
  exception when raise_exception then
    -- Otra persona u otro teléfono la confirmó mientras tanto: no se
    -- registra dos veces y se dice quién (tú u otra cuenta) y a qué hora.
    if sqlerrm like 'Esta reserva ya entró%' then
      select * into v_res from public.reservations r where r.id = p_reservation_id and r.club_id = p_club_id;
      return jsonb_build_object(
        'resultado', 'ya_entro',
        'por_ti', coalesce(v_res.entrada_por = auth.uid(), false),
        'entrada_en', v_res.entrada_en,
        'hora_local', to_char(v_res.entrada_en at time zone v_zona, 'HH24:MI'),
        'mensaje', sqlerrm);
    end if;
    raise;
  end;

  select * into v_res from public.reservations r where r.id = p_reservation_id and r.club_id = p_club_id;
  perform public.caja_evento(p_club_id, null, null, 'puerta_entrada_diferida',
    jsonb_build_object('reservation_id', p_reservation_id, 'clave', p_clave,
                       'escaneado_en', p_escaneado_en, 'recibido_en', now()));
  return jsonb_build_object('resultado', 'entro', 'entrada_en', v_res.entrada_en,
    'hora_local', to_char(v_res.entrada_en at time zone v_zona, 'HH24:MI'));
end;
$$;
revoke all on function public.puerta_entrada_diferida(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.puerta_entrada_diferida(uuid, uuid, uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) ¿El boleto muestra el código corto? Solo con la bandera encendida.
--    Recibe el QR completo (quien lo tiene ya ve el boleto entero) y solo
--    contesta sí o no.
-- ---------------------------------------------------------------------------
create function public.boleto_muestra_codigo(p_qr text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select public.funcion_activa(r.club_id, 'escaner_respaldo')
       from public.reservations r
      where r.qr_code = trim(p_qr)),
    false);
$$;
revoke all on function public.boleto_muestra_codigo(text) from public, anon, authenticated;
grant execute on function public.boleto_muestra_codigo(text) to anon, authenticated, service_role;

commit;
