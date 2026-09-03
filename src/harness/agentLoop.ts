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
 * Step 21b 上下文裁剪：发给模型的是裁剪视图（旧轮超长工具结果 → 摘要、
 *   旧轮图片 → 占位、超限旧轮整轮淘汰），messages 本体不动。
 */
import type {Skill} from "../skills/base/types";
import {createLlmClient, type LlmClient} from "./llmClient";
import {ToolRegistry, type ConfirmFn} from "./toolRegistry";
import {config} from "../config/env";
import type {ChatMessage, TokenUsage} from "./types";

/** 单轮对话最多允许的工具调用轮数（防模型失控死循环） */
const MAX_TOOL_ROUNDS = 10;

/** 上下文裁剪配置（Step 21b）：只裁"发给模型的视图"，存储本体不动 */
export interface TrimOptions {
    /** 发送视图最多保留的历史用户轮次（当前轮恒完整保留） */
    maxTurns: number;
    /** 旧轮工具结果超过该字符数裁成一行摘要 */
    toolResultKeepChars: number;
}

const DEFAULT_TRIM: TrimOptions = {maxTurns: 20, toolResultKeepChars: 2000};

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, {once: true});
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

export interface AgentRunResult {
    /** 模型的最终文字回答 */
    answer: string;
    /** 本轮发生的工具调用记录（便于观察模型行为、排查问题） */
    toolCalls: {name: string; input: string; result: string}[];
    /** 本轮 LLM token 用量合计（端点未返回 usage 时缺省） */
    usage?: TokenUsage;
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
    private readonly trim: TrimOptions;

    /**
     * @param skills 注册的技能清单
     * @param systemPrompt 系统提示词
     * @param llm 可选注入（测试用假 LLM）
     * @param confirm 写操作的用户确认回调；不写则写操作一律拒绝执行
     * @param trim 上下文裁剪配置（缺省用 DEFAULT_TRIM）
     */
    constructor(
        skills: Skill[],
        systemPrompt: string,
        llm?: LlmClient,
        confirm?: ConfirmFn,
        loginHandler?: () => Promise<void>,
        trim?: Partial<TrimOptions>,
    ) {
        this.llm = llm ?? createLlmClient();
        this.registry = new ToolRegistry(skills, confirm);
        this.skillsByName = new Map(skills.map((s) => [s.name, s]));
        this.loginHandler = loginHandler;
        this.trim = {
            maxTurns: trim?.maxTurns ?? DEFAULT_TRIM.maxTurns,
            toolResultKeepChars: trim?.toolResultKeepChars ?? DEFAULT_TRIM.toolResultKeepChars,
        };
        this.messages.push({role: "system", content: systemPrompt});
    }

    /** 建立校园服务登录态；认证交互由注入的 hooks 转发给 Web UI。 */
    async login(): Promise<void> {
        if (!this.loginHandler) throw new Error("当前 Agent 未配置登录处理器。");
        await this.loginHandler();
    }

    /** 只读快照（会话持久化用）：复制数组，消息对象共享 */
    snapshotMessages(): ChatMessage[] {
        return [...this.messages];
    }

    /** 恢复历史（进程重启后由 server 层调用）：整体替换 messages */
    loadMessages(messages: ChatMessage[]): void {
        this.messages.splice(0, this.messages.length, ...messages);
    }

    /** 问一个问题，拿到最终回答。多轮对话通过 messages 数组自然延续 */
    async ask(question: string, opts: AskOptions = {}): Promise<AgentRunResult> {
        const messageCheckpoint = this.messages.length;
        // 带图片时构造多模态 parts（OpenAI vision 协议）；纯文本保持字符串不变
        const content: ChatMessage["content"] = opts.images?.length
            ? [
                {type: "text", text: question || "请看这张图。"},
                ...opts.images.map((url) => ({type: "image_url" as const, image_url: {url}})),
            ]
            : question;
        this.messages.push({role: "user", content});
        const toolCalls: AgentRunResult["toolCalls"] = [];
        let usage: TokenUsage | undefined;
        const onUsage = (u: TokenUsage) => {
            usage = usage
                ? {
                    promptTokens: usage.promptTokens + u.promptTokens,
                    completionTokens: usage.completionTokens + u.completionTokens,
                    totalTokens: usage.totalTokens + u.totalTokens,
                }
                : u;
        };

        try {
            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                opts.signal?.throwIfAborted();
                // 发送裁剪视图而非完整 messages（Step 21b）；有 onToken 且 LLM
                // 支持流式 → 走流式；否则退回普通 chat
                const view = this.viewForLlm();
                const message = opts.onToken && this.llm.chatStream
                    ? await this.llm.chatStream(view, this.registry.schemas(), opts.onToken, opts.signal, onUsage)
                    : await this.llm.chat(view, this.registry.schemas(), opts.signal, onUsage);
                opts.signal?.throwIfAborted();
                this.messages.push(message);

                if (!message.tool_calls?.length) {
                    // 模型的 assistant 消息永远是纯文本（parts 只出现在用户消息里）
                    const answer = typeof message.content === "string" ? message.content : "";
                    return usage ? {answer, toolCalls, usage} : {answer, toolCalls};
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
                // 工具带图（如宿舍卫生公示图）：OpenAI 协议 tool 消息只能是字符串，
                // 图以"带图 user 消息"追加在工具结果之后喂给 vision 模型（Step 20/22a）
                const toolImages = this.collectToolImages(results);
                if (toolImages.length > 0) {
                    this.messages.push({
                        role: "user",
                        content: [
                            {type: "text", text: "（以上工具返回了公示图片，请结合图片内容回答。）"},
                            ...toolImages.map((b64) => ({
                                type: "image_url" as const,
                                image_url: {url: b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`},
                            })),
                        ],
                    });
                }
            }
            throw new Error(`工具调用超过 ${MAX_TOOL_ROUNDS} 轮仍未收敛，已中止（疑似模型行为异常）。`);
        } catch (error) {
            this.messages.splice(messageCheckpoint);
            throw error;
        }
    }

    /**
     * 构造发给模型的裁剪视图（Step 21b）：只决定"发送什么"，不动 this.messages。
     * - 轮次上限：保留最近 N 个完整历史轮次 + 当前轮，更早的整轮淘汰
     *   （一轮 = user 消息及其后所有 assistant/tool 消息；整轮删除不会拆散
     *   assistant.tool_calls ↔ tool 的配对，OpenAI 协议要求 tool 消息前有对应调用）；
     * - 旧轮瘦身：超长 tool 结果裁成一行摘要；旧轮图片换占位文本
     *   （base64 是 token 大头，历史图片对后续回答几乎没用）。
     */
    private viewForLlm(): ChatMessage[] {
        const starts: number[] = [];
        for (const [i, m] of this.messages.entries()) {
            if (m.role === "user") starts.push(i);
        }
        const currentStart = starts.at(-1);
        if (currentStart === undefined) return this.messages; // 没有用户消息，原样发
        const head = this.messages.slice(0, starts[0]); // system 前缀，恒保留
        const current = this.messages.slice(currentStart); // 当前轮，恒原样
        const oldStarts = starts.slice(0, -1);
        const oldTurns: ChatMessage[][] = oldStarts.map((start, i) =>
            this.messages.slice(start, oldStarts[i + 1] ?? currentStart));
        const kept = oldTurns
            .slice(-this.trim.maxTurns)
            .flat()
            .map((m) => this.slimForView(m));
        return [...head, ...kept, ...current];
    }

    /** 从工具结果 JSON 里提取 base64 图（data.imagesBase64）；vision 关闭时忽略 */
    private collectToolImages(results: string[]): string[] {
        if (!config.llm.vision) return [];
        const images: string[] = [];
        for (const raw of results) {
            try {
                const parsed = JSON.parse(raw) as {data?: {imagesBase64?: unknown}};
                const arr = Array.isArray(parsed.data?.imagesBase64) ? parsed.data.imagesBase64 : [];
                for (const img of arr) {
                    if (typeof img === "string" && img.length > 0) images.push(img);
                }
            } catch { /* 非 JSON 结果无图 */ }
        }
        return images.slice(0, 4);
    }

    /** 旧轮单条消息瘦身：超长工具结果 → 摘要；图片 parts → 占位文本 */
    private slimForView(m: ChatMessage): ChatMessage {        if (m.role === "tool" && typeof m.content === "string" && m.content.length > this.trim.toolResultKeepChars) {
            let note = `历史工具结果已省略（原文 ${m.content.length} 字符）`;
            try {
                const parsed = JSON.parse(m.content) as {success?: boolean; error?: {code?: string}};
                if (parsed.success === false && parsed.error?.code) {
                    note = `历史工具调用失败：${parsed.error.code}（详情已省略）`;
                }
            } catch { /* 非 JSON 结果保持通用摘要 */ }
            return {...m, content: JSON.stringify({trimmed: true, note})};
        }
        if (Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) {
            const parts = m.content.map((p) =>
                p.type === "image_url" ? {type: "text" as const, text: "（图片已省略）"} : p);
            return {...m, content: parts};
        }
        return m;
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
            opts.signal?.throwIfAborted();
            const execution = this.registry.execute(call);
            const result = opts.signal ? await waitForAbort(execution, opts.signal) : await execution;
            let success = false;
            try {
                success = (JSON.parse(result) as {success?: boolean}).success === true;
            } catch { /* 非 JSON 结果视为成功 */ success = true; }
            opts.onToolEvent?.({phase: "end", name, ms: performance.now() - t0, success});
            return result;
        } catch (e) {
            opts.onToolEvent?.({phase: "end", name, ms: performance.now() - t0, success: false});
            if (opts.signal?.aborted) throw e;
            return JSON.stringify({
                success: false,
                error: {code: "TOOL_CRASH", message: `工具执行异常：${(e as Error).message}`},
            });
        }
    }
}
