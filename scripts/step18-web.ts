/**
 * Step 18 · 单用户 Web UI 启动脚本。
 *
 * 运行：pnpm web   然后浏览器打开 http://127.0.0.1:3457
 * WSL 下默认监听 0.0.0.0（NAT 内网仅 Windows 宿主机可达），localhost 转发失效时
 * 用启动日志打印的 WSL IP 访问；其他环境一律只监听 127.0.0.1。
 * 凭证不出 .env，前端永远拿不到。
 */
import os from "node:os";
import {Agent} from "../src/harness/agentLoop";
import {createAllSkills} from "../src/skills";
import {createWebServer} from "../src/server/webServer";
import type {ConfirmFn} from "../src/harness/toolRegistry";
import {ThuClient} from "../src/client/ThuClient";
import type {LoginCredentials} from "../src/client/auth";
import {dirname, join} from "node:path";

const scriptDirectory = dirname(process.argv[1] ?? process.cwd());
process.env.OPENSSL_CONF ??= join(scriptDirectory, "..", "openssl.cnf");

const PORT = Number(process.env.PORT ?? 3457);
// WSL 下默认监听 0.0.0.0，绕开 localhost 转发失效问题；Windows 原生/打包版保持 127.0.0.1。
// 显式设置 HOST 环境变量时永远优先。
const HOST = process.env.HOST ?? (process.env.WSL_DISTRO_NAME ? "0.0.0.0" : "127.0.0.1");
const indexHtmlPath = join(scriptDirectory, "..", "src", "server", "public", "index.html");

const today = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
});

const SYSTEM_PROMPT = `你是"清灵"（QingLing），一个帮清华学生查询校园信息的助手。今天是${today}。

规则：
1. 需要实时校园信息（课表、校园卡、教室、图书馆座位/研讨间、体育场馆、成绩单、宿舍电费、我的图书馆预约）时，必须调用对应工具，不许编造。
2. 用户说"今天/明天/这周"等相对日期时，先换算成具体日期再填参数。
3. 工具返回错误时，把错误原因用大白话告诉用户，不要假装查到了。
4. 预约/取消/充值等写操作前，先向用户复述一遍关键信息（对象、日期、时段、费用/金额），等用户明确说要执行，再调用工具。付费场次还要确认支付方式（线上/线下）；用户没主动说就先问，不要自己猜。
5. 回答简洁口语化，像同学之间说话。`;

// 认证由 Web UI 按需触发；需要二次认证时通过 SSE 弹窗与后端交互
// 多会话：每个前端会话一个 Agent，但 ThuClient 只建一次——
// 所有会话共享同一登录态，换会话不用重新登录。
let thuClient: ThuClient | undefined;
const server = createWebServer(
    (confirm: ConfirmFn, authHooks, credentials?: LoginCredentials) => {
        thuClient ??= new ThuClient(authHooks, credentials);
        return new Agent(
            createAllSkills({prewarm: false, authHooks, credentials, thuClient}),
            SYSTEM_PROMPT,
            undefined,
            confirm,
            () => thuClient!.login(),
        );
    },
    {port: PORT, indexHtmlPath},
);

server.listen(PORT, HOST, () => {
    console.log(`清灵 QingLing Web UI 已启动：http://127.0.0.1:${PORT}`);
    const ifaces = os.networkInterfaces();
    const eth0Ip = (ifaces["eth0"] ?? []).find((a) => a?.family === "IPv4" && !a.internal)?.address;
    const lanIp =
        eth0Ip ??
        Object.values(ifaces)
            .flat()
            .find((a) => a?.family === "IPv4" && !a.internal && a.address.startsWith("172."))?.address;
    if (HOST === "0.0.0.0" && lanIp) {
        console.log(`Windows 浏览器若打不开上面的地址，试试：http://${lanIp}:${PORT}`);
    }
    console.log("Ctrl+C 停止。");
});
