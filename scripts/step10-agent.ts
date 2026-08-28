/**
 * Step 10 / V0.1 里程碑：最小可用的对话式 Agent。
 *
 * 注册全部 5 个 Read Skill，接真实 LLM（.env 里的 LLM_*），
 * 模型自己决定何时调哪个工具。命令行多轮对话，输入 exit 退出。
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
1. 需要实时校园信息（课表、校园卡、教室、图书馆座位、体育场馆）时，必须调用对应工具，不许编造。
2. 用户说"今天/明天/这周"等相对日期时，先换算成具体日期再填参数。
3. 工具返回错误时，把错误原因用大白话告诉用户，不要假装查到了。
4. 回答简洁口语化，像同学之间说话。`;

const agent = new Agent(createAllSkills(), SYSTEM_PROMPT);

const rl = readline.createInterface({input: process.stdin, output: process.stdout});
let closed = false;
rl.on("close", () => {
    closed = true;
});
console.log("清华小助手 V0.1 已就绪（输入 exit 退出）\n");

const ask = () => {
    if (closed) return; // stdin 关闭（如管道输入用完）就直接结束
    rl.question("你：", async (question) => {
        const q = question.trim();
        if (!q) return ask();
        if (["exit", "quit", "退出"].includes(q.toLowerCase())) {
            rl.close();
            return;
        }
        try {
            const {answer, toolCalls} = await agent.ask(q);
            for (const t of toolCalls) {
                // 打印工具调用轨迹，方便观察模型行为
                console.log(`  [调工具] ${t.name}(${t.input})`);
            }
            console.log(`助手：${answer}\n`);
        } catch (e) {
            console.log(`出错了：${(e as Error).message}\n`);
        }
        ask();
    });
};

ask();
