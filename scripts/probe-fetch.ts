/** 最小复现：在 tsx + SportsClient 模块环境下 POST cas/token */
import "../src/client/sports/SportsClient";
import {getGlobalDispatcher} from "undici";

console.log("dispatcher:", getGlobalDispatcher().constructor.name);
const t0 = Date.now();
try {
    const r = await fetch("https://www.sports.tsinghua.edu.cn/venue/site/cas/token?appId=1&nonce=x&timeStamp=1&sign=y", {
        method: "POST",
        signal: AbortSignal.timeout(20000),
        headers: {"Content-Type": "application/json", "x-api-version": "2.0.0"},
        body: JSON.stringify({platForm: "CAS", client: "PC", token: "deadbeef"}),
    });
    console.log("OK", r.status, Date.now() - t0, "ms", (await r.text()).slice(0, 100));
} catch (e) {
    console.log("FAILED:", (e as Error).message, "|", ((e as Error).cause as Error)?.message);
}
