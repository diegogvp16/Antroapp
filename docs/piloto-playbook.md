# Piloto operativo — 2 semanas en un antro real

> Para Diego y el socio. Plan de un piloto con **un** antro.
>
> - **Las cifras de los criterios** (sección 6) son una **propuesta** para
>   discutir antes de empezar. No salen de datos reales: todavía no hay
>   ninguno.
> - **Durante el piloto no se cobra nada:** la mensualidad sigue simulada
>   (CLAUDE.md §4).

## 0. Requisitos antes del día 1 (sin esto no se empieza)

| # | Requisito | Dónde se ve | Por qué |
|---|---|---|---|
| R1 | **Pase 2 en producción**, con el Q10b | `docs/pase-2.md` | Trae el cierre de la noche y su reporte, las invitaciones del personal, la importación de mesas y RPs por CSV, y la baja de personal. Hoy producción solo tiene el pase 1 |
| R2 | Aviso de privacidad revisado por un abogado y publicado (`NEXT_PUBLIC_LEGALES`) | `docs/privacidad-datos.md`, `docs/legal/README.md` | Se guardan nombres y teléfonos de clientes reales |
| R3 | Prueba en teléfonos reales hecha, sin ✘ graves | `docs/prueba-telefonos.md` | Hasta hoy nada se ha probado en un teléfono físico |
| R4 | Acuerdo escrito con el antro: alcance, duración y quién paga a los RPs | — | La comisión la paga el antro en su nómina; la app solo la calcula |
| R5 | Respaldo visible en Supabase y exportación de Storage probada | `docs/recuperacion.md` | Por si hay que restaurar a media semana |
| R6 | Monitor externo de `/api/salud` encendido | `docs/operacion.md` | Para enterarse de una caída antes que el antro |
| R7 | Datos reales del antro listos: mesas, RPs con correo, gerentes y staff, horario y reglas de comisión | — | Se cargan en el día −3 |

**Pase 3 (banderas): opcional.** El piloto puede hacerse solo con lo del
pase 2. Encender algo del pase 3 en la semana 2 es una decisión aparte, con
la función encendida solo para ese antro (`/admin/funciones`) y una por una.

## 1. Cronograma

Las noches de operación dependen del antro. El plan asume **jueves, viernes
y sábado**; si abre otros días, se recorre.

| Día | Qué | Quién |
|---|---|---|
| −7 | Junta de arranque: alcance, requisitos R1–R7, quién es el contacto del antro en cada noche | Diego, dueño |
| −5 | Alta del antro en `/admin`, con el asistente: datos, reglas de comisión y RPs. Verificado y con suscripción activa (simulada) | Diego |
| −3 | Carga de mesas (CSV) y personal: invitaciones a gerentes, staff y RPs, o en lote. Turnos fijos de los RPs | Diego, gerente |
| −2 | **Capacitación de 1 h** con gerentes y staff (`docs/manual-staff.md`) y de 30 min con RPs (`docs/manual-rp.md`). Cada quien instala la app en **su** teléfono y entra | Diego |
| −1 | **Ensayo en seco:** 10 reservas de prueba (una por RP), escanear, sentar, consumo, cobro, cuadrar y cerrar la noche de prueba. Revisar que el reporte cuadre. Ver «El día antes» | Diego, gerente, 2 staff |
| Semana 1 (jue–sáb) | **Operación en paralelo:** la app y el método de siempre del antro (lista y caja de siempre) a la vez. Diego está en la puerta las 3 noches | Todos |
| Lunes semana 2 | **Revisión de la semana 1** (45 min): métricas, incidencias, ajustes. Primera nómina de RPs comparada con la del antro | Diego, dueño, gerente |
| Semana 2 (jue–sáb) | **Operación con la app como fuente principal** (el método viejo solo de respaldo). Diego, la primera noche; después, solo a distancia | Todos |
| Lunes semana 3 | **Cierre del piloto** (sección 5) y decisión: seguimos, ajustamos o paramos | Diego, socio, dueño |

## 2. El día antes de cada noche (o el día −1)

- [ ] `/api/salud` en verde y sin errores nuevos en el panel de salud del admin.
- [ ] Turnos de la noche asignados: «RPs con turno hoy» en el panel de staff.
- [ ] Cada gerente y staff entra en **su** teléfono con **su** cuenta. Nada de cuentas compartidas.
- [ ] Las reservas de mañana aparecen en el panel (con **Actualizar**).
- [ ] Hay un teléfono de repuesto cargado con la app instalada y una batería externa en la puerta.
- [ ] Revisar con el gerente quién cuadra y quién cierra la noche (permisos de caja).
- [ ] Contacto de Diego visible para el gerente: a quién llamar si algo falla.

## 3. Cada noche

**Antes de abrir (−1 h)**
- [ ] Staff de puerta con la app abierta en el panel, con señal. Ahí se baja la copia de la noche, si el escáner de respaldo está encendido.
- [ ] Probar un escaneo con una reserva real del día.
- [ ] El gerente revisa en la caja que las mesas estén libres.

**Durante**
- [ ] Anotar cada incidencia en una nota compartida: hora, quién, qué pantalla, qué salió y una captura si se puede.
- [ ] Si se cae la señal: seguir el manual (consumos y cobros se guardan en el teléfono; abrir, sentar, cerrar y cuadrar esperan la señal).
- [ ] **Semana 1:** todo se anota también en el método de siempre.
- [ ] Cronometrar 10 entradas en la puerta (de mostrar el QR a «¡Entrada confirmada!»).

**Cierre (al cerrar el antro)**
- [ ] Todas las mesas cuadradas («Mesas pendientes de cuadrar» en 0).
- [ ] Conteo físico (efectivo, tarjeta, otro) y **Cerrar la noche**. Anotar la **Diferencia** que da la app.
- [ ] El gerente abre **Ver el cierre de la noche** y lo baja en CSV.
- [ ] **Semana 1:** comparar el total de la app contra el de la caja de siempre. Anotar la diferencia y su causa.
- [ ] Ningún aviso de «movimiento no se guardó» sin atender.

**A la mañana siguiente, después de las 08:00** (Diego, unos 15 min, con la revisión diaria de `docs/operacion.md`)
- [ ] Salud y errores de la noche.
- [ ] Registrar las métricas de la noche (sección 4).
- [ ] Contestar o arreglar las incidencias anotadas. Lo que pida cambiar código va a una rama y **no** se publica a media semana, salvo que sea un error que impida operar.

## 4. Métricas

Por noche, en una hoja. Casi todo sale de la app: cierre de la noche, `/grupo`
y nómina. Lo marcado *a mano* se anota en la noche.

| Métrica | De dónde sale | Para qué |
|---|---|---|
| Reservas de la noche (orgánicas y de RP) | `/grupo`, cierre de la noche | Uso real |
| Entradas confirmadas y conversión (entradas / reservas) | `/grupo` | Que la puerta registre de verdad |
| No llegó | Cierre de la noche | Base para la política de no-show |
| Mesas abiertas y cuadradas; consumo total | Caja, cierre de la noche | Que la caja se use en todas las mesas |
| **Diferencia del conteo físico** al cerrar la noche | Cuadre de la noche | Confianza en los números |
| Diferencia contra el método de siempre (semana 1) | *A mano* | Lo mismo, contra lo que el antro ya conoce |
| Anulaciones y reaperturas, con motivo | Actividad del gerente, cierre | Errores de captura y posibles abusos |
| Movimientos guardados sin señal y «no se guardó» | *A mano* (avisos de la caja) | Qué tan seguido falla la red en ese antro |
| Tiempo por entrada en la puerta (mediana de 10) | *A mano* | Que la puerta no se haga lenta |
| Errores de la app en la noche | Panel de salud del admin | Fallas técnicas |
| Comisiones de RP de la semana contra lo que el antro calcula a mano | Nómina | Que ambos tengan el mismo número |
| RPs con al menos una reserva en la semana | Rendimiento por RP (`/grupo`) | Adopción de los RPs |
| Incidencias por gravedad (impide operar / estorba / detalle) | *A mano* | Lista de arreglos |
| Opinión del gerente y del staff (1 a 5) y un comentario | *A mano*, al cierre de cada semana | Si lo quieren seguir usando |

## 5. Cierre del piloto (lunes de la semana 3)

1. Tabla de métricas de las 6 noches y su tendencia de la semana 1 a la 2.
2. Lista de incidencias: resueltas, pendientes y cuáles impiden operar.
3. Entrevista corta, por separado, con el dueño, un gerente, un staff y dos RPs: qué les ahorró, qué les estorbó y qué falta.
4. Nómina: ¿la de la app coincidió con la del antro?
5. Decisión (sección 6) y siguiente paso por escrito.
6. Si se para: respaldo del antro y su baja según lo acordado (los datos del piloto no se quedan sin acuerdo; ver `docs/privacidad-datos.md`).

## 6. Criterios: seguimos / ajustamos / paramos

**Propuesta** para acordar con el socio y con el antro **antes** del día 1.

**Seguimos** (pasar a operación normal y hablar de la mensualidad), si se
cumple todo:
- en la semana 2 el antro operó la puerta y la caja con la app las 3 noches, sin volver a su método de siempre;
- diferencia del conteo físico al cerrar cada noche: $0, o explicada en las notas;
- semana 1: la diferencia contra el método de siempre es explicable movimiento por movimiento;
- la nómina de RPs de la app coincide con la del antro, o la diferencia sale de una regla mal configurada y ya se corrigió;
- ninguna incidencia que impida operar sigue abierta;
- el gerente pone 4 o más y quiere seguir.

**Ajustamos** (una o dos semanas más, con cambios concretos), si:
- funcionó, pero hay incidencias que estorban: lentitud en la puerta, pantallas que confunden, una regla de comisión que no se puede expresar…;
- o hubo diferencias de dinero con una causa conocida y que se puede arreglar;
- o la adopción de los RPs es baja, pero la puerta y la caja funcionan.

**Paramos** (y se revisa a fondo antes de otro piloto), si pasa cualquiera:
- una diferencia de dinero que no se puede explicar;
- datos que se pierden (un consumo o un cobro que no llegó y nadie se enteró);
- dos noches en las que el antro tuvo que dejar la app a media operación;
- un problema de privacidad o de acceso: alguien vio datos que no debía;
- el antro no quiere seguir.

## 7. Qué no prueba este piloto

- El cobro de la mensualidad: sigue simulado.
- Varios antros a la vez ni grupos de antros.
- Lo que esté detrás de banderas que no se enciendan.
