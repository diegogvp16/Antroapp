# Reglas de comisión de RP por antro — diseño

> Estado: **solo diseño**. El SQL de este documento **no se ha corrido** en
> ninguna base (ni dev ni producción). Antes de implementarlo hay que cerrar
> las 3 preguntas del final con el cliente.

## 1. Qué se quiere

Cada antro elige cómo le paga a sus RPs por las reservas que **consumen**:

| # | Regla | Ejemplo |
|---|---|---|
| 1 | Porcentaje del consumo | 10 % de lo que consumió la mesa del cliente |
| 2 | Monto fijo por reserva que consume | $150 por cada reserva que consumió |
| 3 | Con cuota | Las primeras N del periodo no pagan; desde la N+1 cada una paga $X (Human Hood: N = 4) |

Parámetros de cada regla:

- **Periodo**: noche, semana (lunes a domingo) o mes. Solo importa para la
  cuota.
- **N**: tamaño de la cuota (solo regla 3).
- **Monto**: $X fijo, o porcentaje.
- **Consumo mínimo**: debajo de esa cantidad, la reserva no paga (y hay que
  decidir si cuenta para la cuota).
- **Monto según el tamaño del grupo**: por ejemplo, $100 para 1–4 personas
  y $200 para 5 o más.

Se mantiene lo que ya está decidido: la comisión **la paga el antro en su
nómina**; AntroApp la calcula y la registra. Nada se cobra al cliente.

## 2. Qué soporta hoy el código

El cálculo vive en `caja_liquidar_cuenta()`
(`sql/2026-11-20-caja-por-mesa.sql`, bloque 11). Corre **una vez por
cuenta, al cuadrar la mesa**, con la base = suma de los consumos no
anulados de esa cuenta. Usa `clubs.pago_rp_modo = 'reserva'` y:

- `comision_tipo`: `fijo` o `porcentaje`;
- `comision_monto`: pesos (fijo) o porcentaje;
- `comision_desbloqueo_reservas`: el "desbloqueo semanal";
- `rp_comision_overrides`: lo mismo, personalizado por RP.

| Regla | ¿Hoy? | Cómo |
|---|---|---|
| 1. Porcentaje | **Sí** | `comision_tipo = 'porcentaje'` |
| 2. Fijo por reserva que consume | **Sí** | `comision_tipo = 'fijo'`. Solo nace comisión si la cuenta consumió (> $0). |
| 3. Con cuota | **En parte** | El desbloqueo semanal ya es una cuota, pero solo por **semana**, sin consumo mínimo y sin monto por tamaño de grupo. |

**Ojo con el número (es fácil equivocarse por uno).** Con el desbloqueo
`D`, la reserva número `D` de la semana ya **paga**; las primeras `D − 1`
quedan en $0 (`(conteo + 1) < D → 0`). Para el caso Human Hood ("las
primeras 4 no pagan, la 5.ª sí") hoy hay que capturar **D = 5**, aunque la
pantalla diga "Reservas necesarias para desbloquear comisión esta semana".
En el modelo nuevo se guarda directamente `cuota = N` (primeras N no pagan).

Otros detalles del cálculo actual que se conservan:

- Las reservas que no pagan por la cuota **sí** generan una fila en
  `commissions` con monto $0: así se cuentan y la nómina muestra por qué
  quedaron en cero.
- El conteo es por RP, antro y semana de la **fecha de la reserva**
  (noche operativa, corte a las 08:00 en la zona del antro), y no cuenta
  las comisiones anuladas.
- Hay un candado por RP y semana (`pg_advisory_xact_lock`): dos cuadres
  simultáneos no leen el mismo conteo.
- Los walk-ins no tienen reserva ni RP: nunca generan comisión.
- `rp_progreso_cuota()` (panel del RP) lee la misma configuración y
  responde "sin cuota" cuando el desbloqueo es 0 o 1.

## 3. Modelo propuesto

Una tabla de reglas **con vigencia**, en lugar de columnas sueltas en
`clubs`:

- Al cambiar la regla no se reescribe nada: se cierra la vigente y se abre
  otra. Cada comisión guarda qué regla la calculó.
- Arregla la deuda 9 de `CLAUDE.md`: hoy el staff lee la configuración de
  comisión porque vive en `clubs`. La tabla nueva no la lee el staff.
- El dinero va en centavos y el porcentaje en puntos base (10 % = 1000).
  Sin flotantes.

### 3.1 SQL propuesto (NO EJECUTADO)

```sql
-- =====================================================================
-- PROPUESTA — NO CORRER TODAVÍA. Falta cerrar las preguntas del final.
-- Se aplicaría primero en dev (aplicar-dev.mjs) con sus pruebas por rol.
-- =====================================================================

create table public.reglas_comision (
  id                    uuid primary key default gen_random_uuid(),
  club_id               uuid not null references public.clubs (id),
  rp_id                 uuid references public.profiles (id),   -- null = regla del antro
  tipo                  text not null check (tipo in ('porcentaje', 'fijo', 'cuota')),
  periodo               text not null default 'semana' check (periodo in ('noche', 'semana', 'mes')),
  cuota                 int  not null default 0 check (cuota between 0 and 100),
  porcentaje_bp         int  check (porcentaje_bp between 0 and 10000),   -- 1000 = 10 %
  monto_centavos        bigint check (monto_centavos between 0 and 10000000),
  consumo_minimo_centavos bigint not null default 0 check (consumo_minimo_centavos >= 0),
  -- Escalones por tamaño de grupo: [{"desde": 1, "monto_centavos": 10000},
  --                                 {"desde": 5, "monto_centavos": 20000}]
  -- null = mismo monto para cualquier grupo.
  escalones_personas    jsonb,
  vigente_desde         date not null,
  vigente_hasta         date,            -- null = vigente
  creada_por            uuid references public.profiles (id) default auth.uid(),
  creada_en             timestamptz not null default now(),
  check (vigente_hasta is null or vigente_hasta >= vigente_desde),
  check (
    (tipo = 'porcentaje' and porcentaje_bp is not null) or
    (tipo in ('fijo', 'cuota') and (monto_centavos is not null or escalones_personas is not null))
  ),
  check (tipo = 'cuota' or cuota = 0)
);
-- Una sola regla vigente por antro (y por RP en las personalizadas).
create unique index reglas_comision_vigente
  on public.reglas_comision (club_id, coalesce(rp_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where vigente_hasta is null;

alter table public.reglas_comision enable row level security;
revoke all on public.reglas_comision from public, anon, authenticated;
grant select on public.reglas_comision to authenticated;
grant all on public.reglas_comision to service_role;

-- Leen las reglas: admin, dueño del antro y gerente. El staff NO (no ve
-- sueldos). El RP solo ve su progreso por rp_progreso_cuota().
create policy reglas_comision_select on public.reglas_comision
  for select to authenticated
  using (
    public.current_role_name() = 'admin'
    or public.club_es_dueno(club_id)
    or (public.current_role_name() = 'gerente' and public.current_club_id() = club_id)
  );
-- Escribir solo por la función (abajo): sin políticas de insert/update/delete.

-- La comisión recuerda con qué regla y en qué lugar del periodo se calculó.
alter table public.commissions
  add column regla_id uuid references public.reglas_comision (id),
  add column numero_en_periodo int;

-- Regla vigente para un RP en una noche: la personalizada si hay, si no la
-- del antro.
create or replace function public.regla_comision_vigente(p_club uuid, p_rp uuid, p_fecha date)
returns public.reglas_comision
language sql stable security definer set search_path = ''
as $$
  select r.* from public.reglas_comision r
  where r.club_id = p_club
    and (r.rp_id = p_rp or r.rp_id is null)
    and r.vigente_desde <= p_fecha
    and (r.vigente_hasta is null or r.vigente_hasta >= p_fecha)
  order by (r.rp_id is null)   -- primero la del RP
  limit 1;
$$;

-- Inicio del periodo de una noche.
create or replace function public.inicio_periodo(p_periodo text, p_fecha date)
returns date language sql immutable set search_path = ''
as $$
  select case p_periodo
    when 'noche'  then p_fecha
    when 'semana' then p_fecha - (extract(isodow from p_fecha)::int - 1)
    else date_trunc('month', p_fecha)::date
  end;
$$;

create or replace function public.fin_periodo(p_periodo text, p_fecha date)
returns date language sql immutable set search_path = ''
as $$
  select case p_periodo
    when 'noche'  then p_fecha
    when 'semana' then public.inicio_periodo('semana', p_fecha) + 6
    else (date_trunc('month', p_fecha) + interval '1 month - 1 day')::date
  end;
$$;

-- Monto de una reserva según la regla (sin cuota): puro, sin leer tablas.
create or replace function public.monto_por_regla(
  p_regla public.reglas_comision, p_base_centavos bigint, p_personas int)
returns bigint language plpgsql immutable set search_path = ''
as $$
declare
  v_monto bigint := p_regla.monto_centavos;
  v_esc jsonb;
begin
  if p_regla.tipo = 'porcentaje' then
    return round(p_base_centavos * p_regla.porcentaje_bp / 10000.0);
  end if;
  if p_regla.escalones_personas is not null then
    for v_esc in select * from jsonb_array_elements(p_regla.escalones_personas)
                 order by (value->>'desde')::int loop
      if coalesce(p_personas, 1) >= (v_esc->>'desde')::int then
        v_monto := (v_esc->>'monto_centavos')::bigint;
      end if;
    end loop;
  end if;
  return coalesce(v_monto, 0);
end;
$$;

-- Dentro de caja_liquidar_cuenta (reemplaza el bloque "if v_res.source =
-- 'rp' ..."). v_fecha = fecha operativa de la noche; v_base = consumo de
-- la cuenta; v_cuenta.personas = tamaño del grupo.
--
--   v_regla := public.regla_comision_vigente(v_club.id, v_cuenta.rp_id, v_fecha);
--   if v_regla.id is null then return; end if;   -- antro sin regla: no hay comisión
--   v_desde := public.inicio_periodo(v_regla.periodo, v_fecha);
--   v_hasta := public.fin_periodo(v_regla.periodo, v_fecha);
--   perform pg_advisory_xact_lock(hashtextextended(v_cuenta.rp_id::text || '|' || v_desde::text, 0));
--
--   -- Debajo del consumo mínimo: no paga y (decisión pendiente) no cuenta.
--   if v_base < v_regla.consumo_minimo_centavos then
--     v_centavos := 0; v_numero := null;
--   else
--     select count(*) + 1 into v_numero
--     from public.commissions c join public.reservations r on r.id = c.reservation_id
--     where c.tipo = 'rp' and c.rp_id = v_cuenta.rp_id and r.club_id = v_club.id
--       and c.status <> 'anulada' and c.numero_en_periodo is not null
--       and r.fecha between v_desde and v_hasta;
--     v_centavos := case
--       when v_regla.tipo = 'cuota' and v_numero <= v_regla.cuota then 0
--       else public.monto_por_regla(v_regla, v_base, v_cuenta.personas)
--     end;
--   end if;
--
--   insert into public.commissions (reservation_id, rp_id, tipo, monto, status, regla_id, numero_en_periodo)
--   values (v_res.id, v_cuenta.rp_id, 'rp', round(v_centavos / 100.0, 2), 'pendiente', v_regla.id, v_numero)
--   on conflict (reservation_id) do nothing;

-- Cambiar la regla: cierra la vigente y abre la nueva. Solo dueño, gerente
-- o admin. La nueva vale desde el inicio del SIGUIENTE periodo (no se
-- cambia la regla a media semana: ver "Casos borde").
create or replace function public.cambiar_regla_comision(
  p_club uuid, p_rp uuid, p_tipo text, p_periodo text, p_cuota int,
  p_porcentaje_bp int, p_monto_centavos bigint, p_consumo_minimo_centavos bigint,
  p_escalones jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_hoy date := public.club_fecha_operacion(p_club, now());
  v_actual public.reglas_comision;
  v_desde date;
  v_id uuid;
begin
  if not (public.current_role_name() = 'admin' or public.club_es_dueno(p_club)
          or (public.current_role_name() = 'gerente' and public.current_club_id() = p_club)) then
    raise exception 'No tienes permiso para cambiar las reglas de pago';
  end if;
  select * into v_actual from public.reglas_comision
  where club_id = p_club and rp_id is not distinct from p_rp and vigente_hasta is null
  for update;
  v_desde := case when v_actual.id is null then v_hoy
                  else public.fin_periodo(v_actual.periodo, v_hoy) + 1 end;
  if v_actual.id is not null then
    update public.reglas_comision set vigente_hasta = v_desde - 1 where id = v_actual.id;
  end if;
  insert into public.reglas_comision (club_id, rp_id, tipo, periodo, cuota, porcentaje_bp,
    monto_centavos, consumo_minimo_centavos, escalones_personas, vigente_desde)
  values (p_club, p_rp, p_tipo, p_periodo, coalesce(p_cuota, 0), p_porcentaje_bp,
    p_monto_centavos, coalesce(p_consumo_minimo_centavos, 0), p_escalones, v_desde)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.cambiar_regla_comision(uuid, uuid, text, text, int, int, bigint, bigint, jsonb) from public, anon;
grant execute on function public.cambiar_regla_comision(uuid, uuid, text, text, int, int, bigint, bigint, jsonb) to authenticated;

-- Migración de la configuración actual (una vez). Ojo: desbloqueo D →
-- cuota D − 1 (ver sección 2).
insert into public.reglas_comision (club_id, rp_id, tipo, periodo, cuota, porcentaje_bp, monto_centavos, vigente_desde)
select c.id, null,
       case when coalesce(c.comision_desbloqueo_reservas, 0) > 1 then 'cuota'
            when c.comision_tipo = 'porcentaje' then 'porcentaje' else 'fijo' end,
       'semana',
       greatest(coalesce(c.comision_desbloqueo_reservas, 0) - 1, 0),
       case when c.comision_tipo = 'porcentaje' then round(c.comision_monto * 100) end,
       case when c.comision_tipo = 'fijo' then round(c.comision_monto * 100) end,
       date '2026-01-01'
from public.clubs c
where c.pago_rp_modo = 'reserva';
-- (Lo mismo para rp_comision_overrides con rp_id = o.rp_id.)
-- PENDIENTE de diseño: una cuota con porcentaje (las primeras N no pagan y
-- desde la N+1 se paga un %). Hoy el código lo permite; el check de arriba
-- lo tendría que admitir con tipo = 'cuota' y porcentaje_bp.
```

`rp_progreso_cuota()` pasaría a leer `regla_comision_vigente` y sus
límites de periodo. Devolvería "sin cuota" cuando `tipo <> 'cuota'`, y en
otro caso `cuota`, `llevas` y el periodo (no solo la semana).

### 3.2 Rollback de la propuesta

```sql
-- Revertir caja_liquidar_cuenta y rp_progreso_cuota a su versión de
-- sql/2026-11-20-caja-por-mesa.sql / sql/2026-11-21-rp-panel.sql, y luego:
drop function if exists public.cambiar_regla_comision(uuid, uuid, text, text, int, int, bigint, bigint, jsonb);
drop function if exists public.monto_por_regla(public.reglas_comision, bigint, int);
drop function if exists public.regla_comision_vigente(uuid, uuid, date);
drop function if exists public.fin_periodo(text, date);
drop function if exists public.inicio_periodo(text, date);
alter table public.commissions drop column if exists numero_en_periodo, drop column if exists regla_id;
drop table if exists public.reglas_comision;
```

Las columnas viejas de `clubs` no se borran hasta que el modelo nuevo lleve
semanas funcionando. Así el rollback es inmediato.

## 4. Integración con el cuadre y la nómina

- **Cuadre**: nada cambia para el staff. La comisión sigue naciendo al
  cuadrar la mesa, una vez por cuenta, con el consumo de esa cuenta. Lo
  único nuevo es que se elige la regla vigente para la noche y su periodo.
- **Nómina semanal (lunes a domingo)**: `nomina_semana_datos` ya suma las
  comisiones por la fecha de la reserva. Con periodo **noche** o **semana**
  cada cuota cabe en una semana de nómina. Con periodo **mes**, la cuota se
  cuenta a lo largo del mes, pero cada comisión se **paga en la semana de
  su noche**. Ejemplo: si la 5.ª reserva del mes cae el jueves de la segunda
  semana, esa semana de nómina es la primera con monto. La nómina no cambia;
  solo hay que explicarlo en la pantalla ("cuota del mes: 3 de 4").
- **Panel del RP**: la tarjeta de progreso ya consume `rp_progreso_cuota()`.
  Solo cambia el texto del periodo ("esta semana" / "esta noche" / "este
  mes").
- **Gerente y dueño**: la pantalla "Reglas de pago de RPs"
  (`components/reglas-pago-rp.tsx`) pasaría a llamar
  `cambiar_regla_comision` y mostraría desde cuándo vale la nueva regla.

## 5. Casos de prueba

Todos en dev, con un RP con cuota N = 4 y periodo semana, salvo que se diga
otra cosa.

| # | Caso | Esperado |
|---|---|---|
| 1 | 4 reservas que consumen | Las 4 con comisión $0, `numero_en_periodo` 1–4 |
| 2 | La 5.ª consume | Paga $X; progreso "Cuota alcanzada" |
| 3 | Lunes siguiente, 1.ª reserva | Vuelve a $0 (la cuota se reinicia) |
| 4 | Reserva del domingo cuadrada el lunes a las 03:00 | Cuenta para la semana del domingo (noche operativa) |
| 5 | Reserva que llega y no consume ($0) | Sin comisión y no cuenta |
| 6 | Consumo debajo del mínimo | No paga; cuenta o no según la respuesta a la pregunta 2 |
| 7 | Grupo de 6 con escalones 1–4 $100 / 5+ $200 | Paga $200 (si ya pasó la cuota) |
| 8 | **Reserva anulada**: se anula (con motivo) la comisión de la 2.ª después de pagada la 5.ª | La anulada deja de contar. La 5.ª ya calculada **no** se recalcula sola: ver riesgos |
| 9 | **Mesa reabierta**: cerrada → reabierta → se agregan consumos → cuadrada | Una sola comisión, con el consumo final (nace al cuadrar, no al cerrar) |
| 10 | Mesa cuadrada que se intenta reabrir | La base lo impide (solo se reabre una mesa cerrada) |
| 11 | **Regla cambiada a media semana** (de 10 % a cuota N = 4) | La nueva vale desde el lunes siguiente; lo de esta semana sigue con 10 % |
| 12 | Dos cuadres simultáneos del mismo RP | Números 4 y 5, nunca dos 5 (candado por RP y periodo) |
| 13 | RP dado de baja a media semana | Sus reservas ya hechas que consuman siguen generando comisión (él las trajo) |
| 14 | Regla personalizada del RP y del antro | Gana la del RP |
| 15 | Staff intenta leer `reglas_comision` | 0 filas |
| 16 | Antro en modo `dia` | No usa estas reglas; sigue el pago por día |
| 17 | Periodo mes, cuota 10: la 11.ª cae en otra semana | Paga en la nómina de esa semana |

## 6. Riesgos

1. **Confundirse por uno en la migración.** Hoy el desbloqueo D significa
   "la D-ésima ya paga". Si se copia D tal cual como cuota, cada RP pierde
   una comisión por semana. La migración usa D − 1 y hay que revisarla
   antes antro por antro.
2. **Anulaciones sin recálculo.** Si se anula una comisión que contaba, las
   siguientes del mismo periodo quedaron calculadas con el número viejo.
   Propuesta: al anular, recalcular las comisiones **pendientes** del mismo
   RP y periodo (nunca las `validada` o `pagada`), con evento en la
   bitácora. Si no se hace, hay que dejarlo escrito como regla ("el número
   se fija al cuadrar").
3. **Orden dentro de la noche.** Con cuota, la reserva que "pasa" la cuota
   es la que se **cuadra** primero, no la que llegó primero. Con monto fijo
   da igual. Con porcentaje o escalones, el RP cobra distinto según el orden
   de cuadre. Hay que avisarlo o fijar el orden por hora de llegada.
4. **Cambiar la regla a media semana.** Si se permite que valga de
   inmediato, la cuota de esa semana mezcla dos reglas. La propuesta lo
   evita: el cambio vale desde el siguiente periodo.
5. **El staff lee hoy la configuración de comisión** (deuda 9). Se resuelve
   con la tabla nueva, pero solo cuando se dejen de leer las columnas viejas
   de `clubs` (y luego se vacíen o se muevan).
6. **Consumo que entra después del cuadre.** Hoy no se puede, porque la
   mesa cuadrada queda bloqueada. Si algún día se permite corregir una mesa
   cuadrada, habrá que anular y recalcular su comisión.

## 7. Preguntas abiertas para el cliente

1. **Periodo de la cuota**: ¿las primeras 4 reservas que no pagan se
   cuentan por **noche**, por **semana** (lunes a domingo) o por **mes**?
2. **Consumo mínimo**: ¿hay un consumo mínimo para que una reserva pague?
   Y si una reserva consume menos que eso, ¿cuenta para llegar a la cuota
   o no?
3. **Tamaño del grupo**: ¿el monto por reserva cambia según cuántas
   personas trae (por ejemplo, $100 para 1–4 y $200 para 5 o más), o es el
   mismo para cualquier grupo?
