/**
 * Step 1 验证脚本：确认 @thu-info/lib 能在 Node 环境正常加载、
 * InfoHelper 能正常实例化（此步不登录、不请求网络）。
 *
 * 运行：pnpm step1
 */
import {InfoHelper} from "@thu-info/lib";

const helper = new InfoHelper();

if (typeof helper.login !== "function") {
    throw new Error("InfoHelper 实例缺少 login 方法，库加载异常");
}
if (typeof helper.getSchedule !== "function") {
    throw new Error("InfoHelper 实例缺少 getSchedule 方法，库加载异常");
}

console.log("Step 1 通过：InfoHelper 实例创建成功，login / getSchedule 方法就位。");
console.log("下一步（Step 2）：scripts/step2-login.ts 跑通真实登录。");
