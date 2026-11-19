-- ============================================================================
-- ROLLBACK de sql/2026-11-20-caja-por-mesa.sql
-- Deja la base como estaba antes de la caja, la puerta, el grupo y la nómina.
--
-- ATENCIÓN: borra las tablas de caja CON SUS DATOS (noches, mesas, consumos,
-- pagos, cuadres, bitácora) y las columnas de puerta de reservations. Es para
-- deshacer el pase si la verificación falla el mismo día, antes de que se
-- registre una noche real. Si ya hay noches reales, primero respaldarlas.
-- Las comisiones que la caja haya creado se quedan en commissions (son filas
-- normales de tipo 'rp').
--
-- Probado en dev: aplicar caja -> rollback -> el esquema vuelve a ser igual
-- al de producción (scripts/db/extraer-esquema.mjs + diff).
-- ============================================================================

-- 1. Triggers nuevos sobre tablas que se quedan.
drop trigger if exists reservations_candado_puerta on public.reservations;
drop trigger if exists clubs_candado_zona_horaria on public.clubs;
drop trigger if exists reservations_campos_fijos on public.reservations;

-- Versiones de producción de la política del RP y del candado de perfiles.
drop policy if exists reservations_insert_rp on public.reservations;
create policy reservations_insert_rp on public.reservations as permissive for insert to authenticated
  with check (((source = 'rp'::text) AND (rp_id = auth.uid()) AND (cliente_id IS NULL) AND (current_role_name() = 'rp'::text)));

CREATE OR REPLACE FUNCTION public.profiles_bloquear_cambio_privilegios()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null or public.current_role_name() = 'admin' then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'No puedes cambiar el rol de un perfil.';
  end if;
  if new.club_id is distinct from old.club_id then
    raise exception 'No puedes cambiar el club de un perfil.';
  end if;
  return new;
end $function$;

-- 2. Políticas existentes que la caja cambió (bloques 17 y 18): vuelven a su
--    texto de producción (sql/esquema/esquema-prod.sql).
drop policy if exists clubs_restrictiva_select_publicados on public.clubs;
create policy clubs_restrictiva_select_publicados on public.clubs as restrictive for select to public
  using ((((estado_verificacion = 'verificado'::text) AND (suscripcion_activa = true)) OR (( SELECT current_role_name() AS current_role_name) = 'admin'::text) OR ((dueno_id IS NOT NULL) AND (dueno_id = ( SELECT auth.uid() AS uid))) OR ((( SELECT current_role_name() AS current_role_name) = ANY (ARRAY['staff'::text, 'gerente'::text, 'rp'::text])) AND (id = ( SELECT current_club_id() AS current_club_id)))));

drop policy if exists reservations_insert_anonimo on public.reservations;
create policy reservations_insert_anonimo on public.reservations as permissive for insert to anon
  with check (((club_id IS NOT NULL) AND (source = 'organica'::text) AND (rp_id IS NULL) AND (cliente_id IS NULL) AND (status = 'pendiente'::text) AND (consumo_monto IS NULL) AND (mesa_id IS NULL) AND (COALESCE(se_retiro_sin_consumir, false) = false) AND ((personas >= 1) AND (personas <= 20)) AND (fecha >= ((now() AT TIME ZONE 'America/Mexico_City'::text))::date)));

drop policy if exists reservations_insert_cliente_logueado on public.reservations;
create policy reservations_insert_cliente_logueado on public.reservations as permissive for insert to authenticated
  with check (((club_id IS NOT NULL) AND (source = 'organica'::text) AND (rp_id IS NULL) AND (cliente_id = ( SELECT auth.uid() AS uid)) AND (( SELECT current_role_name() AS current_role_name) = 'cliente'::text) AND (status = 'pendiente'::text) AND (consumo_monto IS NULL) AND (mesa_id IS NULL) AND (COALESCE(se_retiro_sin_consumir, false) = false) AND ((personas >= 1) AND (personas <= 20)) AND (fecha >= ((now() AT TIME ZONE 'America/Mexico_City'::text))::date)));

-- 3. Tablas nuevas (con sus políticas, índices y triggers). DROP no dispara
--    el trigger de "nada se borra" (ese es por fila de DELETE/TRUNCATE).
drop table if exists
  public.caja_eventos, public.caja_cuadres, public.caja_pagos, public.caja_consumos,
  public.mesa_cuentas, public.mesa_sesiones, public.caja_noches, public.caja_permisos,
  public.grupo_miembros, public.grupo_clubs, public.grupos
  cascade;

-- 4. Funciones nuevas.
drop function if exists
  public.caja_sin_borrar(),
  public.caja_insert_coherente(),
  public.reservations_campos_fijos(),
  public.clubs_candado_zona_horaria(),
  public.club_fecha_operacion(uuid, timestamptz),
  public.club_es_dueno(uuid),
  public.club_es_dueno_grupo(uuid),
  public.caja_puede_ver(uuid),
  public.puede_ver_club(uuid),
  public.caja_tiene_permiso(uuid, text),
  public.caja_noche_actual(uuid),
  public.caja_evento(uuid, uuid, uuid, text, jsonb),
  public.caja_sesion_para_escribir(uuid, text),
  public.caja_abrir_mesa(uuid),
  public.caja_sentar_cliente(uuid, uuid, text, int),
  public.caja_registrar_consumo(uuid, bigint, text),
  public.caja_anular_consumo(uuid, text),
  public.caja_registrar_pago(uuid, uuid, text, bigint, text),
  public.caja_anular_pago(uuid, text),
  public.caja_totales_sesion(uuid),
  public.caja_liquidar_cuenta(uuid),
  public.caja_cerrar_mesa(uuid),
  public.caja_reabrir_mesa(uuid, text),
  public.caja_cuadrar_mesa(uuid, text),
  public.caja_cerrar_noche(uuid, bigint, bigint, bigint, text),
  public.caja_configurar_permiso(uuid, text, text, uuid, boolean),
  public.es_gerente_o_dueno(uuid),
  public.puerta_es_tarde(uuid, date, timestamptz),
  public.puerta_reserva_para_escribir(uuid),
  public.puerta_escanear(text),
  public.puerta_confirmar_entrada(uuid),
  public.reservations_candado_puerta(),
  public.nomina_lunes_iso(int, int),
  public.nomina_semana_datos(uuid, date, uuid),
  public.nomina_semana(uuid, int, int),
  public.nomina_semana_mia(int, int),
  public.nomina_marcar_pagada(uuid, uuid, int, int);

-- 5. Columnas nuevas en tablas que se quedan.
alter table public.reservations
  drop column if exists puerta_estado,
  drop column if exists en_puerta_en,
  drop column if exists en_puerta_por,
  drop column if exists entrada_en,
  drop column if exists entrada_por,
  drop column if exists llegada_tarde;
alter table public.clubs
  drop column if exists zona_horaria,
  drop column if exists tolerancia_hora;
alter table public.commissions
  drop column if exists pagada_en,
  drop column if exists pagada_por;
alter table public.rp_pagos_dia
  drop column if exists pagada_en,
  drop column if exists pagada_por;
