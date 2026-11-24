-- ============================================================================
-- AntroApp — Mensualidad del antro con Stripe (modo de prueba primero)
-- Fecha: 2026-11-24 (rama post-junta)
-- Estado: APLICADO Y PROBADO EN DEV. En producción NO (va en el "pase 2").
-- Rollback: sql/post-junta/06-mensualidad-rollback.sql
--
-- Todo esto solo se usa con la bandera NEXT_PUBLIC_MENSUALIDAD encendida
-- (docs/stripe-mensualidad.md). Con la bandera apagada nadie escribe aquí y
-- clubs.suscripcion_activa sigue funcionando como hoy (botón simulado).
--
--   planes             : planes configurables (precio en Stripe; aquí solo
--                        el id del precio y lo que Stripe reporta).
--   suscripciones      : estado por antro (activa, en_gracia, vencida,
--                        cancelada, sin_suscripcion), lo escribe el webhook.
--   pagos_mensualidad  : historial de facturas (pagadas y fallidas).
--   stripe_eventos     : eventos ya procesados (idempotencia del webhook).
--   config_plataforma  : 'mensualidad_real' = true cuando el cobro es real;
--                        entonces suscripcion_activa queda bajo candado
--                        (deuda 2 de CLAUDE.md): solo el webhook (service_role)
--                        y el admin la cambian.
--
-- Escribe el servidor con service_role (webhook y rutas). Lectura: el admin
-- todo; el dueño, lo de su antro; nadie más (ni gerente ni staff).
-- ============================================================================

create table public.config_plataforma (
  clave       text primary key check (clave in ('mensualidad_real')),
  valor       jsonb not null,
  actualizado_en timestamptz not null default now()
);
insert into public.config_plataforma (clave, valor) values ('mensualidad_real', 'false');
alter table public.config_plataforma enable row level security;
revoke all on public.config_plataforma from public, anon, authenticated;
grant select on public.config_plataforma to authenticated;
grant all on public.config_plataforma to service_role;
create policy config_plataforma_select_admin on public.config_plataforma for select to authenticated
  using ((select public.current_role_name()) = 'admin');

create table public.planes (
  id               uuid primary key default gen_random_uuid(),
  clave            text not null unique check (clave ~ '^[a-z0-9_-]{2,40}$'),
  nombre           text not null check (char_length(nombre) between 2 and 80),
  descripcion      text check (char_length(descripcion) <= 300),
  stripe_price_id  text not null unique check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  -- Lo que reporta Stripe del precio (informativo; el cobro lo hace Stripe).
  monto_centavos   bigint check (monto_centavos >= 0),
  moneda           text not null default 'mxn',
  dias_gracia      int not null default 7 check (dias_gracia between 0 and 60),
  activo           boolean not null default true,
  creado_en        timestamptz not null default now()
);
alter table public.planes enable row level security;
revoke all on public.planes from public, anon, authenticated;
grant select, insert, update on public.planes to authenticated;  -- políticas: leer dueño/admin, escribir solo admin
grant all on public.planes to service_role;
create policy planes_select on public.planes for select to authenticated
  using ((select public.current_role_name()) in ('admin', 'dueno'));
create policy planes_insert_admin on public.planes for insert to authenticated
  with check ((select public.current_role_name()) = 'admin');
create policy planes_update_admin on public.planes for update to authenticated
  using ((select public.current_role_name()) = 'admin')
  with check ((select public.current_role_name()) = 'admin');

create table public.suscripciones (
  club_id                 uuid primary key references public.clubs (id) on delete cascade,
  plan_id                 uuid references public.planes (id),
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  estado                  text not null default 'sin_suscripcion'
                            check (estado in ('sin_suscripcion', 'activa', 'en_gracia', 'vencida', 'cancelada')),
  estado_stripe           text,
  periodo_fin             timestamptz,
  gracia_hasta            timestamptz,
  cancelar_al_final       boolean not null default false,
  -- created del último evento aplicado: un evento más viejo no pisa uno nuevo.
  ultimo_evento_en        timestamptz,
  actualizado_en          timestamptz not null default now()
);
alter table public.suscripciones enable row level security;
revoke all on public.suscripciones from public, anon, authenticated;
grant select on public.suscripciones to authenticated;
grant all on public.suscripciones to service_role;
create policy suscripciones_select on public.suscripciones for select to authenticated
  using ((select public.current_role_name()) = 'admin' or public.club_es_dueno(club_id));

create table public.pagos_mensualidad (
  id                 uuid primary key default gen_random_uuid(),
  club_id            uuid not null references public.clubs (id) on delete cascade,
  stripe_invoice_id  text not null unique,
  monto_centavos     bigint not null check (monto_centavos >= 0),
  moneda             text not null,
  estado             text not null check (estado in ('pagado', 'fallido', 'pendiente', 'anulado')),
  periodo_inicio     timestamptz,
  periodo_fin        timestamptz,
  url_factura        text,
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now()
);
create index pagos_mensualidad_club on public.pagos_mensualidad (club_id, creado_en desc);
alter table public.pagos_mensualidad enable row level security;
revoke all on public.pagos_mensualidad from public, anon, authenticated;
grant select on public.pagos_mensualidad to authenticated;
grant all on public.pagos_mensualidad to service_role;
create policy pagos_mensualidad_select on public.pagos_mensualidad for select to authenticated
  using ((select public.current_role_name()) = 'admin' or public.club_es_dueno(club_id));

create table public.stripe_eventos (
  id            text primary key check (id ~ '^evt_[A-Za-z0-9]+$'),
  tipo          text not null,
  recibido_en   timestamptz not null default now(),
  procesado_en  timestamptz,
  error         text
);
alter table public.stripe_eventos enable row level security;
revoke all on public.stripe_eventos from public, anon, authenticated;
grant all on public.stripe_eventos to service_role;
-- Sin políticas: solo el servidor.

-- Candado de suscripcion_activa cuando el cobro es real.
create or replace function public.clubs_candado_suscripcion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or coalesce(public.current_role_name(), '') = 'admin' then
    return new;  -- service_role (webhook, cron) y admin
  end if;
  if coalesce((select (valor)::text::boolean from public.config_plataforma where clave = 'mensualidad_real'), false) then
    if tg_op = 'INSERT' then
      new.suscripcion_activa := false;
      new.suscripcion_activada_en := null;
    elsif new.suscripcion_activa is distinct from old.suscripcion_activa
          or new.suscripcion_activada_en is distinct from old.suscripcion_activada_en then
      raise exception 'La suscripción se activa con el pago de la mensualidad.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger clubs_candado_suscripcion before insert or update on public.clubs
  for each row execute function public.clubs_candado_suscripcion();
