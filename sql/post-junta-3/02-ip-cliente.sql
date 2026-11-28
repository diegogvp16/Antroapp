-- ============================================================================
-- AntroApp — La IP de los topes anti-abuso ya no la decide quien llama
-- Fecha: 2026-11-27 (noche 4). Rollback: sql/post-junta-3/02-ip-cliente-rollback.sql
-- Prueba (dev): node scripts/dev/probar-ip-cliente.mjs
-- Requiere: sql/post-junta-2/72 y 66 (reservations_antiabuso_anon).
-- Orden: va CON EL PASE 2, como paso Q10b, justo después del Q10 (el 66).
--        Verificación y rollback: docs/pase-2.md, «Q10b».
--
-- Hallazgo (revisión del bloque 5, CONFIRMADO en dev): el gateway de Supabase
-- AGREGA la IP real al final de x-forwarded-for, después de lo que mande el
-- cliente. Con "X-Forwarded-For: 1.2.3.4" la base ve "1.2.3.4,<IP real>".
-- El 72/66 tomaba el PRIMER valor: cualquiera elegía su "IP" y se saltaba el
-- tope de 20 reservas sin cuenta por IP por hora (el comentario del 72 decía
-- que el navegador no la podía falsificar: era falso). cf-connecting-ip sí
-- trae la IP real (Cloudflare lo reescribe siempre).
--
-- Arreglo: public.ip_cliente() — cf-connecting-ip; si no viene, el ÚLTIMO
-- valor de x-forwarded-for (el que puso el proxy de confianza); si no,
-- x-real-ip. Solo caracteres de IP (0-9 a-f : .) y 45 como máximo; si no,
-- NULL (sin tope por IP, como antes sin encabezados). Lo usan los topes de
-- reservas sin cuenta (este archivo) y el formulario de /para-clubes (50).
-- reservations_antiabuso_anon queda idéntica a la del 66 salvo la línea de
-- la IP. Nada de lo que va después en el pase 2 (Q11 en adelante) la redefine.
-- ============================================================================
begin;

create function public.ip_cliente()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_h   json;
  v_ip  text;
  v_xff text[];
begin
  begin
    v_h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if v_h is null then
    return null;
  end if;
  v_ip := nullif(btrim(v_h ->> 'cf-connecting-ip'), '');
  if v_ip is null then
    v_xff := string_to_array(coalesce(v_h ->> 'x-forwarded-for', ''), ',');
    if array_length(v_xff, 1) is not null then
      v_ip := nullif(btrim(v_xff[array_length(v_xff, 1)]), '');
    end if;
  end if;
  if v_ip is null then
    v_ip := nullif(btrim(v_h ->> 'x-real-ip'), '');
  end if;
  if v_ip is null or char_length(v_ip) > 45 or v_ip !~ '^[0-9A-Fa-f:.]+$' then
    return null;
  end if;
  return lower(v_ip);
end;
$$;
-- Solo para otras funciones de la base (corren como su dueño).
revoke all on function public.ip_cliente() from public, anon, authenticated;
grant execute on function public.ip_cliente() to service_role;

CREATE OR REPLACE FUNCTION public.reservations_antiabuso_anon()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  -- Sin claims (SQL Editor, scripts como postgres) current_setting devuelve
  -- '' y ''::json truena: nullif lo vuelve NULL.
  v_rol text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
  v_headers json;
  v_ip text;
  v_ip_hash text;
  v_tel text;
  v_tel_hash text;
  v_zona text;
  v_hoy date;
begin
  -- Solo el anónimo de la API. Con sesión, service role o postgres: sin cambios.
  if v_rol <> 'anon' then
    return new;
  end if;

  select c.zona_horaria into v_zona
    from public.clubs c
   where c.id = new.club_id
     and c.estado_verificacion = 'verificado'
     and c.suscripcion_activa;
  if v_zona is null then
    raise exception 'Este antro no está recibiendo reservas por ahora.' using errcode = 'P0001';
  end if;

  v_hoy := ((now() at time zone v_zona) - interval '8 hours')::date;
  if new.fecha > v_hoy + 60 then
    raise exception 'Solo se puede reservar hasta 60 días antes.' using errcode = 'P0001';
  end if;

  if new.cliente_nombre is null or char_length(btrim(new.cliente_nombre)) not between 2 and 80 then
    raise exception 'Escribe tu nombre (de 2 a 80 letras).' using errcode = 'P0001';
  end if;
  v_tel := regexp_replace(coalesce(new.cliente_telefono, ''), '\D', '', 'g');
  if char_length(v_tel) not between 10 and 15 then
    raise exception 'Escribe un teléfono de 10 dígitos.' using errcode = 'P0001';
  end if;
  v_tel_hash := encode(sha256(convert_to(right(v_tel, 10), 'UTF8')), 'hex');
  -- Candado por teléfono, antro y noche (hasta que termine la transacción):
  -- dos reservas a la vez del mismo teléfono se forman, y la segunda ya
  -- cuenta la primera. Sin esto las dos veían el mismo conteo y pasaban.
  perform pg_advisory_xact_lock(hashtextextended('reserva_tel|' || new.club_id::text || '|' || v_tel_hash || '|' || new.fecha::text, 0));

  if (select count(*) from public.reserva_intentos r
       where r.club_id = new.club_id and r.telefono_hash = v_tel_hash and r.fecha = new.fecha) >= 3 then
    raise exception 'Ya hay varias reservas con este teléfono para esa noche en este antro.' using errcode = 'P0001';
  end if;

  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  -- IP real: public.ip_cliente() (sql/post-junta-3/02). Antes se tomaba el PRIMER
  -- valor de x-forwarded-for, que lo escribe quien llama.
  v_ip := public.ip_cliente();
  if v_ip is not null then
    v_ip_hash := encode(sha256(convert_to('reserva:' || v_ip, 'UTF8')), 'hex');
    -- Igual para el tope por IP (siempre después del de teléfono: mismo orden
    -- en todas las transacciones, sin abrazos mortales).
    perform pg_advisory_xact_lock(hashtextextended('reserva_ip|' || v_ip_hash, 0));
    if (select count(*) from public.reserva_intentos r
         where r.ip_hash = v_ip_hash and r.creado_en > now() - interval '1 hour') >= 20 then
      raise exception 'Demasiadas reservas desde esta conexión. Intenta de nuevo en una hora.' using errcode = 'P0001';
    end if;
  end if;

  insert into public.reserva_intentos (ip_hash, club_id, telefono_hash, fecha)
  values (v_ip_hash, new.club_id, v_tel_hash, new.fecha);
  -- Limpieza: lo de más de 7 días ya no cuenta para ningún límite.
  delete from public.reserva_intentos where creado_en < now() - interval '7 days';

  return new;
end;
$function$
;

revoke all on function public.reservations_antiabuso_anon() from public, anon, authenticated;

commit;
