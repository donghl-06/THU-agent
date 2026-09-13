/** 对比场景元数据：游泳馆 vs 球类的 sceneUseType 等字段 */
import {SportsClient} from "../src/client/sports/SportsClient";
const c = new SportsClient();
await c.login();
const scenes = await c.listScenes();
for (const n of ["陈明游泳馆", "西湖游泳池", "气膜馆羽毛球", "北体兵乓球"]) {
    const o = scenes.find((x) => x.sceneName === n) as unknown as Record<string, unknown> | undefined;
    console.log(n, "→ sceneUseType:", JSON.stringify(o?.sceneUseType),
        "| relatedType:", JSON.stringify(o?.relatedType),
        "| classKind:", JSON.stringify(o?.classKind),
        "| memo:", JSON.stringify(o?.memo));
}
