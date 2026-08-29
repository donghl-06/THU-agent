/**
 * Step 18 · 单用户 Web UI 启动脚本。
 *
 * 运行：pnpm web   然后浏览器打开 http://127.0.0.1:3457
 * 只监听本机回环地址；凭证不出 .env，前端永远拿不到。
 */
import {Agent} from "../src/harness/agentLoop";
import {createAllSkills} from "../src/skills";
import {createWebServer} from "../src/server/webServer";
import type {ConfirmFn} from "../src/harness/toolRegistry";

const PORT = Number(process.env.PORT ?? 3457);

const today = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
});

const SYSTEM_PROMPT = `你是"清华小助手"，一个帮清华学生查询校园信息的助手。今天是${today}。

规则：
1. 需要实时校园信息（课表、校园卡、教室、图书馆座位/研讨间、体育场馆、成绩单、宿舍电费、我的图书馆预约）时，必须调用对应工具，不许编造。
2. 用户说"今天/明天/这周"等相对日期时，先换算成具体日期再填参数。
3. 工具返回错误时，把错误原因用大白话告诉用户，不要假装查到了。
4. 预约/取消/充值等写操作前，先向用户复述一遍关键信息（对象、日期、时段、费用/金额），等用户明确说要执行，再调用工具。付费场次还要确认支付方式（线上/线下）；用户没主动说就先问，不要自己猜。
5. 回答简洁口语化，像同学之间说话。`;

// prewarm：启动时后台登录，首个问题不用再等登录
const server = createWebServer(
    (confirm: ConfirmFn) => new Agent(createAllSkills({prewarm: true}), SYSTEM_PROMPT, undefined, confirm),
    {port: PORT},
);

server.listen(PORT, "127.0.0.1", () => {
    console.log(`清华小助手 Web UI 已启动：http://127.0.0.1:${PORT}`);
    console.log("只监听本机回环地址，凭证不出本机。Ctrl+C 停止。");
});
