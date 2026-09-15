// Vite injects the exact JS/CSS files and a build-specific cache version.
const CACHE_NAME = "qingling-react-__WEB_VERSION__";
const WEB_ASSETS = "__WEB_ASSETS__";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", ...WEB_ASSETS];

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(SHELL.map(path => new Request(path, {cache: "reload"})));
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key.startsWith("qingling-") && key !== CACHE_NAME).map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
    if (event.request.mode === "navigate") {
        event.respondWith(fetch(event.request).catch(async () => {
            const cache = await caches.open(CACHE_NAME);
            return await cache.match("/") ?? new Response("清灵后台未运行，请重新启动本地服务。", {status: 503, headers: {"Content-Type": "text/plain; charset=utf-8"}});
        }));
    } else if (SHELL.includes(url.pathname)) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            return await cache.match(event.request) ?? fetch(event.request);
        })());
    }
});
