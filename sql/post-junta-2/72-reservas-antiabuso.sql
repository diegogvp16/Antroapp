-- ============================================================================
-- AntroApp — C3 (noche 3): reservas sin cuenta con límites y validación en la base
-- Fecha: 2026-11-25. Rollback: sql/post-junta-2/72-reservas-antiabuso-rollback.sql
-- Prueba (dev): node scripts/dev/probar-reservas-antiabuso.mjs
--
-- La reserva sin cuenta la inserta el navegador directo en Supabase con la
-- anon key (pública), así que la ruta de la app no puede ponerle límites: van
-- en la base. Hasta hoy la política reservations_insert_anonimo cuidaba la
-- forma (orgánica, pendiente, sin RP ni consumo, 1–20 personas, de hoy en
-- adelante) pero:
--   - no había límite: un script llenaba de reservas falsas la puerta de un
--     antro (la lista de staff, la caja y los reportes);
--   - no revisaba que el antro estuviera publicado: se podía reservar en un
--     borrador oculto (p. ej. un negocio que aún no autoriza su alta);
--   - no había tope de fecha ni de largo de nombre y teléfono.
--
-- Este trigger, SOLO para el rol anon (las cuentas con sesión y la service
-- role no pasan por aquí), rechaza con un mensaje claro (P0001, la app lo
-- muestra tal cual):
--   - antro no publicado (verificado y con suscripción activa);
--   - fecha a más de 60 días de la noche operativa del antro;
--   - nombre fuera de 2–80 caracteres, teléfono sin 10–15 dígitos;
--   - más de 3 reservas del mismo teléfono en el mismo antro y la misma noche;
--   - más de 20 reservas sin cuenta desde la misma IP en una hora.
-- La IP sale del encabezado x-forwarded-for que el gateway de Supabase pone en
-- request.headers (el navegador no la puede falsificar: el gateway la
-- reescribe) y se guarda como sha256, no en claro. Si no viene IP, solo
-- aplican los demás límites.
-- ============================================================================
begin;

create table if not exists public.reserva_intentos (
  id bigint generated always as identity primary key,
  ip_hash text,
  club_id uuid not null,
  telefono_hash text not null,
  fecha date not null,
  creado_en timestamptz not null default now()
);
create index if not exists reserva_intentos_ip on public.reserva_intentos (ip_hash, creado_en) where ip_hash is not null;
create index if not exists reserva_intentos_tel on public.reserva_intentos (club_id, telefono_hash, fecha);

alter table public.reserva_intentos enable row level security;
-- Sin políticas: nadie la lee ni la escribe con sesión; solo el trigger
-- (SECURITY DEFINER) y la service role.
revoke all on table public.reserva_intentos from public, anon, authenticated;
grant all on table public.reserva_intentos to service_role;

create or replace function public.reservations_antiabuso_anon()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function public.reservations_antiabuso_anon() from public, anon, authenticated;

drop trigger if exists reservations_antiabuso_anon on public.reservations;
create trigger reservations_antiabuso_anon
  before insert on public.reservations
  for each row execute function public.reservations_antiabuso_anon();

commit;
