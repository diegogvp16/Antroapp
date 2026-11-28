# AntroApp para tu antro

**De la reserva a la nómina, en una sola noche.** AntroApp junta en el
teléfono lo que hoy anda en libretas, chats y hojas de cálculo: las reservas
con QR, la puerta, la caja por mesa y el trabajo de tus RPs.

> Cómo leer esta hoja: lo que no lleva marca **ya funciona hoy**.
> **(Próximamente)** = ya está hecho y probado, falta publicarlo.
> **(Opcional, próximamente)** = igual, y además se enciende solo en los antros que lo pidan.

---

## El problema

Al cierre de la noche cuesta contestar algo simple: **qué reservas trajo cada
RP, cuántas llegaron, cuánto consumieron y cuánto hay que pagarle a cada quien.**
Si cada área anota por su lado, el RP, el gerente y el dueño acaban con
números distintos y se pierde tiempo discutiendo.

## Qué hace

**Para tu cliente**
- Aparta lugar desde el navegador con nombre, teléfono, fecha y personas (1 a 20).
  Puede reservar **sin crear cuenta** con el enlace de reserva de tu antro.
- Recibe un **boleto con QR** que puede compartir por WhatsApp.
- **No paga nada.** El cover, si lo configuras, solo se informa en la ficha y lo cobras tú.
- El QR aparta lugar, pero **no garantiza la entrada**: tú conservas tu derecho
  de admisión, tu código de vestimenta y tu edad mínima.

**En la puerta**
- El staff escanea el QR con su teléfono, ve nombre, personas y RP, y confirma la entrada.
- Si la cámara falla: "Confirmar entrada sin cámara" desde la lista de la noche.
- Un QR que ya se usó no deja pasar a otro grupo: la app avisa que esa reserva ya entró.
- Botón de linterna para poca luz **(próximamente)**.
- Escáner de respaldo: código corto del boleto y entradas sin señal **(opcional, próximamente)**.
- Lista negra y avisos de no-show, solo de tu antro **(opcional, próximamente)**.
- Mensajes de WhatsApp listos para confirmar, recordar y avisar de no-show, que tu equipo decide si manda **(opcional, próximamente)**.

**En la caja, por mesa**
- Cada mesa abre su cuenta; puede tener uno o varios grupos en la noche, cada uno con su RP.
- Consumos y cobros (efectivo o tarjeta, en partes). **Nada se borra**: un error se anula con motivo y queda quién lo hizo.
- El gerente **cuadra cada mesa** (ya no se modifica) y hace el **cuadre de la noche** contra el conteo físico.
- Si se va la señal, la caja lo avisa y un cobro reintentado no se duplica.
- Seguir capturando consumos y cobros sin señal y mandarlos al volver **(próximamente)**.
- Reporte del cierre de la noche y descargas en CSV de reservas, consumo y comisiones **(próximamente)**.
- Importar las ventas de tu punto de venta desde un archivo para comparar **(opcional, próximamente)**.
- Inventario y propinas **(opcional, próximamente)**.

**Tus RPs**
- Crean reservas para sus clientes y las mandan por WhatsApp.
- Ven en qué quedó cada una: **Consumió · Llegó, sin consumo · No llegó · Por llegar**.
- Ven su cuota de la semana y lo que llevan ganado.
- Registran su asistencia con su propio QR.
- La comisión nace **al cuadrar la mesa**, con lo que consumió su cliente.
- Tú les pagas en tu nómina; **AntroApp solo calcula**, para que tú y tus RPs tengan el mismo número.
- Reglas de pago: por reserva (monto fijo o %, con cuota semanal), por día de asistencia, o tarifas individuales por RP.
- Elegir qué ve el RP y programar cambios de regla desde el lunes siguiente **(próximamente)**.
- Revisión de posibles abusos de RPs **(opcional, próximamente)**.

**Para ti, el dueño**
- Ficha del antro y fotos, mesas, cuentas de tu gerente y tu staff, y reglas de pago.
- Nómina semanal de RPs, con estados (pendiente, en revisión, validada y pagada), que puedes exportar a CSV.
- Resumen de tus noches: reservas, cuántas entraron y consumieron, consumo en caja y rendimiento por RP. Si tienes varios antros, los ves juntos.
- Reportes PDF de la noche y de la semana **(opcional, próximamente)**.
- **Cada quien ve lo suyo**: el staff no ve sueldos, el RP solo ve sus reservas y ningún otro antro ve tus datos. Eso lo cuida la base de datos, no solo la pantalla.

## Qué se necesita para empezar

- Datos de tu antro: dirección, horario, ambiente, música, vestimenta, edad mínima y cover (si hay), más fotos.
- Tu lista de mesas, y nombre y correo de tu gerente, tu staff y tus RPs.
- Cómo les pagas hoy a tus RPs.
- Un teléfono con cámara e internet en la puerta, otro para la caja, y el teléfono de cada RP. No hay nada que bajar de una tienda de apps: se instala desde el navegador ("Antro Staff", "Antro RP", "Antro Dueño").
- Si das de alta el antro por tu cuenta: un comprobante fiscal o licencia y una foto del local, para verificarlo.

## Cómo es un piloto

1. Damos de alta tu antro y llenamos la ficha contigo.
2. Cargamos tus mesas, tus cuentas de equipo y tus reglas de pago de RPs.
3. Instalamos la app en los teléfonos de la puerta, la caja y los RPs.
4. Operas tus noches normales con la app: reservas de RPs, puerta, caja y cuadre.
5. Al cerrar la semana revisamos juntos la nómina de RPs y el resumen de tus noches.

Duración, número de noches y condiciones del piloto: **[por definir]**.

## Precio

- **Mensualidad por antro: [por definir].** Hoy no se cobra nada desde la app.
- **Para tus clientes: sin cobro.**
- **Comisiones de RPs: en tu nómina.** El dinero no pasa por AntroApp.

## Lo que hoy NO hace

- No le cobra al cliente ni guarda tarjetas.
- No se conecta en vivo con tu punto de venta. Lo más que hará es importar un archivo **(opcional, próximamente)**.
- No manda WhatsApp por su cuenta: solo abre el chat con el mensaje escrito y tú decides si lo mandas.

Contacto: **[por definir]**

---

## Notas para Diego (quitar antes de enviar)

- **Qué quiere decir cada marca:**
  - **Sin marca:** ya está en producción (pase 1, `master`).
  - **(Próximamente):** pase 2 (`docs/pase-2.md`): linterna, caja sin señal, cierre de la noche, CSV, "Qué ven tus RPs" y regla programada.
  - **(Opcional, próximamente):** pase 3 más su bandera por antro en `/admin/funciones` (`lib/funciones.ts`): `escaner_respaldo`, `lista_negra`, `whatsapp`, `pos_ventas`, `antifraude`, `reportes_pdf`, `inventario` y `propinas`. Inventario y propinas además necesitan `NEXT_PUBLIC_FASE2=1` y la fase 2 base del pase 2.
- **Precio:** con el socio se decidió $2,500 MXN al mes por antro (CLAUDE.md §4), pero no hay cobro real: la suscripción es un interruptor en el panel del dueño, y Stripe está detrás de `NEXT_PUBLIC_MENSUALIDAD`, apagada. Se dejó «[por definir]», igual que en `/para-clubes` y en la junta. **Por confirmar con Diego** si se publica la cifra.
- **"Sin crear cuenta":** en producción **el catálogo (`/cliente`) y la ficha piden cuenta de cliente**. Lo que funciona sin cuenta es la reserva en `/cliente/reservar?club=<id>`, con enlace directo. Por eso la hoja dice "con el enlace de reserva de tu antro".
- **Antes de un piloto con clientes reales:** el aviso de privacidad y el contrato con el antro son borradores (`docs/legal/`), pendientes de abogado, y `/privacidad` está apagada. **Por confirmar con Diego** si el piloto espera a que estén listos.
- **Teléfonos reales:** lo del pase 2 y 3 solo se ha probado en Chromium simulando un teléfono, nunca en teléfonos reales (`docs/avance.md`).
- **"Si tienes varios antros, los ves juntos":** `/grupo` existe en producción, pero el grupo lo arma AntroApp a mano: no hay pantalla para crearlo.
- **Lista negra:** antes de encenderla, el aviso de privacidad tiene que mencionarla (`docs/pase-3.md`).
- **Fotos de Club Demo:** son de SIX GDL. No poner capturas de la ficha ni del catálogo en esta hoja.
