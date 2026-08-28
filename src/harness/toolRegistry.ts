/**
 * 工具注册表：把 Skill 列表转成 OpenAI tools schema，并按名字分发执行。
 *
 * 模型只能通过 name/description/inputSchema 认识工具——这三个字段的
 * 质量直接决定模型会不会用对工具（plan4ai.md 第 5 节）。
 */
import type {Skill, SkillResult} from "../skills/base/types";
import type {ToolCall, ToolSchema} from "./types";

export class ToolRegistry {
    private readonly skills = new Map<string, Skill>();

    constructor(skills: Skill[]) {
        for (const s of skills) {
            if (this.skills.has(s.name)) {
                throw new Error(`重复的 Skill 名：${s.name}`);
            }
            this.skills.set(s.name, s);
        }
    }

    /** 发给模型的 tools 参数 */
    schemas(): ToolSchema[] {
        return [...this.skills.values()].map((s) => ({
            type: "function",
            function: {name: s.name, description: s.description, parameters: s.inputSchema},
        }));
    }

    /** 执行一次工具调用，返回给模型看的 JSON 字符串 */
    async execute(call: ToolCall): Promise<string> {
        const skill = this.skills.get(call.function.name);
        if (!skill) {
            return JSON.stringify({
                success: false,
                error: {code: "UNKNOWN_TOOL", message: `没有名为 ${call.function.name} 的工具`},
            } satisfies SkillResult);
        }
        let input: unknown;
        try {
            input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
            return JSON.stringify({
                success: false,
                error: {code: "BAD_ARGUMENTS", message: `工具参数不是合法 JSON：${call.function.arguments.slice(0, 200)}`},
            } satisfies SkillResult);
        }
        const result = await skill.execute(input);
        return JSON.stringify(result);
    }
}
