/**
 * Skill 层统一类型定义 —— 全项目的"宪法"（plan4ai.md 第 5 节）。
 *
 * 每个 Skill 是 Agent 可调用的原子校园能力：
 *   validate input → call ThuClient → normalize output → return SkillResult
 *
 * Skill 不负责：LLM 推理、规划、对话状态、Prompt、工具路由、Agent Loop。
 */

/** JSON Schema 的宽松表示，用于描述 Skill 输入参数（会原样发给 DeepSeek） */
export type JSONSchema = Record<string, unknown>;

export interface Skill {
    /** 给模型看的名字，snake_case，如 "get_schedule" */
    name: string;

    /** 给模型看的说明。模型只靠它决定何时调用本工具，务必写清楚 */
    description: string;

    /** 参数的 JSON Schema。模型只靠它填参数，务必写清楚 */
    inputSchema: JSONSchema;

    /** 执行入口。必须能脱离 DeepSeek / Harness / Chat UI 独立调用 */
    execute(input: unknown): Promise<SkillResult>;
}

export interface SkillError {
    /** 机器可读的错误码，如 "AUTH_EXPIRED" / "INVALID_INPUT" / "UPSTREAM_ERROR" */
    code: string;
    /** 人类可读的错误信息（不要包含密码、Cookie 等敏感信息） */
    message: string;
}

export interface SkillResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: SkillError;
}

/** 便捷构造函数 */
export function ok<T>(data: T): SkillResult<T> {
    return { success: true, data };
}

export function fail(code: string, message: string): SkillResult<never> {
    return { success: false, error: { code, message } };
}
