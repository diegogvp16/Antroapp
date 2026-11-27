-- Rollback de sql/post-junta-3/02-ip-cliente.sql: reservations_antiabuso_anon
-- vuelve EXACTAMENTE a la del 66 (primer valor de x-forwarded-for) y se borra
-- ip_cliente(). Si el 50 de post-junta-3 ya está aplicado, primero su rollback
-- (usa ip_cliente()).
begin;

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
  v_ip := nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', v_headers ->> 'x-real-ip', ''), ',', 1)), '');
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

drop function if exists public.ip_cliente();

commit;
