-- ============================================================================
-- Rollback de sql/post-junta-3/81-propinas.sql
--
-- AVISO: ESTE ROLLBACK BORRA REGISTROS DE DINERO. Se pierden, sin forma de
-- recuperarlos, las propinas sueltas (caja_propinas), las anulaciones de
-- propinas de cobros (propinas_cobro_anuladas), la regla del reparto de cada
-- antro (propinas_config) y los repartos con sus líneas. La propina capturada
-- al cobrar (caja_pagos.propina_centavos, fase 2) NO se toca. Los eventos de
-- caja de propinas se quedan (caja_sin_borrar no deja borrarlos).
--
-- ANTES de correrlo, respalda y guarda el resultado de esta consulta (una
-- sola fila con todo en JSON; en el SQL Editor: copiar el valor):
--
--   select jsonb_build_object(
--     'respaldado_en',           now(),
--     'caja_propinas',           (select coalesce(jsonb_agg(t), '[]') from public.caja_propinas t),
--     'propinas_cobro_anuladas', (select coalesce(jsonb_agg(t), '[]') from public.propinas_cobro_anuladas t),
--     'propinas_config',         (select coalesce(jsonb_agg(t), '[]') from public.propinas_config t),
--     'propinas_repartos',       (select coalesce(jsonb_agg(t), '[]') from public.propinas_repartos t),
--     'propinas_reparto_lineas', (select coalesce(jsonb_agg(t), '[]') from public.propinas_reparto_lineas t)
--   ) as respaldo_propinas;
--
-- Ninguna función existente cambió con el 81, así que no hay nada que
-- restaurar: solo se quita lo nuevo.
-- ============================================================================
begin;

drop function if exists public.propinas_reporte_noche(uuid, date);
drop function if exists public.propinas_anular_reparto(uuid, text);
drop function if exists public.propinas_repartir(uuid, uuid[], bigint, int, int, int, boolean);
drop function if exists public.propinas_calcular(uuid, uuid[], int, int, int, boolean);
drop function if exists public.propinas_regla(uuid);
drop function if exists public.propinas_partes(uuid, int, int);
drop function if exists public.propinas_de_noche(uuid);
drop function if exists public.propinas_detalle(uuid);
drop function if exists public.propinas_anular_de_cobro(uuid, text);
drop function if exists public.propinas_config_guardar(uuid, int, int, int, boolean);
drop function if exists public.propinas_config_leer(uuid);
drop function if exists public.caja_anular_propina(uuid, text);
drop function if exists public.caja_registrar_propina(uuid, uuid, uuid, text, bigint, text, uuid);

drop table if exists public.propinas_cobro_anuladas;
drop table if exists public.propinas_reparto_lineas;
drop table if exists public.propinas_repartos;
drop table if exists public.propinas_config;
drop table if exists public.caja_propinas;
drop function if exists public.propinas_candado();

commit;
