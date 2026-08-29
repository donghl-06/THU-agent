/**
 * Step 10+13 / V0.1+ 命令行 Agent。
 *
 * 注册全部 Read Skill + Write Skill，接真实 LLM（.env 里的 LLM_*），
 * 模型自己决定何时调哪个工具。写操作（标了 requiresConfirmation 的）
 * 会先展示操作详情，用户输入 y 确认后才真正执行。
 *
 * 运行：pnpm agent
 * 试试：我今天下午有什么课？/ 现在图书馆还有座位吗？/ 今晚气膜馆羽毛球有场吗？
 */
import * as readline from "node:readline";
import {Agent} from "../src/harness/agentLoop";
import {createAllSkills} from "../src/skills";

const today = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
});

const SYSTEM_PROMPT = `你是"清华小助手"，一个帮清华学生查询校园信息的助手。今天是${today}。

规则：
1. 需要实时校园信息（课表、校园卡、教室、图书馆座位/研讨间、体育场馆、成绩单、宿舍电费）时，必须调用对应工具，不许编造。
2. 用户说"今天/明天/这周"等相对日期时，先换算成具体日期再填参数。
3. 工具返回错误时，把错误原因用大白话告诉用户，不要假装查到了。
4. 预约等写操作前，先向用户复述一遍关键信息（场馆、日期、时段、场地、费用），等用户明确说要订，再调用工具。付费场次还要确认支付方式（线上/线下）；用户没主动说就先问，不要自己猜。
5. 回答简洁口语化，像同学之间说话。`;

const rl = readline.createInterface({input: process.stdin, output: process.stdout});
let closed = false;
let pendingResolve: ((v: string) => void) | null = null;
rl.on("close", () => {
    closed = true;
    // stdin 关闭（管道输入用完/Ctrl+D）：挂起的问题按"退出"处理，防止进程挂死
    pendingResolve?.("exit");
    pendingResolve = null;
});

/** 基于同一个 rl 的 Promise 版提问（主循环和确认流共用）；stdin 关闭时视为退出 */
const promptUser = (q: string): Promise<string> =>
    new Promise((resolve) => {
        if (closed) return resolve("exit"); // rl 已关，不能再注册 question
        pendingResolve = resolve;
        rl.question(q, (answer) => {
            pendingResolve = null;
            resolve(answer);
        });
    });

/** 写操作确认：展示工具名和参数，y 才放行 */
const confirmWrite = async (call: {function: {name: string; arguments: string}}): Promise<boolean> => {
    console.log("\n⚠️  助手要执行写操作：");
    console.log(`    操作：${call.function.name}`);
    try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        for (const [k, v] of Object.entries(args)) {
            console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
    } catch {
        console.log(`    参数：${call.function.arguments}`);
    }
    const answer = (await promptUser("    确认执行？(y/N) ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
};

// 验证码求解器不在这里传：createAllSkills 会在 .env 配了超级鹰（CJY_*）时自动接上
const agent = new Agent(createAllSkills(), SYSTEM_PROMPT, undefined, confirmWrite);

console.log("清华小助手已就绪（输入 exit 退出）\n");

// eslint-disable-next-line no-constant-condition
while (true) {
    const question = await promptUser("你：");
    const q = question.trim();
    if (!q) continue;
    if (["exit", "quit", "退出"].includes(q.toLowerCase())) break;
    try {
        const {answer, toolCalls} = await agent.ask(q);
        for (const t of toolCalls) {
            // 打印工具调用轨迹，方便观察模型行为
            console.log(`  [调工具] ${t.name}(${t.input})`);
            // 失败的工具调用把原因直接摆出来，免得模型转述时丢信息
            if (t.result.includes('"success":false')) {
                console.log(`  [工具报错] ${t.result}`);
            }
        }
        console.log(`助手：${answer}\n`);
    } catch (e) {
        console.log(`出错了：${(e as Error).message}\n`);
    }
}
rl.close();
