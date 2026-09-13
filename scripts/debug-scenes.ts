/** 列出全部场景名（找乒乓球的真实场景名） */
import {SportsClient} from "../src/client/sports/SportsClient";
const c = new SportsClient();
await c.login();
for (const s of await c.listScenes()) console.log(s.sceneName);
