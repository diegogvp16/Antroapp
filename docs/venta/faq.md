# Preguntas frecuentes de dueños y gerentes

Respuestas cortas y honestas. Cada respuesta dice si lo que describe ya
funciona o todavía no:

- **[Hoy]**: ya funciona en la app publicada.
- **[Próximamente]**: ya está hecho y probado, falta publicarlo.
- **[Opcional, próximamente]**: igual que el anterior, y además se enciende solo en los antros que lo pidan. Viene apagado.

---

### 1. ¿Qué datos de mis clientes guarda AntroApp y quién los ve?

**[Hoy]** De cada reserva se guardan el nombre y el teléfono, la fecha, las
personas, la hora de entrada y, de la caja, cuánto consumió y cómo pagó:
efectivo, tarjeta u otro. Nunca se guardan los datos de la tarjeta. Si el
cliente crea cuenta, también su correo. No se guardan su fecha de nacimiento,
su identificación ni su ubicación: la ubicación solo se usa en su teléfono
para ordenar los antros por cercanía.

Quién los ve:

- tu antro: staff, gerente y dueño;
- el RP, solo las reservas que él creó;
- el equipo de AntroApp, para dar soporte.

**Ningún otro antro ve tus datos.** El boleto que el cliente comparte muestra
nombre, fecha, antro y personas, sin teléfono. Esto lo cuida la base de datos,
con reglas por antro y por rol, y se probó con cuentas reales de cada rol.

### 2. ¿Tienen aviso de privacidad?

**Todavía no está publicado.** El aviso de privacidad, los términos y el
contrato con el antro están en borrador y los está revisando un abogado.
Las páginas ya están hechas y se publican cuando el texto esté aprobado.

La información vive en Supabase (la base de datos) y en Vercel (la página).
En qué país quedan los servidores: **[por confirmar]**.

### 3. ¿A mis clientes les cuesta algo? ¿Tienen que bajar una app o crear cuenta?

**[Hoy]** No pagan nada: la app no cobra la reserva ni el cover. Si tienes
cover, solo se informa en la ficha y lo cobras tú en la puerta.

No necesitan bajar nada: todo es desde el navegador. Con el enlace de reserva
de tu antro pueden apartar **sin cuenta**. Para ver el catálogo de antros y
la ficha, hoy sí se pide una cuenta de cliente, que es gratis. Con cuenta,
además ven su historial.

### 4. ¿Cómo se calculan las comisiones de los RPs y quién las paga?

**[Hoy]** Las pagas tú, en tu nómina: el dinero no pasa por AntroApp. La app
calcula y registra lo que gana cada RP, para que tú y él tengan el mismo
número.

Eliges una de dos formas:

- **Por reserva:** un monto fijo o un porcentaje de lo que consumió su
  cliente. Puedes poner una cuota semanal (de lunes a domingo). Por ejemplo,
  con cuota de 5, las primeras 4 reservas que consumen no pagan y desde la
  5.ª cada una paga.
- **Por día:** una tarifa por cada día de asistencia confirmada, distinta para
  el 1.º, 2.º, 3.º… día de la semana.

Cómo se calcula:

- La comisión por reserva nace **cuando el gerente cuadra la mesa**, con el
  consumo de la cuenta de ese cliente.
- Si en una mesa hay clientes de dos RPs, cada uno cobra sobre lo de su
  cliente.
- Si el cliente no consumió, no hay comisión.
- Cada pago pasa por **pendiente, en revisión, validada y pagada**. Si hace
  falta, se anula con motivo.

### 5. ¿Puedo pagarle distinto a cada RP, o cambiar la regla?

**[Hoy]** Sí. Pones tarifas individuales a los RPs que no ganan igual, y los
demás siguen la regla del antro. Si cambias la regla, vale para lo que se
cuadre de ahí en adelante: lo ya calculado no cambia.

**[Próximamente]** Un cambio de regla se programa y empieza el lunes
siguiente, para no mover la semana en curso. También eliges qué ve el RP de
sus clientes: solo el estado, el estado y el monto, o también las botellas.

### 6. ¿Quién puede ver los números del antro?

**[Hoy]**

- **El dueño:** todo lo de su antro, o de sus antros juntos si tiene varios.
  Ve el resumen de las noches, la nómina y las reglas de pago.
- **El gerente:** lo mismo, pero solo de su antro.
- **El staff:** la puerta y la caja de la noche. No ve la nómina ni lo que
  gana cada RP.
- **El RP:** solo sus reservas. Ve en qué quedó cada una, el consumo de su
  cliente y lo que lleva ganado. No ve las de otros RPs.

Un detalle técnico que todavía queda pendiente: la regla general de
comisión del antro se guarda junto a los datos del antro. Alguien del staff
con conocimientos técnicos podría leerla. Lo que gana cada RP, no.

### 7. ¿Alguien de mi equipo puede borrar o cambiar un consumo o un cobro?

**[Hoy]** No se puede borrar. Un error se **anula con motivo** y queda
tachado, con quién lo hizo y cuándo. Anular, reabrir, cuadrar y cerrar la
noche son del gerente o del dueño. El staff abre mesas, registra consumos,
cobra y cierra.

Lo que queda fijo:

- Una mesa cuadrada ya no se modifica.
- Una noche cerrada ya no recibe movimientos.
- Esto lo impide la base de datos, no solo la pantalla.

**[Próximamente]**

- El gerente ve la actividad completa: quién cuadró, anuló, reabrió o cerró.
- El gerente puede darle a un staff de confianza permiso para anular, cuadrar
  o cerrar la noche.

### 8. ¿Qué pasa si se va el internet?

**[Hoy]**

- **En la puerta:** escanear y confirmar necesitan señal.
- **En la caja:** sale "Sin conexión · reconectando…" y los botones esperan
  a que vuelva la señal. Lo que ya se guardó no se pierde. Un cobro que el
  teléfono reintenta con mala señal no se cobra dos veces.

**[Próximamente]** Consumos y cobros de mesas abiertas se guardan en el
teléfono y se mandan solos al volver la señal. Límites:

- Abrir mesa, sentar, cerrar y cuadrar siguen necesitando señal.
- Antes de cerrar o cuadrar una mesa, tiene que llegar lo pendiente de esa
  mesa.

**[Opcional, próximamente]** Escáner de respaldo:

- Mientras hay señal, el teléfono de la puerta baja una copia de las
  reservas de la noche.
- Sin señal, valida el QR o el código corto de 6 caracteres del boleto
  contra esa copia. Las entradas se mandan solas al volver la señal.
- Límites: una reserva hecha después de la copia no aparece, y sin copia no
  se puede validar.

Recomendación práctica: ten datos del celular para compartir (hotspot).

### 9. ¿Qué necesito en la puerta?

**[Hoy]**

- Un teléfono con cámara e internet, con permiso de cámara para el navegador.
- La app de staff instalada desde el menú del navegador ("Antro Staff"). No
  se baja de ninguna tienda de apps.
- La sesión iniciada antes de abrir.
- Con poca luz, que el cliente suba el brillo de su pantalla.
- Si la cámara falla, el staff confirma desde la lista de la noche
  ("Confirmar entrada sin cámara"), después de revisar el boleto o una
  identificación.

**[Próximamente]** Un botón para prender la linterna del teléfono, si el
teléfono lo permite.

Lo probamos con una cámara simulada, también con poca luz. Falta probarlo en
tus teléfonos, en tu puerta.

### 10. ¿Qué pasa si un RP se va?

**[Hoy]** El staff o el gerente lo da de baja con un botón. Desde ese momento:

- no puede volver a entrar;
- deja de ver sus reservas y sus comisiones;
- sus reservas, comisiones y nómina se quedan en tu historial, porque nada se
  borra;
- si regresa, se le reactiva.

**Todavía no** se cierra todo: si tenía la app abierta, todavía podría ver
sus propios turnos y pagos por día. Eso se cierra en la próxima
actualización.

**[Próximamente]** Baja del staff y del gerente con motivo, y alta de RPs por
invitación de correo o con una lista en archivo.

### 11. ¿Se conecta con mi punto de venta (POS)?

**Conexión en vivo: no.** **[Opcional, próximamente]** Importar un archivo:

- El gerente o el dueño sube el archivo de ventas que exporta su POS, en CSV
  o Excel, e indica qué columna es cada dato.
- Después compara caja contra POS, mesa por mesa.
- Es un registro aparte para comparar: no cambia la caja, las comisiones ni
  la nómina.
- Tope: 5,000 líneas o 10 MB por archivo.

### 12. ¿Manda mensajes de WhatsApp?

**No manda nada por su cuenta.** Solo abre WhatsApp con el mensaje escrito, y
la persona decide si lo envía.

- **[Hoy]** El cliente y el RP comparten el boleto con "Compartir por
  WhatsApp". El RP tiene "Escribirle" para abrir el chat con su cliente.
- **[Opcional, próximamente]** Textos de tu antro para confirmación,
  recordatorio y aviso de no-show, con un botón en cada reserva.

### 13. ¿Tienen lista negra?

**Hoy no.** **[Opcional, próximamente]** Lista negra y no-show, por antro:

- El gerente o el dueño bloquea un teléfono con motivo obligatorio y, si
  quiere, con fecha de vencimiento. El desbloqueo también pide motivo, y todo
  queda en el historial.
- El cliente bloqueado no puede apartar en tu antro, ni solo ni con un RP.
  Nunca ve el motivo.
- La puerta y los RPs ven avisos como "2 noches sin llegar antes".
- **Solo es de tu antro:** ningún otro antro la ve.
- El bloqueo automático por no-show viene apagado.
- Para encenderla, antes el aviso de privacidad tiene que mencionarla.

### 14. ¿Cuánto cuesta?

La mensualidad por antro está **[por definir]**. A tus clientes no les cuesta
nada, y las comisiones de los RPs las pagas tú en tu nómina, como hoy.

### 15. ¿Cómo se cobra hoy?

**Hoy no se cobra nada desde la app.** La suscripción del antro es un
interruptor en el panel del dueño, sin cobro.

**[Próximamente]** El cobro de la mensualidad con tarjeta ya está preparado,
apagado. Solo se ha probado en modo de prueba. Factura, IVA, días de prueba y
de gracia: **[por definir]**.

---

## Notas para Diego (quitar antes de compartir)

- **[Próximamente]** es el pase 2 (`docs/pase-2.md`). **[Opcional, próximamente]** es el pase 3 más su bandera por antro en `/admin/funciones` (`lib/funciones.ts`: `escaner_respaldo`, `pos_ventas`, `lista_negra`, `whatsapp`, `antifraude`, `reportes_pdf`, `inventario` y `propinas`).
- **P1 ("el equipo de AntroApp"):** el admin ve todo. No hay contrato ni aviso publicado que lo diga: el borrador está en `docs/legal/privacidad.md`.
- **P2:** el borrador del aviso y el contrato están en `docs/legal/` (`NEXT_PUBLIC_LEGALES` apagada). Las regiones de Supabase y Vercel están por confirmar en sus paneles (`docs/legal/inventario-datos.md`).
- **P5 ("lo ya calculado no cambia"):** se deduce del código. `caja_liquidar_cuenta` liquida una vez por cuenta al cuadrar y lee la configuración del momento. Con cuota semanal, un cambio a media semana sí afecta lo que falta por cuadrar de esa semana. **Por confirmar con Diego** si se dice así.
- **P6:** el detalle técnico es la deuda 9 de CLAUDE.md (`clubs.comision_*` se lee con sesión de staff). Los montos por RP y la nómina no los lee. Si no se quiere mencionar a un prospecto, quitar ese párrafo. Pero entonces no decir "el staff no puede ver nada de pagos".
- **P10:** el hueco del RP dado de baja con sesión abierta existe hoy en producción. Lo cierra el Q2 del pase 2 (`sql/post-junta-2/61-sesion-sin-acceso.sql`). La baja de RPs no cierra sesiones.
- **P15:** Stripe está detrás de `NEXT_PUBLIC_MENSUALIDAD`, con llaves de prueba (`docs/stripe-mensualidad.md`). Stripe no emite CFDI. La cifra acordada con el socio ($2,500 MXN, CLAUDE.md §4) no se puso: **por confirmar con Diego**.
- **P7 (permisos de caja):** la base ya los tiene en producción (`caja_permisos`, pase 1), pero la pantalla para darlos (`components/equipo/permisos-caja.tsx`) llega con el pase 2. Por eso van como «Próximamente».
- **Grupo de varios antros:** hoy lo arma AntroApp a mano (no hay pantalla para crearlo en producción). El dueño lo ve en `/grupo`.
