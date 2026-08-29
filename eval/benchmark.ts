/**
 * Step 17 · 性能基准：跑代表性问题，拆解延迟构成。
 *
 * 指标（plan 见 ROADMAP Step 17）：
 *   - 总延迟：从提问到拿到完整回答
 *   - LLM 耗时：所有 chat 调用的总和（非流式时 = 首字延迟）
 *   - 工具耗时：所有 skill.execute 的总和，及各工具明细
 *   - 工具耗时占比 = 工具耗时 / 总延迟
 *
 * 用法：pnpm benchmark [--repeat N]
 * 注意：真实 LLM + 真实上游，耗时受网络波动影响；对比时同环境同问题跑。
 */
import {Agent} from "../src/harness/agentLoop";
import {createAllSkills} from "../src/skills";
import {createLlmClient, type LlmClient} from "../src/harness/llmClient";
import type {Skill} from "../src/skills/base/types";
import type {ChatMessage, ToolSchema} from "../src/harness/types";

/** 代表性问题集：覆盖 无工具 / 单工具 / 串联 / 重查询 四种形态 */
const QUESTIONS: {label: string; q: string}[] = [
    {label: "no-tool", q: "你好"},
    {label: "single-read", q: "我今天有什么课？"},
    {label: "chain", q: "看看我饭卡余额，再告诉我图书馆现在有没有座"},
    {label: "heavy-read", q: "图书馆现在哪些区域空位多？"},
];

const today = new Date().toLocaleDateString("zh-CN", {year: "numeric", month: "long", day: "numeric", weekday: "long"});
const SYSTEM_PROMPT = `你是"清华小助手"，一个帮清华学生查询校园信息的助手。今天是${today}。

规则：
1. 需要实时校园信息（课表、校园卡、教室、图书馆座位/研讨间、体育场馆、成绩单、宿舍电费、我的图书馆预约）时，必须调用对应工具，不许编造。
2. 用户说"今天/明天/这周"等相对日期时，先换算成具体日期再填参数。
3. 工具返回错误时，把错误原因用大白话告诉用户，不要假装查到了。
4. 预约/取消/充值等写操作前，先向用户复述一遍关键信息（对象、日期、时段、费用/金额），等用户明确说要执行，再调用工具。
5. 回答简洁口语化，像同学之间说话。`;

interface Timing {
    llmMs: number[];
    toolMs: {name: string; ms: number}[];
    totalMs: number;
    /** 首字延迟：从提问到第一个回答 token（流式） */
    ttfbMs: number | null;
}

/** 包装 LLM 客户端：记录每次 chat/chatStream 耗时 */
function timedLlm(inner: LlmClient, sink: number[]): LlmClient {
    return {
        async chat(messages: ChatMessage[], tools: ToolSchema[]) {
            const t0 = performance.now();
            try {
                return await inner.chat(messages, tools);
            } finally {
                sink.push(performance.now() - t0);
            }
        },
        // 必须转发 chatStream，否则 Agent 会退回非流式，TTFB 测不出来
        ...(inner.chatStream ? {
            chatStream: async (messages: ChatMessage[], tools: ToolSchema[], onToken: (t: string) => void) => {
                const t0 = performance.now();
                try {
                    return await inner.chatStream!(messages, tools, onToken);
                } finally {
                    sink.push(performance.now() - t0);
                }
            },
        } : {}),
    };
}

/** 包装 Skill：记录每次 execute 耗时 */
function timedSkill(inner: Skill, sink: {name: string; ms: number}[]): Skill {
    return {
        ...inner,
        async execute(input: unknown) {
            const t0 = performance.now();
            try {
                return await inner.execute(input);
            } finally {
                sink.push({name: inner.name, ms: performance.now() - t0});
            }
        },
    };
}

const repeat = Math.max(1, Number(process.argv.find((a) => a.startsWith("--repeat="))?.split("=")[1] ?? 1));

async function runOnce(q: string): Promise<Timing> {
    const llmMs: number[] = [];
    const toolMs: {name: string; ms: number}[] = [];
    // prewarm 模拟真实使用（agent 常驻、启动时已登录），
    // 测的是"用户提问后"的延迟，不含启动登录
    const skills = createAllSkills({prewarm: true}).map((s) => timedSkill(s, toolMs));
    const llm = timedLlm(createLlmClient(), llmMs);
    const agent = new Agent(skills, SYSTEM_PROMPT, llm, async () => true);

    const t0 = performance.now();
    let ttfb: number | null = null;
    await agent.ask(q, {
        onToken: () => {
            if (ttfb === null) ttfb = performance.now() - t0;
        },
    });
    return {llmMs, toolMs, totalMs: performance.now() - t0, ttfbMs: ttfb};
}

console.log(`基准开始：${QUESTIONS.length} 个问题 × ${repeat} 遍\n`);

for (const {label, q} of QUESTIONS) {
    const runs: Timing[] = [];
    for (let i = 0; i < repeat; i++) {
        process.stdout.write(`  [${label}] 第 ${i + 1}/${repeat} 遍…\r`);
        try {
            runs.push(await runOnce(q));
        } catch (e) {
            console.log(`\n  [${label}] 第 ${i + 1} 遍失败：${(e as Error).message}`);
        }
    }
    if (runs.length === 0) continue;

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const totalAvg = avg(runs.map((r) => r.totalMs));
    const llmAvg = avg(runs.map((r) => r.llmMs.reduce((a, b) => a + b, 0)));
    const toolAvg = avg(runs.map((r) => r.toolMs.reduce((a, b) => a + b.ms, 0)));
    const llmCallsAvg = avg(runs.map((r) => r.llmMs.length));

    console.log(`[${label}] "${q}"（${runs.length} 次成功）`);
    console.log(`  总延迟 ${(totalAvg / 1000).toFixed(1)}s = LLM ${(llmAvg / 1000).toFixed(1)}s（${llmCallsAvg.toFixed(1)} 次调用）+ 工具 ${(toolAvg / 1000).toFixed(1)}s（占比 ${Math.round((toolAvg / totalAvg) * 100)}%）`);
    const ttfbs = runs.map((r) => r.ttfbMs).filter((x): x is number => x !== null);
    if (ttfbs.length > 0) {
        console.log(`  首字延迟（流式）：${(avg(ttfbs) / 1000).toFixed(1)}s`);
    }

    // 工具明细（按平均耗时降序）
    const byName = new Map<string, number[]>();
    for (const r of runs) for (const t of r.toolMs) {
        byName.set(t.name, [...(byName.get(t.name) ?? []), t.ms]);
    }
    for (const [name, xs] of [...byName.entries()].sort((a, b) => avg(b[1]) - avg(a[1]))) {
        console.log(`    ${name}: 平均 ${(avg(xs) / 1000).toFixed(1)}s（${xs.length} 次）`);
    }
    console.log();
}
