// Service worker minimo: existe solo para que el navegador reconozca la
// PWA como instalable ("Agregar a pantalla de inicio" / "Instalar app").
// A proposito NO intercepta fetch ni cachea nada -- los datos de reservas,
// disponibilidad, etc. cambian todo el tiempo y no deben servirse desde
// cache. Si en el futuro se quiere caché offline real, hay que agregarlo
// aqui explicitamente con una estrategia pensada (network-first, etc.).
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
