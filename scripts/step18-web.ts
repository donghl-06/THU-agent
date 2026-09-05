/**
 * Step 18 · 单用户 Web UI 启动脚本。
 *
 * 运行：pnpm web   然后浏览器打开 http://127.0.0.1:3457
 * WSL 下默认监听 0.0.0.0（NAT 内网仅 Windows 宿主机可达），localhost 转发失效时
 * 用启动日志打印的 WSL IP 访问；其他环境一律只监听 127.0.0.1。
 * 凭证不出 .env，前端永远拿不到。
 *
 * Step 23：进程内任务调度器（提醒/低电费监控/定时抢场）随服务启动；
 * 抢场执行走确定性代码路径直接调 book_sports_field 技能，不再经过 LLM。
 */
import os from "node:os";
import {Agent} from "../src/harness/agentLoop";
import {dateContextLine} from "../src/harness/dateContext";
import {createAllSkills, resolveCaptchaSolver} from "../src/skills";
import {createBookSportsFieldSkill} from "../src/skills/sports/bookSportsField";
import {createWebServer} from "../src/server/webServer";
import {NotificationHub} from "../src/server/notificationHub";
import type {ConfirmFn} from "../src/harness/toolRegistry";
import {ThuClient} from "../src/client/ThuClient";
import {SportsClient} from "../src/client/sports/SportsClient";
import {MyhomeClient} from "../src/client/myhome";
import {TaskScheduler} from "../src/tasks/scheduler";
import {TaskStore} from "../src/tasks/taskStore";
import type {LoginCredentials} from "../src/client/auth";
import {resolveStableFingerprint} from "../src/client/fingerprintStore";
import {dirname, join} from "node:path";

const scriptDirectory = dirname(process.argv[1] ?? process.cwd());
process.env.OPENSSL_CONF ??= join(scriptDirectory, "..", "openssl.cnf");

const PORT = Number(process.env.PORT ?? 3457);
// WSL 下默认监听 0.0.0.0，绕开 localhost 转发失效问题；Windows 原生/打包版保持 127.0.0.1。
// 显式设置 HOST 环境变量时永远优先。
const HOST = process.env.HOST ?? (process.env.WSL_DISTRO_NAME ? "0.0.0.0" : "127.0.0.1");
const indexHtmlPath = join(scriptDirectory, "..", "src", "server", "public", "index.html");

const today = dateContextLine();

const SYSTEM_PROMPT = `你是"清灵"（QingLing），一个帮清华学生查询校园信息的助手。${today}。

规则：
1. 需要实时校园信息（课表、校园卡、教室、图书馆座位/研讨间、体育场馆、成绩单、宿舍电费、宿舍卫生、校园网、我的图书馆预约）时，必须调用对应工具，不许编造。
2. 用户说"今天/明天/这周"等相对日期时，先换算成具体日期再填参数。
3. 工具返回错误时，把错误原因用大白话告诉用户，不要假装查到了。
4. 预约/取消/充值等写操作前，先向用户复述一遍关键信息（对象、日期、时段、费用/金额），等用户明确说要执行，再调用工具。付费场次还要确认支付方式（线上/线下）；用户没主动说就先问，不要自己猜。
5. 用户要"明早6点帮我抢场""下午提醒我"这类未来要做的事时，用任务类工具（create_reminder / schedule_sports_booking）登记，并向用户确认参数后再创建。
6. 回答简洁口语化，像同学之间说话。`;

// 认证由 Web UI 按需触发；需要二次认证时通过 SSE 弹窗与后端交互
// 多会话：每个前端会话一个 Agent，但 ThuClient 只建一次——
// 所有会话共享同一登录态，换会话不用重新登录。
let thuClient: ThuClient | undefined;
// 抢场任务执行用：与 skills 装配同款的 SportsClient（登录态共享由 credentials 决定，
// 定时执行发生时用户通常已登录过—— SportsClient 按需自行登录）
let sportsCredentials: LoginCredentials | undefined;
const notificationHub = new NotificationHub();
const authSessionPath = join(scriptDirectory, "..", "data", "auth.json");
const deviceFingerprint = resolveStableFingerprint();

// 定时抢场执行器：确定性代码路径直接调 book_sports_field 的 execute（不再经过 LLM）
const scheduler = new TaskScheduler(
    {
        notify: (task, message) => notificationHub.push(task.id, task.title, message, task.sessionId),
        executeBooking: async (task) => {
            const bookSkill = createBookSportsFieldSkill(
                new SportsClient(sportsCredentials),
                {captchaSolver: resolveCaptchaSolver()},
            );
            const result = await bookSkill.execute(task.input);
            if (result.success) {
                const data = result.data as {venue?: string; date?: string; time?: string; field?: string; message?: string};
                return `定时预约成功：${data.venue ?? ""} ${data.date ?? ""} ${data.time ?? ""}（${data.field ?? ""}）。${data.message ?? ""}`;
            }
            return `定时预约失败：${result.error?.code ?? "UNKNOWN"}——${result.error?.message ?? "未知原因"}`;
        },
        checkMonitor: async (task) => {
            // 电费监控：m.myhome 稳定源查电量，低于阈值触发提醒；查询失败静默等下一轮
            try {
                const kwh = await new MyhomeClient().getEleKwh();
                if (kwh.kwh !== null && kwh.kwh < task.thresholdKwh) {
                    return {triggered: true, message: `宿舍电量只剩 ${kwh.kwh} 度（低于提醒阈值 ${task.thresholdKwh} 度），记得充值。`};
                }
            } catch { /* 本轮查询失败，按未触发处理等下一轮 */ }
            return {triggered: false, message: ""};
        },
    },
    new TaskStore(join(scriptDirectory, "..", "data", "tasks.json")),
);
scheduler.start();

const server = createWebServer(
    (confirm: ConfirmFn, authHooks, credentials?: LoginCredentials) => {
        thuClient ??= new ThuClient(
            authHooks,
            credentials ? {...credentials, fingerprint: deviceFingerprint} : undefined,
            authSessionPath,
        );
        // 用户主动点"登录" = 强制走真实认证（覆盖可能过期的持久会话）；
        // 首次问答等懒创建场景无 credentials，不清登录态
        if (credentials) thuClient.logout();
        sportsCredentials = credentials
            ? {...credentials, fingerprint: deviceFingerprint}
            : sportsCredentials;
        return new Agent(
            createAllSkills({
                prewarm: false,
                authHooks,
                credentials,
                thuClient,
                scheduler,
            }),
            SYSTEM_PROMPT,
            undefined,
            confirm,
            () => thuClient!.login(),
        );
    },
    {
        port: PORT,
        indexHtmlPath,
        sessionStorePath: join(scriptDirectory, "..", "data", "sessions.json"),
        authSessionPath,
        scheduler,
        notificationHub,
    },
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
