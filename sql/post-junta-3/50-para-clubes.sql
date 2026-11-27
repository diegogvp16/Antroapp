-- ============================================================================
-- AntroApp — /para-clubes: bandera de plataforma y formulario de contacto
-- (noche 4, bloque 5; corregido tras la revisión del carril)
-- Fecha: 2026-11-27. Rollback: sql/post-junta-3/50-para-clubes-rollback.sql
-- Prueba (dev): node scripts/dev/probar-para-clubes.mjs
-- Requiere: current_role_name() (ya en producción) y
--           sql/post-junta-3/02-ip-cliente.sql (public.ip_cliente()).
--           En el pase: 02 antes que 50. El rollback de 50 NO toca ip_cliente.
--
-- 1. plataforma_banderas: banderas que no son de un antro, APAGADAS:
--      'para_clubes'               la página /para-clubes y su formulario;
--      'contacto_requiere_captcha' el formulario solo se acepta por la ruta
--                                  de la app que revisa el CAPTCHA (llama con
--                                  la service role): el anónimo ya no puede
--                                  llamar directo a la función.
--    Solo el admin las cambia (plataforma_bandera_cambiar), con bitácora.
--    La app pregunta con para_clubes_activa(), que puede llamar el anónimo.
-- 2. contactos_clubes: lo que deja un antro interesado. No se manda ningún
--    correo. Nadie la toca por la API: se escribe solo con
--    para_clubes_contacto_enviar() y la lee y marca solo el admin.
-- 3. contacto_intentos: los envíos guardados de los últimos días, con la IP
--    y el correo convertidos en una huella (sha256 con una sal secreta que
--    vive en contacto_sal y no se lee por la API), para los límites:
--      - 3 por hora y 10 por día desde la misma conexión;
--      - 3 por día con el mismo correo;
--      - 60 por hora en total.
--    La casilla trampa (p_sitio_web) responde igual que un envío bueno pero
--    no guarda nada ni cuenta para ningún límite.
--    Se limpia (más de 7 días) en cada envío, al abrir la bandeja del admin y
--    en la tarea diaria (contacto_intentos_limpiar, app/api/cron/mensualidad).
-- 4. para_clubes_bitacora: quién cambió una bandera, marcó o borró un
--    contacto y cuándo. Sin datos personales (solo el id del contacto).
-- La IP: public.ip_cliente() (cf-connecting-ip; el primer valor de
-- x-forwarded-for lo pone quien llama y no sirve). Solo cuando llama la
-- service role (la ruta con CAPTCHA, /api/para-clubes/contacto) se usa la IP
-- que manda la ruta (p_ip).
-- ============================================================================
begin;

-- ---------- 1. Banderas de plataforma y bitácora ----------
create table public.plataforma_banderas (
  clave        text primary key check (clave in ('para_clubes', 'contacto_requiere_captcha')),
  activa       boolean not null default false,
  cambiado_por uuid references public.profiles (id) on delete set null,
  cambiado_en  timestamptz not null default now()
);
insert into public.plataforma_banderas (clave, activa) values ('para_clubes', false), ('contacto_requiere_captcha', false);
alter table public.plataforma_banderas enable row level security;
revoke all on public.plataforma_banderas from public, anon, authenticated;
grant all on public.plataforma_banderas to service_role;

create table public.para_clubes_bitacora (
  id          bigint generated always as identity primary key,
  accion      text not null check (accion in ('bandera', 'contacto_estado', 'contacto_borrado')),
  detalle     text not null check (char_length(detalle) <= 60),  -- 'para_clubes=true', 'atendido'… nunca datos personales
  contacto_id uuid,                                             -- sin FK: el contacto puede ya no existir
  hecho_por   uuid references public.profiles (id) on delete set null,
  hecho_en    timestamptz not null default now()
);
create index para_clubes_bitacora_hecho on public.para_clubes_bitacora (hecho_en desc);
alter table public.para_clubes_bitacora enable row level security;
revoke all on public.para_clubes_bitacora from public, anon, authenticated;
grant all on public.para_clubes_bitacora to service_role;
revoke all on sequence public.para_clubes_bitacora_id_seq from public, anon, authenticated;
grant usage, select on sequence public.para_clubes_bitacora_id_seq to service_role;

create function public.para_clubes_activa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select b.activa from public.plataforma_banderas b where b.clave = 'para_clubes'), false);
$$;
revoke all on function public.para_clubes_activa() from public, anon, authenticated;
grant execute on function public.para_clubes_activa() to anon, authenticated, service_role;

create function public.plataforma_bandera_cambiar(p_clave text, p_activa boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin puede cambiar esta configuración.' using errcode = 'P0001';
  end if;
  if p_activa is null then
    raise exception 'Indica si queda encendida o apagada.' using errcode = 'P0001';
  end if;
  update public.plataforma_banderas
     set activa = p_activa, cambiado_por = auth.uid(), cambiado_en = now()
   where clave = p_clave;
  if not found then
    raise exception 'Esa configuración no existe.' using errcode = 'P0001';
  end if;
  insert into public.para_clubes_bitacora (accion, detalle, hecho_por)
  values ('bandera', p_clave || '=' || p_activa::text, auth.uid());
  return p_activa;
end;
$$;
revoke all on function public.plataforma_bandera_cambiar(text, boolean) from public, anon, authenticated;
grant execute on function public.plataforma_bandera_cambiar(text, boolean) to authenticated, service_role;

-- Para la pantalla del admin: estado de cada bandera, quién y cuándo.
create function public.plataforma_banderas_estado()
returns table (clave text, activa boolean, cambiado_en timestamptz, cambiado_por_nombre text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin ve esta configuración.' using errcode = 'P0001';
  end if;
  return query
    select b.clave, b.activa, b.cambiado_en, p.nombre
      from public.plataforma_banderas b
      left join public.profiles p on p.id = b.cambiado_por
     order by b.clave;
end;
$$;
revoke all on function public.plataforma_banderas_estado() from public, anon, authenticated;
grant execute on function public.plataforma_banderas_estado() to authenticated, service_role;

-- ---------- 2. Contactos ----------
create table public.contactos_clubes (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null check (char_length(nombre) between 2 and 80),
  club_nombre  text not null check (char_length(club_nombre) between 2 and 80),
  ciudad       text not null check (char_length(ciudad) between 2 and 60),
  correo       text not null check (char_length(correo) between 6 and 120),
  telefono     text check (telefono ~ '^[0-9]{10,15}$'),
  mensaje      text check (char_length(mensaje) <= 1000),
  estado       text not null default 'nuevo' check (estado in ('nuevo', 'atendido', 'descartado')),
  atendido_por uuid references public.profiles (id) on delete set null,
  atendido_en  timestamptz,
  creado_en    timestamptz not null default now()
);
create index contactos_clubes_estado on public.contactos_clubes (estado, creado_en desc);
alter table public.contactos_clubes enable row level security;
-- Sin políticas: nadie la lee ni la escribe por la API (solo las funciones).
revoke all on public.contactos_clubes from public, anon, authenticated;
grant all on public.contactos_clubes to service_role;

-- ---------- 3. Límites ----------
-- Sal secreta de las huellas: sin ella, la huella de una IPv4 se revierte
-- probando todas en menos de una hora. No se lee por la API.
create table public.contacto_sal (
  id  int primary key default 1 check (id = 1),
  sal text not null check (char_length(sal) = 64)
);
insert into public.contacto_sal (sal)
values (encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'));
alter table public.contacto_sal enable row level security;
revoke all on public.contacto_sal from public, anon, authenticated;
grant all on public.contacto_sal to service_role;

create table public.contacto_intentos (
  id          bigint generated always as identity primary key,
  ip_hash     text,
  correo_hash text not null,
  creado_en   timestamptz not null default now()
);
create index contacto_intentos_ip on public.contacto_intentos (ip_hash, creado_en) where ip_hash is not null;
create index contacto_intentos_correo on public.contacto_intentos (correo_hash, creado_en);
create index contacto_intentos_creado on public.contacto_intentos (creado_en);
alter table public.contacto_intentos enable row level security;
revoke all on public.contacto_intentos from public, anon, authenticated;
grant all on public.contacto_intentos to service_role;
revoke all on sequence public.contacto_intentos_id_seq from public, anon, authenticated;
grant usage, select on sequence public.contacto_intentos_id_seq to service_role;

-- Huella de un texto con la sal secreta. Solo para las funciones de aquí.
create function public.contacto_huella(p_texto text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to((select s.sal from public.contacto_sal s where s.id = 1) || ':' || p_texto, 'UTF8')), 'hex');
$$;
revoke all on function public.contacto_huella(text) from public, anon, authenticated;
grant execute on function public.contacto_huella(text) to service_role;

-- Borra los intentos de más de 7 días. Devuelve cuántos borró.
create function public.contacto_intentos_limpiar()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.contacto_intentos where creado_en < now() - interval '7 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.contacto_intentos_limpiar() from public, anon, authenticated;
grant execute on function public.contacto_intentos_limpiar() to service_role;

-- Envío del formulario. Devuelve 'recibido' (también si cayó en la trampa,
-- para que un bot no lo distinga). Los rechazos van con P0001 y un texto que
-- la app muestra tal cual. Los avisos de límite no dicen si un correo ya se
-- había usado.
create function public.para_clubes_contacto_enviar(
  p_nombre    text,
  p_club      text,
  p_ciudad    text,
  p_correo    text,
  p_telefono  text default null,
  p_mensaje   text default null,
  p_sitio_web text default null,
  p_ip        text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Sin claims (scripts como postgres) current_setting devuelve '' y
  -- ''::json truena: nullif lo vuelve NULL.
  v_rol         text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
  v_ip          text;
  v_ip_hash     text;
  v_nombre      text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  v_club        text := btrim(regexp_replace(coalesce(p_club, ''), '\s+', ' ', 'g'));
  v_ciudad      text := btrim(regexp_replace(coalesce(p_ciudad, ''), '\s+', ' ', 'g'));
  v_correo      text := lower(btrim(coalesce(p_correo, '')));
  v_tel         text := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
  v_mensaje     text := nullif(btrim(coalesce(p_mensaje, '')), '');
  v_correo_hash text;
  v_limite      text := 'Ya recibimos varios mensajes. Intenta de nuevo más tarde.';
begin
  if not public.para_clubes_activa() then
    raise exception 'Este formulario no está disponible por ahora.' using errcode = 'P0001';
  end if;
  -- Con el CAPTCHA exigido, solo la ruta de la app (service role), que ya
  -- revisó el token. El anónimo o una sesión directa contra la API, no.
  if v_rol <> 'service_role'
     and coalesce((select b.activa from public.plataforma_banderas b where b.clave = 'contacto_requiere_captcha'), false) then
    raise exception 'Este formulario necesita la verificación anti-robots. Recarga la página e intenta de nuevo.' using errcode = 'P0001';
  end if;

  -- IP: la del gateway; la que manda la ruta solo si llama la service role.
  if v_rol = 'service_role' then
    v_ip := lower(nullif(btrim(coalesce(p_ip, '')), ''));
    if v_ip is not null and (char_length(v_ip) > 45 or v_ip !~ '^[0-9a-f:.]+$') then
      v_ip := null;
    end if;
  else
    v_ip := public.ip_cliente();
  end if;
  if v_ip is not null then
    v_ip_hash := public.contacto_huella('ip:' || v_ip);
  end if;

  -- Validación (la casilla trampa se revisa después, para no delatarla).
  if char_length(v_nombre) not between 2 and 80 then
    raise exception 'Escribe tu nombre (de 2 a 80 letras).' using errcode = 'P0001';
  end if;
  if char_length(v_club) not between 2 and 80 then
    raise exception 'Escribe el nombre de tu antro (de 2 a 80 letras).' using errcode = 'P0001';
  end if;
  if char_length(v_ciudad) not between 2 and 60 then
    raise exception 'Escribe la ciudad (de 2 a 60 letras).' using errcode = 'P0001';
  end if;
  if (v_nombre || ' ' || v_club || ' ' || v_ciudad) ~* '(https?:|www\.|://|[<>])' then
    raise exception 'Quita los enlaces y los símbolos < > del nombre, el antro o la ciudad.' using errcode = 'P0001';
  end if;
  if char_length(v_correo) > 120 or v_correo !~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' then
    raise exception 'Revisa tu correo (por ejemplo, nombre@antro.mx).' using errcode = 'P0001';
  end if;
  if v_tel = '' then
    v_tel := null;
  elsif char_length(v_tel) not between 10 and 15 then
    raise exception 'Escribe un teléfono de 10 dígitos, o déjalo vacío.' using errcode = 'P0001';
  end if;
  if v_mensaje is not null and char_length(v_mensaje) > 1000 then
    raise exception 'El mensaje es muy largo (máximo 1,000 caracteres).' using errcode = 'P0001';
  end if;
  if v_mensaje is not null and (select count(*) from regexp_matches(v_mensaje, '(https?://|www\.)', 'gi')) > 2 then
    raise exception 'El mensaje tiene demasiados enlaces.' using errcode = 'P0001';
  end if;

  -- Casilla trampa: misma respuesta, nada guardado, nada contado.
  if coalesce(btrim(p_sitio_web), '') <> '' then
    return 'recibido';
  end if;

  v_correo_hash := public.contacto_huella('correo:' || v_correo);

  -- Un envío a la vez por conexión y por correo: dos al mismo tiempo no se
  -- saltan el límite.
  perform pg_advisory_xact_lock(hashtextextended('contacto:' || v_correo_hash, 0));
  if v_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('contacto:' || v_ip_hash, 0));
    if (select count(*) from public.contacto_intentos i
         where i.ip_hash = v_ip_hash and i.creado_en > now() - interval '1 hour') >= 3
       or (select count(*) from public.contacto_intentos i
         where i.ip_hash = v_ip_hash and i.creado_en > now() - interval '1 day') >= 10 then
      raise exception '%', v_limite using errcode = 'P0001';
    end if;
  end if;
  if (select count(*) from public.contacto_intentos i
       where i.correo_hash = v_correo_hash and i.creado_en > now() - interval '1 day') >= 3 then
    raise exception '%', v_limite using errcode = 'P0001';
  end if;
  if (select count(*) from public.contacto_intentos i where i.creado_en > now() - interval '1 hour') >= 60 then
    raise exception 'Estamos recibiendo muchos mensajes. Intenta de nuevo en una hora.' using errcode = 'P0001';
  end if;

  insert into public.contacto_intentos (ip_hash, correo_hash) values (v_ip_hash, v_correo_hash);
  perform public.contacto_intentos_limpiar();

  insert into public.contactos_clubes (nombre, club_nombre, ciudad, correo, telefono, mensaje)
  values (v_nombre, v_club, v_ciudad, v_correo, v_tel, v_mensaje);
  return 'recibido';
end;
$$;
revoke all on function public.para_clubes_contacto_enviar(text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.para_clubes_contacto_enviar(text, text, text, text, text, text, text, text) to anon, authenticated, service_role;

-- ---------- 4. Bandeja del admin ----------
-- Por páginas (los más nuevos primero); «total» es cuántos hay con ese filtro.
-- Al abrirla también se limpian los intentos viejos.
create function public.contactos_clubes_admin(p_estado text default null, p_limite integer default 50, p_desde integer default 0)
returns table (id uuid, nombre text, club_nombre text, ciudad text, correo text, telefono text, mensaje text,
               estado text, atendido_por_nombre text, atendido_en timestamptz, creado_en timestamptz, total bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin ve los contactos de antros.' using errcode = 'P0001';
  end if;
  perform public.contacto_intentos_limpiar();
  return query
    select c.id, c.nombre, c.club_nombre, c.ciudad, c.correo, c.telefono, c.mensaje,
           c.estado, p.nombre, c.atendido_en, c.creado_en, count(*) over ()
      from public.contactos_clubes c
      left join public.profiles p on p.id = c.atendido_por
     where p_estado is null or c.estado = p_estado
     order by c.creado_en desc, c.id
     limit least(greatest(coalesce(p_limite, 50), 1), 200)
    offset greatest(coalesce(p_desde, 0), 0);
end;
$$;
revoke all on function public.contactos_clubes_admin(text, integer, integer) from public, anon, authenticated;
grant execute on function public.contactos_clubes_admin(text, integer, integer) to authenticated, service_role;

-- Cuántos hay por estado (para los filtros), aunque la página no los traiga.
create function public.contactos_clubes_conteo()
returns table (estado text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin ve los contactos de antros.' using errcode = 'P0001';
  end if;
  return query select c.estado, count(*) from public.contactos_clubes c group by c.estado;
end;
$$;
revoke all on function public.contactos_clubes_conteo() from public, anon, authenticated;
grant execute on function public.contactos_clubes_conteo() to authenticated, service_role;

-- Admin: marcar como atendido, descartado o volver a nuevo.
create function public.contacto_club_marcar(p_id uuid, p_estado text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin puede marcar los contactos.' using errcode = 'P0001';
  end if;
  if p_estado is null or p_estado not in ('nuevo', 'atendido', 'descartado') then
    raise exception 'Estado no válido.' using errcode = 'P0001';
  end if;
  update public.contactos_clubes
     set estado = p_estado,
         atendido_por = case when p_estado = 'nuevo' then null else auth.uid() end,
         atendido_en  = case when p_estado = 'nuevo' then null else now() end
   where id = p_id;
  if not found then
    raise exception 'Ese contacto ya no existe.' using errcode = 'P0001';
  end if;
  insert into public.para_clubes_bitacora (accion, detalle, contacto_id, hecho_por)
  values ('contacto_estado', p_estado, p_id, auth.uid());
end;
$$;
revoke all on function public.contacto_club_marcar(uuid, text) from public, anon, authenticated;
grant execute on function public.contacto_club_marcar(uuid, text) to authenticated, service_role;

-- Admin: borrar un contacto (si la persona pide que se borren sus datos).
-- Queda en la bitácora quién y cuándo, sin los datos borrados.
create function public.contacto_club_borrar(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.current_role_name() = 'admin', false) then
    raise exception 'Solo el admin puede borrar contactos.' using errcode = 'P0001';
  end if;
  delete from public.contactos_clubes where id = p_id;
  if not found then
    raise exception 'Ese contacto ya no existe.' using errcode = 'P0001';
  end if;
  insert into public.para_clubes_bitacora (accion, detalle, contacto_id, hecho_por)
  values ('contacto_borrado', 'borrado a petición', p_id, auth.uid());
end;
$$;
revoke all on function public.contacto_club_borrar(uuid) from public, anon, authenticated;
grant execute on function public.contacto_club_borrar(uuid) to authenticated, service_role;

commit;
