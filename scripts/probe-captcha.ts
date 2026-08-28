/** 一次性探测：预约提交是否要求滑块验证码 */
import {SportsClient} from "../src/client/sports/SportsClient";
const c = new SportsClient();
const enabled = await c.isCaptchaEnabled();
console.log("enableValidCode 原始值：", JSON.stringify(await (c as never as {api: (p: string) => Promise<unknown>}).api("/api/reserve/enableValidCode")));
console.log("判定结果：", enabled ? "需要验证码" : "不需要验证码");
const user = await c.getLoginUser();
console.log("当前用户：", user.nickName, user.account, "id =", user.id.slice(0, 6) + "…");
