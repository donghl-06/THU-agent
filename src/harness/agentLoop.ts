/**
 * Agent Loop：plan4ai.md 第 11 节的最基础闭环。
 *
 *   用户消息 → 模型 → 要调工具？→ 是 → 执行 Skill → 结果塞回对话 → 模型继续
 *                          ↓ 否
 *                        返回文字回答
 *
 * 明确不做（plan4ai.md 红线）：多 Agent、Planner、长期记忆、RAG、工作流引擎。
 * 会话就是内存里的 messages 数组（Basic Session），进程结束即消失。
 *
 * Step 17 性能优化（基准见 eval/benchmark.ts）：
 *   - 流式：ask 带 onToken 时走 SSE，首字延迟从"整段生成"降到"首个 token"
 *   - 并行：模型单轮发多个纯读工具调用时并行执行（写操作仍串行，
 *     避免确认弹窗/扣费顺序被打乱）
 *   - 工具事件：onToolEvent 把"开始/结束"暴露给调用方（UI 进度提示用）
 */
import type {Skill} from "../skills/base/types";
import {createLlmClient, type LlmClient} from "./llmClient";
import {ToolRegistry, type ConfirmFn} from "./toolRegistry";
import type {ChatMessage} from "./types";

/** 单轮对话最多允许的工具调用轮数（防模型失控死循环） */
const MAX_TOOL_ROUNDS = 10;

export interface AgentRunResult {
    /** 模型的最终文字回答 */
    answer: string;
    /** 本轮发生的工具调用记录（便于观察模型行为、排查问题） */
    toolCalls: {name: string; input: string; result: string}[];
}

/** 工具执行事件（start/end 成对出现，end 带耗时与是否成功） */
export interface ToolEvent {
    phase: "start" | "end";
    name: string;
    /** end 时有值 */
    ms?: number;
    success?: boolean;
}

export interface AskOptions {
    /** 流式 token 回调（仅最终回答轮生效；中间的工具决策轮通常没有正文） */
    onToken?: (token: string) => void;
    /** 工具开始/结束事件 */
    onToolEvent?: (e: ToolEvent) => void;
    /** 随问题附带的图片（data URL，如 data:image/png;base64,...）。需模型端点支持 vision */
    images?: string[];
    /** 外部中止信号（Web UI"停止生成"用）；中止后本轮 ask 立即失败 */
    signal?: AbortSignal;
}

export class Agent {
    private readonly llm: LlmClient;
    private readonly registry: ToolRegistry;
    private readonly skillsByName: Map<string, Skill>;
    private readonly messages: ChatMessage[] = [];
    private readonly loginHandler?: () => Promise<void>;

    /**
     * @param skills 注册的技能清单
     * @param systemPrompt 系统提示词
     * @param llm 可选注入（测试用假 LLM）
     * @param confirm 写操作的用户确认回调；不写则写操作一律拒绝执行
     */
    constructor(
        skills: Skill[],
        systemPrompt: string,
        llm?: LlmClient,
        confirm?: ConfirmFn,
        loginHandler?: () => Promise<void>,
    ) {
        this.llm = llm ?? createLlmClient();
        this.registry = new ToolRegistry(skills, confirm);
        this.skillsByName = new Map(skills.map((s) => [s.name, s]));
        this.loginHandler = loginHandler;
        this.messages.push({role: "system", content: systemPrompt});
    }

    /** 建立校园服务登录态；认证交互由注入的 hooks 转发给 Web UI。 */
    async login(): Promise<void> {
        if (!this.loginHandler) throw new Error("当前 Agent 未配置登录处理器。");
        await this.loginHandler();
    }

    /** 问一个问题，拿到最终回答。多轮对话通过 messages 数组自然延续 */
    async ask(question: string, opts: AskOptions = {}): Promise<AgentRunResult> {
        // 带图片时构造多模态 parts（OpenAI vision 协议）；纯文本保持字符串不变
        const content: ChatMessage["content"] = opts.images?.length
            ? [
                {type: "text", text: question || "请看这张图。"},
                ...opts.images.map((url) => ({type: "image_url" as const, image_url: {url}})),
            ]
            : question;
        this.messages.push({role: "user", content});
        const toolCalls: AgentRunResult["toolCalls"] = [];

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            // 有 onToken 且 LLM 支持流式 → 走流式；否则退回普通 chat
            const message = opts.onToken && this.llm.chatStream
                ? await this.llm.chatStream(this.messages, this.registry.schemas(), opts.onToken, opts.signal)
                : await this.llm.chat(this.messages, this.registry.schemas(), opts.signal);
            this.messages.push(message);

            if (!message.tool_calls?.length) {
                // 模型的 assistant 消息永远是纯文本（parts 只出现在用户消息里）
                const answer = typeof message.content === "string" ? message.content : "";
                return {answer, toolCalls};
            }

            // 并行只用于纯读调用：写操作（requiresConfirmation）必须串行，
            // 保证确认弹窗一个接一个出现、扣费/下单顺序可预期
            const calls = message.tool_calls;
            const hasWrite = calls.some((c) => this.skillsByName.get(c.function.name)?.requiresConfirmation);
            const results = hasWrite
                ? await this.runSerial(calls, opts)
                : await this.runParallel(calls, opts);
            for (const [i, result] of results.entries()) {
                toolCalls.push({name: calls[i].function.name, input: calls[i].function.arguments, result});
                this.messages.push({role: "tool", tool_call_id: calls[i].id, content: result});
            }
        }
        throw new Error(`工具调用超过 ${MAX_TOOL_ROUNDS} 轮仍未收敛，已中止（疑似模型行为异常）。`);
    }

    private async runSerial(calls: NonNullable<ChatMessage["tool_calls"]>, opts: AskOptions): Promise<string[]> {
        const out: string[] = [];
        for (const call of calls) {
            out.push(await this.runOne(call.function.name, call, opts));
        }
        return out;
    }

    private async runParallel(calls: NonNullable<ChatMessage["tool_calls"]>, opts: AskOptions): Promise<string[]> {
        return Promise.all(calls.map((c) => this.runOne(c.function.name, c, opts)));
    }

    /** 执行单个调用并发工具事件；异常兜底成错误结果，不让一个工具炸掉整轮 */
    private async runOne(
        name: string,
        call: NonNullable<ChatMessage["tool_calls"]>[number],
        opts: AskOptions,
    ): Promise<string> {
        const t0 = performance.now();
        opts.onToolEvent?.({phase: "start", name});
        try {
            const result = await this.registry.execute(call);
            let success = false;
            try {
                success = (JSON.parse(result) as {success?: boolean}).success === true;
            } catch { /* 非 JSON 结果视为成功 */ success = true; }
            opts.onToolEvent?.({phase: "end", name, ms: performance.now() - t0, success});
            return result;
        } catch (e) {
            opts.onToolEvent?.({phase: "end", name, ms: performance.now() - t0, success: false});
            return JSON.stringify({
                success: false,
                error: {code: "TOOL_CRASH", message: `工具执行异常：${(e as Error).message}`},
            });
        }
    }
}
