// 清灵离线守卫：本地服务退出后，浏览器历史记录仍可打开缓存壳，
// 页面会明确提示“后台未运行”，不能伪装成可用应用。
const CACHE_NAME = "qingling-shell-v1";

self.addEventListener("install", (event) => {
    event.waitUntil(async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.add(new Request("/", {cache: "reload"}));
        self.skipWaiting();
    }());
});

self.addEventListener("activate", (event) => {
    event.waitUntil(async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
    }());
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.mode !== "navigate" || !request.url.startsWith(self.location.origin)) return;

    // 在线时永远拿服务端最新页面；只有本地服务不可达时才回退缓存壳。
    event.respondWith(async () => {
        try {
            return await fetch(request);
        } catch {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match("/");
            if (cached) return cached;
            return new Response("清灵后台未运行。请重新双击“清灵.exe”。", {
                status: 503,
                headers: {"Content-Type": "text/plain; charset=utf-8"},
            });
        }
    }());
});
