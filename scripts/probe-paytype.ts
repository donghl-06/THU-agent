/** 一次性探测：/api/resv/trade/pay/type 对气膜馆场地返回哪些支付方式 */
import "../src/utils/httpProxy";
import {SportsClient} from "../src/client/sports/SportsClient";

const sports = new SportsClient();
const scenes = await sports.listScenes();
const scene = scenes.find((s) => s.sceneName.includes("气膜馆"))!;
const fields = await sports.getFieldPage(scene.uuid, "2026-08-30");
const f = fields.find((x) => x.siteName === "羽02")!;
const r = await (sports as unknown as {
    api: (p: string) => Promise<unknown>;
}).api(`/api/resv/trade/pay/type?siteUuid=${f.uuid}&siteType=${f.siteType}`);
console.log(JSON.stringify(r, null, 2));
