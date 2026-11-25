-- ============================================================================
-- AntroApp — Dos autorizaciones más que no deben quedar en NULL
-- Fecha: 2026-11-25 (rama c-rls, auditoría de RLS)
-- Estado: APLICADO Y PROBADO EN DEV (scripts/dev/auditoria-rls.mjs). En producción NO.
-- Rollback: sql/post-junta-2/60-autorizacion-nulos-c-rollback.sql
--
-- Hallazgos del escaneo de funciones (docs/auditoria-rls.md):
--  1. personal_cambiar_estado (post-junta 02; NO está en producción): un
--     gerente con profiles.club_id nulo pasaba la autorización y daba de baja
--     o reactivaba staff de CUALQUIER antro. Probado en dev con sesión real.
--     Requiere un perfil anómalo (gerente sin antro; hoy solo lo crea el admin
--     a mano), por eso es BAJO, pero falla abierto.
--  2. nomina_transicion_valida (pase 1; SÍ está en producción): con
--     p_desde o p_hacia nulos devolvía NULL y nomina_cambiar_estado no
--     rechazaba. Inocuo (el UPDATE con status = NULL no toca filas), se
--     endurece para que la regla sea "falla cerrada".
-- Cuerpos tomados del catálogo de dev; solo cambian esas líneas.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.personal_cambiar_estado(p_profile_id uuid, p_activo boolean, p_motivo text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_yo      uuid := auth.uid();
  v_rol     text := public.current_role_name();
  v_motivo  text := trim(coalesce(p_motivo, ''));
  v_obj     record;
begin
  if v_yo is null or v_rol is null then
    raise exception 'Necesitas iniciar sesión.' using errcode = 'P0001';
  end if;
  if p_activo is null then
    raise exception 'Indica si se da de baja o se reactiva.' using errcode = 'P0001';
  end if;
  if char_length(v_motivo) not between 3 and 300 then
    raise exception 'Escribe el motivo (de 3 a 300 caracteres).' using errcode = 'P0001';
  end if;

  select id, role, club_id, activo, nombre into v_obj
  from public.profiles where id = p_profile_id
  for update;
  if not found or v_obj.role not in ('staff', 'gerente') or v_obj.club_id is null then
    raise exception 'Solo se puede dar de baja o reactivar a staff y gerentes.' using errcode = 'P0001';
  end if;
  if v_obj.id = v_yo then
    raise exception 'No puedes cambiar tu propio estado.' using errcode = 'P0001';
  end if;

  -- coalesce: un gerente con club_id nulo (perfil anómalo) daba NULL en
  -- "current_club_id() = v_obj.club_id" y el "if not (NULL)" lo dejaba pasar.
  if not coalesce(
    v_rol = 'admin'
    or public.club_es_dueno(v_obj.club_id)
    or (v_rol = 'gerente' and public.current_club_id() = v_obj.club_id and v_obj.role = 'staff')
  , false) then
    raise exception 'No tienes permiso para cambiar a esta persona.' using errcode = 'P0001';
  end if;

  if v_obj.activo is not distinct from p_activo then
    raise exception '% ya está %.', v_obj.nombre, case when p_activo then 'activo' else 'dado de baja' end using errcode = 'P0001';
  end if;

  perform set_config('antroapp.cambio_personal', 'si', true);
  update public.profiles set activo = p_activo where id = v_obj.id;
  perform set_config('antroapp.cambio_personal', '', true);
  insert into public.personal_movimientos (profile_id, club_id, accion, motivo, hecho_por)
  values (v_obj.id, v_obj.club_id, case when p_activo then 'reactivacion' else 'baja' end, v_motivo, v_yo);

  -- Cierra sus sesiones: ya no puede renovar el token. Si en algún proyecto
  -- no hubiera permiso sobre auth.sessions, la baja vale igual (RLS ya lo
  -- dejó fuera en el paso 1).
  if not p_activo then
    begin
      delete from auth.sessions where user_id = v_obj.id;
    exception when insufficient_privilege then
      null;
    end;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.nomina_transicion_valida(p_desde text, p_hacia text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  -- coalesce: con un estado nulo la comparación daba NULL y el
  -- "if not nomina_transicion_valida(…)" de nomina_cambiar_estado no rechazaba.
  select coalesce((p_desde, p_hacia) in (
    ('pendiente', 'en_revision'), ('en_revision', 'pendiente'),
    ('en_revision', 'validada'),  ('validada', 'en_revision'),
    ('validada', 'pagada'),
    ('pendiente', 'anulada'), ('en_revision', 'anulada'), ('validada', 'anulada')), false);
$function$;

revoke all on function public.personal_cambiar_estado(uuid, boolean, text) from public, anon;
grant execute on function public.personal_cambiar_estado(uuid, boolean, text) to authenticated, service_role;
revoke all on function public.nomina_transicion_valida(text, text) from public, anon;
grant execute on function public.nomina_transicion_valida(text, text) to authenticated, service_role;
