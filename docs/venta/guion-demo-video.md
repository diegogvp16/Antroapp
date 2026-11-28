# Guion del video demo (3 minutos)

Video para dueños y gerentes de antros. **Solo muestra lo que ya funciona en
producción** (antroapp.vercel.app, rama `master`, pase 1), con el antro de
demostración **Club Demo** y datos ficticios.

Nada del pase 2 ni del pase 3: no se graba una vista previa de `post-junta-*`,
porque ahí salen pantallas que todavía no existen en producción.

## Cuentas (producción, Club Demo)

Las contraseñas no van en este documento.

| Papel | Cuenta | Contraseña en | Dispositivo |
|---|---|---|---|
| Cliente | sin cuenta (reserva como invitado) | — | Teléfono B |
| RP | `demo_mariana@example.com` | `backups/2026-11-12-club-demo-credenciales.json` | Teléfono B (otro navegador o la app "Antro RP") |
| Staff | `staff.demo@example.com` | `backups/2026-11-24-prod-cuentas-demo.json` | Teléfono A |
| Gerente | `gerente.demo@example.com` | `backups/2026-11-24-prod-cuentas-demo.json` | Teléfono A (otro navegador) o teléfono C |
| Dueño de grupo | `dueno.grupo.demo@example.com` (ve Club Demo y Club Demo Tijuana) | `backups/2026-11-24-prod-cuentas-demo.json` | Laptop |

El enlace de reserva sin cuenta es
`https://antroapp.vercel.app/cliente/reservar?club=d2f531df-8116-442e-b967-4a1004fcd02e`.
No pasa por el catálogo ni por la ficha: esas dos piden cuenta y muestran las
fotos.

## Escenas

Unas 400 palabras de voz en total: frases cortas, con pausas. Los nombres de
botones van tal como salen en pantalla.

### 1. Apertura · 0:00–0:12

- **Pantalla:** el teléfono A en `/staff/panel` (staff), con la lista de
  reservas de la noche. Texto sobre el video: «Datos de demostración».
- **Voz:** «Al cierre de la noche, ¿sabes qué reservas trajo cada RP, cuántas
  llegaron y cuánto consumieron? AntroApp lo junta en el teléfono, de la
  reserva a la nómina.»

### 2. El cliente reserva · 0:12–0:40

- **Pantalla:** teléfono B, sin sesión, en el enlace de reserva de arriba.
  1. Llenar Nombre (ficticio, por ejemplo «Andrea Ruiz»), Teléfono
     **0000000123**, Fecha (la noche de la grabación) y personas (4).
  2. Enviar. Sale **¡Reserva confirmada!** con el QR y el botón **Compartir
     por WhatsApp**. Solo enseñar el botón: no enviar a nadie.
  3. Abrir el boleto (`/r/<código>`). Se ve el QR y el aviso «El QR aparta tu
     lugar, pero no garantiza la entrada…».
- **Voz:** «Tu cliente aparta en segundos, sin bajar nada y sin pagar. Recibe
  su QR y lo comparte por WhatsApp. El QR aparta lugar, pero tú conservas tu
  derecho de admisión.»

### 3. El RP ve lo suyo · 0:40–1:02

- **Pantalla:** teléfono B con `demo_mariana`, en `/rp/panel`, pestaña
  **Reservas**.
  1. Periodo **Esta semana**: la tarjeta de cuota y la lista con sus estados.
  2. Filtro **Consumieron**. Tocar una reserva y enseñar la línea de tiempo y
     **Mi comisión**.
- **Voz:** «Cada RP crea reservas para sus clientes y ve en qué quedó cada una:
  consumió, llegó sin consumo, no llegó o por llegar. Ve su cuota de la semana
  y lo que va ganando. Solo lo suyo.»

### 4. La puerta · 1:02–1:25

- **Pantalla:** teléfono A con `staff.demo`, en `/staff/panel`.
  1. **Escanear QR**, apuntando al boleto de la escena 2 en el teléfono B.
  2. Sale la reserva: nombre, personas y «Orgánica».
  3. **Confirmar entrada** y luego **¡Entrada confirmada!**.
  4. Tocar **Sentar en mesa**.

  Grabar la pantalla del teléfono A y, si se puede, una toma de cámara del
  escaneo.
- **Voz:** «En la puerta, el staff escanea y confirma. Si la cámara falla,
  puede confirmar desde la lista. Un QR que ya entró no deja pasar a otro
  grupo.»

### 5. La caja por mesa · 1:25–1:58

- **Pantalla:** teléfono A (staff), en `/staff/caja`.
  1. El mapa de mesas con **Todas**, **Abiertas**, **Por cuadrar** y
     **Libres**.
  2. Mesa libre («Toca para recibir»), **Recibir grupo**, **Con reserva**:
     elegir a Andrea y tocar **Sentar en la mesa**.
  3. **Agregar consumo**: un concepto, su precio y su cantidad, y tocar
     **Agregar a la mesa · $…**.
  4. **Cobrar $…**, **Efectivo** y **Cobrar**. Luego **Cerrar mesa**. Sale
     «Pagada y cerrada. Falta que el gerente la cuadre.».
  5. Corte de 3 segundos: la mesa abierta que tiene un cargo anulado. Tocar
     «1 cargo anulado» para que se vea con su motivo, «Capturada dos veces por
     error».
- **Voz:** «En la caja, cada mesa lleva su cuenta, con uno o varios grupos, y
  cada uno con su RP. Se registra el consumo y se cobra. Nada se borra: un
  error se anula con motivo y queda quién lo hizo.»

### 6. El gerente cuadra · 1:58–2:15

- **Pantalla:** gerente (`gerente.demo`), en `/staff/caja`, en la mesa de la
  escena 5.
  1. **Cuadrar mesa** y **Cuadrar mesa · $…**. Queda **Cuadrado · no se
     modifica**.
  2. Pestaña **Cuadre de la noche**: enseñar el conteo físico y la diferencia.
     **No tocar «Cerrar la noche»** (advertencia 3).
- **Voz:** «El gerente cuadra la mesa y ya no se modifica. En ese momento nace
  la comisión del RP, con lo que consumió su cliente. Al final, el cuadre de
  la noche contra el conteo físico.»

### 7. La nómina de RPs · 2:15–2:32

- **Pantalla:** gerente, en `/staff/nomina`.
  1. Con **‹**, ir a la semana anterior: una tarjeta por RP con sus montos y
     estados (pendiente, en revisión, validada, pagada).
  2. Enseñar **Exportar CSV**, sin bajar nada. **No tocar «Marcar pagada»**:
     no se puede regresar.
- **Voz:** «La nómina de RPs sale sola, semana por semana. Tú les pagas en tu
  nómina: el dinero no pasa por AntroApp. La app lo calcula para que tú y tus
  RPs tengan el mismo número.»

### 8. El dueño ve todo · 2:32–2:50

- **Pantalla:** laptop con `dueno.grupo.demo`, en `/grupo`.
  1. **Esta semana**: los totales del grupo.
  2. Cambiar a **Semana anterior**: el porcentaje de conversión, que solo se
     calcula con noches cerradas.
  3. Abrir **Rendimiento por RP**.
- **Voz:** «Y el dueño ve sus antros en una sola pantalla: reservas, cuántas
  entraron y consumieron, consumo en caja y qué RP trae gente que sí
  consume.»

### 9. Cierre · 2:50–3:00

- **Pantalla:** la pantalla de inicio del teléfono con los íconos **Antro
  Staff**, **Antro RP** y **Antro Dueño** instalados. Tarjeta final:
  «AntroApp · Prueba en tu antro · [contacto por definir]».
- **Voz:** «Se instala desde el navegador, en los teléfonos que ya tienes. Tus
  clientes no pagan nada. Platiquemos de tu antro.»

El precio no se menciona en el video: está **[por definir]**.

## Qué datos deben estar cargados

Salen de `scripts/demo-datos.mjs`, corrido para la noche de la grabación:

- **La noche de la grabación:**
  - 40 reservas: 27 con entrada, mesa y consumo, y 13 por llegar;
  - caja con mesas abiertas, cerradas y cuadradas, y mesas con 2 o 3 grupos;
  - un consumo anulado con motivo («Capturada dos veces por error»), en una
    mesa abierta.
- **La semana anterior:** jueves, viernes y sábado, todo cuadrado y con
  comisiones pendientes, para la nómina y la conversión de `/grupo`.
- **Al menos una mesa libre** en Club Demo (hay 29 mesas).
- Las RPs `demo_*` con turno fijo y con sus reglas: Mariana, $150 fijo.

No decir cifras en la voz, salvo las que imprima `demo-datos` ese día.

## Preparación

**El día anterior**

- [ ] Elegir la fecha y la hora de la grabación. La caja solo opera la noche
      en curso, que va de las 08:00 de ese día a las 07:59 del siguiente.
- [ ] Decidir quién corre los scripts. `demo-datos` en producción **escribe
      en la base**: lo corre Diego o lo autoriza de forma explícita, como el
      25/11.
- [ ] Ensayar el guion completo una vez, con cronómetro.
- [ ] Cargar los teléfonos al 100 %.
- [ ] Instalar las apps: «Antro Staff» en el teléfono A, «Antro RP» en el B y
      «Antro Dueño» o el navegador en la laptop.
- [ ] Probar el escáner del teléfono A con el boleto en pantalla y en papel.

**El día de la grabación, después de las 08:00**

1. **Limpiar la caja de la demo anterior.** En producción la caja no se borra
   por la API. Diego pega `sql/limpiar-demo-caja.sql` en el SQL Editor; solo
   toca Club Demo. Sin este paso, `demo-datos` se detiene con «Hay N cuentas
   de caja de una demo anterior».
2. **Simular:** `node scripts/demo-datos.mjs --fecha=AAAA-MM-DD`. Revisar el
   resumen. Sin `--fecha` usa el 2026-11-25.
3. **Escribir:** `node scripts/demo-datos.mjs --fecha=AAAA-MM-DD --si`.
   Anotar el resumen por noche que imprime.
4. **Iniciar sesión** en cada dispositivo, con su cuenta, antes de grabar.
   Cinco contraseñas malas bloquean el correo 15 minutos.
5. **Abrir cada pantalla una vez**, en el orden del guion.
6. **Preparar los teléfonos:**
   - modo No molestar y notificaciones limpias;
   - brillo al máximo y rotación bloqueada en vertical;
   - grabación de pantalla del sistema lista.
7. **Si hay que repetir una toma** que ya cuadró una mesa, usar otra mesa
   libre. Si se acaban, repetir los pasos 1 a 3.

**Después de grabar**

- Las reservas de la grabación llevan teléfono `0000000…`: la siguiente
  corrida de `demo-datos` las borra. No hace falta limpiar nada a mano.
- Revisar el video cuadro por cuadro con las advertencias de abajo.

## Advertencias

1. **Las fotos de Club Demo son de SIX GDL** (CLAUDE.md §7). No deben salir
   en un video público. Esto deja fuera estas pantallas:
   - `/cliente` (catálogo);
   - `/cliente/[clubId]` (ficha);
   - la galería de `/dueno/panel`;
   - `/para-clubes`;
   - las capturas `01` a `03` de `screenshots-presentacion/`.

   Para enseñar la ficha, antes hay que poner fotos propias
   (`demo-assets/club-demo/LEEME.md`) o difuminarlas en la edición. Las demás
   pantallas del guion no muestran fotos.
2. **Nada que no esté en producción.** No grabar en una vista previa ni en
   dev. No enseñar ni mencionar:
   - la linterna;
   - guardar sin señal;
   - el cierre de la noche en PDF o CSV;
   - invitaciones;
   - POS, lista negra, mensajes de WhatsApp, reportes PDF, inventario o
     propinas;
   - `/admin/funciones`.

   Sin señal, la caja de producción solo avisa «Sin conexión» y espera:
   **no decir que se puede seguir capturando**.
3. **Acciones que no se deshacen:**
   - **«Cerrar la noche»:** bloquea la noche, pasa las reservas que faltan a
     «No llegó» y ya no deja grabar más tomas.
   - **«Marcar pagada»** en la nómina.
   - **«Cuadrar mesa»**, que sí se hace en el guion, pero en una mesa por
     toma.
4. **No enseñar** estas pantallas:
   - los inicios de sesión (correos), las contraseñas y la barra de
     autocompletar del navegador;
   - `/admin`: ahí aparecen Panic Room, un negocio real sin autorización, y
     los errores recientes;
   - la cuenta **RP Demo**, que es la cuenta Gmail real de Diego;
   - el formulario «Mis RPs» con correos escritos.
5. **Solo teléfonos ficticios** (`0000000…`) en cualquier reserva que se cree
   en cámara. Con un número real, la reserva no se limpia y además es un dato
   personal.
6. **WhatsApp:** enseñar solo el botón o el mensaje armado. No enviarlo a un
   contacto real ni dejar ver la lista de chats.
7. **Escáner:** se probó con cámara simulada, también con poca luz, no con
   este teléfono en esta luz. Ensayar antes. Si no lee, hay un respaldo que
   también existe en producción: «Cerrar escáner» y luego «Confirmar entrada
   sin cámara» en la tarjeta del cliente.
8. **`/grupo` en «Esta semana»** muestra la conversión como «—», porque la
   noche sigue abierta. Para el porcentaje, «Semana anterior».
9. **Club Demo Tijuana** sale en `/grupo` del dueño de grupo. Es un antro
   demo oculto: no tiene ficha pública y no se debe decir que es un cliente.
10. **Precio:** no mencionarlo, ni la cifra acordada con el socio. En el
    video va «[por definir]» o nada.
