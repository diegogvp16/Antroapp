// Service worker de AntroApp.
//
// Existe para que el teléfono reconozca la app como instalable y para una
// sola cosa más: si la app se abre sin señal, mostrar una página propia
// ("Sin conexión") en lugar del error del navegador.
//
// A PROPÓSITO no guarda en caché ninguna página de la app, ni datos, ni
// llamadas a Supabase o /api: reservas, caja y nómina cambian todo el tiempo
// y tienen datos personales; nunca deben salir de una caché. Lo único que se
// guarda es /offline.html, que es estática y no tiene datos de nadie.
// v3: /offline.html dice cuántos movimientos de caja esperan en el teléfono.
// v4: texto de /offline.html: la cola sale con la app de staff abierta.
const VERSION = "antroapp-v4";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.add(new Request(OFFLINE, { cache: "reload" }))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((claves) => Promise.all(claves.filter((c) => c !== VERSION).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

// Solo navegaciones (abrir una pantalla): siempre a la red; si no hay red,
// la página de "Sin conexión". Todo lo demás pasa directo, sin tocarlo.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cache = await caches.open(VERSION);
      return (await cache.match(OFFLINE)) ?? Response.error();
    }),
  );
});
