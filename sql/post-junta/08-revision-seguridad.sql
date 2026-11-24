-- ============================================================================
-- AntroApp — Arreglos de la revisión de seguridad de post-junta
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Requiere: sql/post-junta/02, 05 y 06.
-- Rollback: sql/post-junta/08-revision-seguridad-rollback.sql
--
-- 1. Contraseña temporal (alta de antros): mientras la cuenta tenga
--    app_metadata.debe_cambiar en su token, current_role_name() es nulo: no
--    ve ni hace nada hasta elegir su contraseña (la pantalla ya la manda a
--    /cambiar-contrasena; esto lo impone la base aunque se salte la pantalla).
-- 2. Legales: solo se acepta una versión publicada (versiones_legales).
-- 3. Mensualidad:
--    a) mensualidad_aplicar_suscripcion(): compara y escribe con candado en
--       UNA transacción (dos eventos simultáneos ya no se pisan) y desempata
--       eventos del mismo segundo por el estado más avanzado
--       (incomplete < activo/atrasado < cancelado).
--    b) Mientras la suscripción guardada siga viva, los eventos de OTRA
--       suscripción del mismo antro no cambian su estado.
--    c) mensualidad_vencimientos(): vence, despublica y vuelve a publicar en
--       una sola sentencia por paso (sin carreras con el webhook).
--    d) stripe_eventos.procesando_desde: cada evento lo procesa un solo
--       servidor a la vez.
-- ============================================================================

-- 1. Sin rol mientras deba cambiar su contraseña temporal.
create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = 'public'
as $$
  select role from profiles
  where id = auth.uid() and activo is not false
    and coalesce((auth.jwt() -> 'app_metadata' ->> 'debe_cambiar')::boolean, false) = false;
$$;

-- 2. Versiones publicadas de los documentos legales.
create table public.versiones_legales (
  version       text primary key check (char_length(version) between 1 and 40),
  publicada_en  timestamptz not null default now()
);
insert into public.versiones_legales (version) values ('2026-11-24-borrador');
alter table public.versiones_legales enable row level security;
revoke all on public.versiones_legales from public, anon, authenticated;
grant select on public.versiones_legales to authenticated;
grant all on public.versiones_legales to service_role;
create policy versiones_legales_select on public.versiones_legales for select to authenticated using (true);

drop policy aceptaciones_insert_propia on public.aceptaciones_legales;
create policy aceptaciones_insert_propia on public.aceptaciones_legales for insert to authenticated
  with check (profile_id = (select auth.uid())
              and exists (select 1 from public.versiones_legales v where v.version = aceptaciones_legales.version));

-- 3d. Reclamo de eventos.
alter table public.stripe_eventos add column procesando_desde timestamptz;

-- Siguiente corte de las 08:00 (zona del antro) en o después de un instante.
create or replace function public.siguiente_corte(p_desde timestamptz, p_zona text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when (p_desde at time zone p_zona)::time <= time '08:00'
      then ((p_desde at time zone p_zona)::date + time '08:00') at time zone p_zona
    else ((p_desde at time zone p_zona)::date + 1 + time '08:00') at time zone p_zona
  end;
$$;

create or replace function public.mensualidad_rango_status(p_status text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'incomplete' then 0
    when 'incomplete_expired' then 1
    when 'canceled' then 3
    else 2
  end;
$$;

-- 3a/3b. Aplica el estado de una suscripción de Stripe a su antro.
-- Devuelve el estado resultante, o 'viejo' / 'otra' si no se aplicó.
create or replace function public.mensualidad_aplicar_suscripcion(
  p_club uuid, p_sub text, p_customer text, p_status text, p_creado timestamptz,
  p_periodo_fin timestamptz, p_cancelar_al_final boolean, p_price text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_act    public.suscripciones%rowtype;
  v_plan   public.planes%rowtype;
  v_zona   text;
  v_gracia timestamptz;
  v_estado text;
begin
  insert into public.suscripciones (club_id) values (p_club) on conflict (club_id) do nothing;
  select * into v_act from public.suscripciones where club_id = p_club for update;

  -- Otra suscripción del mismo antro mientras la guardada sigue viva: no cambia nada.
  if v_act.stripe_subscription_id is not null and v_act.stripe_subscription_id <> p_sub
     and v_act.estado in ('activa', 'en_gracia') then
    return 'otra';
  end if;
  -- Desorden: un evento más viejo no pisa; del mismo segundo, gana el estado más avanzado.
  if v_act.stripe_subscription_id is not distinct from p_sub and v_act.ultimo_evento_en is not null and (
       p_creado < v_act.ultimo_evento_en
       or (p_creado = v_act.ultimo_evento_en
           and public.mensualidad_rango_status(p_status) < public.mensualidad_rango_status(coalesce(v_act.estado_stripe, 'incomplete')))) then
    return 'viejo';
  end if;

  select * into v_plan from public.planes where stripe_price_id = p_price;
  select coalesce(zona_horaria, 'America/Mexico_City') into v_zona from public.clubs where id = p_club;
  v_gracia := case when v_act.stripe_subscription_id is not distinct from p_sub then v_act.gracia_hasta end;
  if p_status in ('past_due', 'unpaid', 'paused') then
    v_gracia := coalesce(v_gracia, public.siguiente_corte(now() + make_interval(days => coalesce(v_plan.dias_gracia, 7)), v_zona));
    v_estado := case when now() < v_gracia then 'en_gracia' else 'vencida' end;
  elsif p_status in ('canceled', 'incomplete_expired') then
    v_gracia := public.siguiente_corte(now(), v_zona);
    v_estado := 'cancelada';
  elsif p_status in ('active', 'trialing') then
    v_gracia := null;
    v_estado := 'activa';
  else
    v_gracia := null;
    v_estado := 'sin_suscripcion';
  end if;

  update public.suscripciones set
    plan_id = coalesce(v_plan.id, plan_id),
    stripe_subscription_id = p_sub,
    stripe_customer_id = coalesce(p_customer, stripe_customer_id),
    estado = v_estado,
    estado_stripe = p_status,
    periodo_fin = p_periodo_fin,
    gracia_hasta = v_gracia,
    cancelar_al_final = coalesce(p_cancelar_al_final, false),
    ultimo_evento_en = p_creado,
    actualizado_en = now()
  where club_id = p_club;

  -- Solo publica; despublicar es de la tarea diaria, después del corte.
  if v_estado in ('activa', 'en_gracia') then
    update public.clubs set suscripcion_activa = true, suscripcion_activada_en = now()
    where id = p_club and not suscripcion_activa;
  end if;
  return v_estado;
end;
$$;
revoke all on function public.mensualidad_aplicar_suscripcion(uuid, text, text, text, timestamptz, timestamptz, boolean, text) from public, anon, authenticated;
grant execute on function public.mensualidad_aplicar_suscripcion(uuid, text, text, text, timestamptz, timestamptz, boolean, text) to service_role;

-- 3c. Tarea diaria, sin carreras.
create or replace function public.mensualidad_vencimientos()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vencidas int;
  v_fuera int;
  v_dentro int;
begin
  update public.suscripciones set estado = 'vencida', actualizado_en = now()
  where estado = 'en_gracia' and gracia_hasta < now();
  get diagnostics v_vencidas = row_count;

  update public.clubs c set suscripcion_activa = false
  where c.suscripcion_activa
    and exists (select 1 from public.suscripciones s
                where s.club_id = c.id and s.estado in ('vencida', 'cancelada')
                  and (s.gracia_hasta is null or s.gracia_hasta <= now()));
  get diagnostics v_fuera = row_count;

  -- Si un pago llegó y algo lo dejó oculto, se vuelve a publicar.
  update public.clubs c set suscripcion_activa = true, suscripcion_activada_en = now()
  where not c.suscripcion_activa
    and exists (select 1 from public.suscripciones s where s.club_id = c.id and s.estado in ('activa', 'en_gracia'));
  get diagnostics v_dentro = row_count;

  return jsonb_build_object('vencidas', v_vencidas, 'despublicados', v_fuera, 'republicados', v_dentro);
end;
$$;
revoke all on function public.mensualidad_vencimientos() from public, anon, authenticated;
grant execute on function public.mensualidad_vencimientos() to service_role;

-- 1b. Lo mismo para el dueño y el dueño de grupo: sin rol vigente (dado de
-- baja o con contraseña temporal) no cuenta como dueño. Quedan políticas que
-- comparan clubs.dueno_id = auth.uid() directo (ver docs/reporte-post-junta.md).
create or replace function public.club_es_dueno(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and public.current_role_name() is not null
     and exists (select 1 from public.clubs c where c.id = p_club_id and c.dueno_id = auth.uid());
$$;

create or replace function public.club_es_dueno_grupo(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and public.current_role_name() is not null
     and exists (
       select 1
       from public.grupo_miembros m
       join public.grupo_clubs gc on gc.grupo_id = m.grupo_id
       where m.profile_id = auth.uid()
         and m.rol_grupo = 'dueno_grupo'
         and gc.club_id = p_club_id);
$$;
