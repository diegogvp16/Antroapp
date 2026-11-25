-- ============================================================================
-- AntroApp — Estado del boleto público (/r/<codigo>) y datos de la puerta
-- Fecha: 2026-11-24 (rama b-cliente, post-junta-2)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO.
-- Rollback: sql/post-junta-2/40-boleto-estado-rollback.sql (restaura la
-- versión exacta de hoy, con el mismo search_path y los mismos GRANT).
--
-- obtener_reserva_por_qr(p_qr) es la ÚNICA lectura pública de una reserva
-- (anon). Hoy devuelve el status crudo y la página siempre pinta el QR,
-- aunque la reserva ya se usó o era de otra noche. Esta versión agrega
-- columnas AL FINAL (las seis de hoy quedan iguales y en el mismo orden,
-- así el código viejo sigue funcionando):
--
--   estado_boleto  calculado en la base, nunca en el navegador:
--     'usado'   si ya entró (status 'usada', entrada_en o puerta_estado
--               'entro');
--     'vencido' si su fecha es anterior a la noche operativa del antro
--               (hora local del antro, corte 08:00, igual que
--               club_fecha_operacion);
--     'vigente' en otro caso.
--     No hay estado "cancelado": reservations_status_check solo admite
--     pendiente, confirmada y usada (ninguna pantalla cancela).
--   club_direccion, cover_modo, cover_monto, tolerancia_hora, edad_minima,
--   codigo_vestimenta: lo que el cliente necesita saber en la puerta.
--     Solo si el antro está PUBLICADO (verificado y con suscripción): de un
--     borrador o de un antro dado de baja no sale más que el nombre, igual
--     que hoy.
--
-- Sigue SIN exponer: teléfono, consumo, ids (reserva, club, cliente, RP,
-- mesa), source ni la hora exacta de entrada. El código antro-<uuid> no es
-- enumerable y se pide el código exacto (una fila como máximo).
--
-- Cambiar el tipo de retorno exige drop + create: se hace en la misma
-- transacción (aplicar-dev.mjs / SQL Editor), sin ventana sin función.
-- GRANT igual que hoy: anon, authenticated y service_role; nada a PUBLIC.
-- ============================================================================

drop function if exists public.obtener_reserva_por_qr(text);

create function public.obtener_reserva_por_qr(p_qr text)
returns table (
  cliente_nombre    text,
  fecha             date,
  personas          integer,
  status            text,
  qr_code           text,
  club_nombre       text,
  estado_boleto     text,
  club_direccion    text,
  cover_modo        text,
  cover_monto       numeric,
  tolerancia_hora   time,
  edad_minima       integer,
  codigo_vestimenta text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.cliente_nombre,
         r.fecha,
         r.personas,
         r.status,
         r.qr_code,
         c.nombre as club_nombre,
         case
           when r.status = 'usada'
             or r.entrada_en is not null
             or r.puerta_estado = 'entro' then 'usado'
           when r.fecha < ((now() at time zone coalesce(c.zona_horaria, 'America/Mexico_City'))
                           - interval '8 hours')::date then 'vencido'
           else 'vigente'
         end as estado_boleto,
         case when pub.publicado then c.direccion end         as club_direccion,
         case when pub.publicado then c.cover_modo end        as cover_modo,
         case when pub.publicado then c.cover_monto end       as cover_monto,
         case when pub.publicado then c.tolerancia_hora end   as tolerancia_hora,
         case when pub.publicado then c.edad_minima end       as edad_minima,
         case when pub.publicado then c.codigo_vestimenta end as codigo_vestimenta
  from public.reservations r
  left join public.clubs c on c.id = r.club_id
  cross join lateral (
    select coalesce(c.estado_verificacion = 'verificado' and c.suscripcion_activa, false) as publicado
  ) pub
  where r.qr_code = p_qr
  limit 1;
$$;

comment on function public.obtener_reserva_por_qr(text) is
  'Boleto público por código QR exacto (anon). Sin teléfono, consumo ni ids. estado_boleto: vigente | usado | vencido, calculado en la base. Datos de la puerta solo de antros publicados. sql/post-junta-2/40-boleto-estado.sql';

revoke all on function public.obtener_reserva_por_qr(text) from public, anon, authenticated, service_role;
grant execute on function public.obtener_reserva_por_qr(text) to anon;
grant execute on function public.obtener_reserva_por_qr(text) to authenticated;
grant execute on function public.obtener_reserva_por_qr(text) to service_role;
