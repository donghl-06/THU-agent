/**
 * 面向外部 Agent Skill 的机器可读 CLI。
 *
 * 它把 createAllSkills() 中的全部原子能力暴露为 list / describe / call，
 * 不依赖本项目内置的 LLM。写操作必须逐次携带 --confirmed-by-user，
 * 没有确认通道的调用方因此会 fail closed。
 */
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import type {Skill, SkillResult} from "./skills/base/types";
import {fail, ok} from "./skills/base/types";
import {createAllSkills} from "./skills/index";

export interface SkillCliRun {
    exitCode: number;
    body: SkillResult<unknown>;
}

interface CallArgs {
    name: string;
    input: unknown;
    confirmedByUser: boolean;
}

function usage(message: string): SkillCliRun {
    return {
        exitCode: 2,
        body: fail(
            "CLI_USAGE",
            `${message}。用法：list | describe <skill> | call <skill> [--input '<json>'] [--confirmed-by-user]`,
        ),
    };
}

function publicDefinition(skill: Skill, includeSchema: boolean): Record<string, unknown> {
    return {
        name: skill.name,
        description: skill.description,
        ...(includeSchema ? {inputSchema: skill.inputSchema} : {}),
        requiresConfirmation: skill.requiresConfirmation === true,
    };
}

function parseCallArgs(args: string[]): CallArgs | SkillCliRun {
    const name = args[0];
    if (!name) return usage("call 缺少 skill 名称");

    let input: unknown = {};
    let hasInput = false;
    let confirmedByUser = false;
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--confirmed-by-user") {
            if (confirmedByUser) return usage("--confirmed-by-user 不能重复");
            confirmedByUser = true;
            continue;
        }
        if (arg === "--input") {
            if (hasInput) return usage("--input 不能重复");
            const raw = args[++i];
            if (raw === undefined) return usage("--input 后缺少 JSON");
            try {
                input = JSON.parse(raw);
            } catch {
                return {
                    exitCode: 2,
                    body: fail("BAD_INPUT_JSON", "--input 必须是合法 JSON"),
                };
            }
            hasInput = true;
            continue;
        }
        return usage(`无法识别参数 ${arg}`);
    }
    return {name, input, confirmedByUser};
}

/**
 * 执行一条外部 Skill CLI 命令。skills 可注入，便于完全离线测试。
 */
export async function runSkillCli(args: string[], skills: Skill[]): Promise<SkillCliRun> {
    const command = args[0];
    if (!command || command === "help" || command === "--help" || command === "-h") {
        if (args.length > 1) return usage("help 不接受额外参数");
        return {
            exitCode: 0,
            body: ok({
                usage: [
                    "list",
                    "describe <skill>",
                    "call <skill> [--input '<json>'] [--confirmed-by-user]",
                ],
            }),
        };
    }

    if (command === "list") {
        if (args.length !== 1) return usage("list 不接受额外参数");
        return {
            exitCode: 0,
            body: ok({skills: skills.map((skill) => publicDefinition(skill, false))}),
        };
    }

    if (command === "describe") {
        if (args.length !== 2) return usage("describe 需要且只接受一个 skill 名称");
        const skill = skills.find((candidate) => candidate.name === args[1]);
        if (!skill) {
            return {exitCode: 2, body: fail("UNKNOWN_SKILL", `没有名为 ${args[1]} 的能力`)};
        }
        return {exitCode: 0, body: ok({skill: publicDefinition(skill, true)})};
    }

    if (command !== "call") return usage(`未知命令 ${command}`);
    const parsed = parseCallArgs(args.slice(1));
    if ("exitCode" in parsed) return parsed;

    const skill = skills.find((candidate) => candidate.name === parsed.name);
    if (!skill) {
        return {exitCode: 2, body: fail("UNKNOWN_SKILL", `没有名为 ${parsed.name} 的能力`)};
    }
    if (skill.requiresConfirmation && !parsed.confirmedByUser) {
        return {
            exitCode: 1,
            body: fail(
                "CONFIRMATION_REQUIRED",
                "这是写操作。调用方必须先向用户展示本次操作的完整参数和真实影响，得到明确同意后再携带 --confirmed-by-user 重试。",
            ),
        };
    }

    try {
        const result = await skill.execute(parsed.input);
        return {exitCode: result.success ? 0 : 1, body: result};
    } catch {
        return {
            exitCode: 1,
            body: fail("INTERNAL_ERROR", "能力执行时发生未处理错误，已停止且不会自动重试。"),
        };
    }
}

async function main(): Promise<void> {
    const result = await runSkillCli(process.argv.slice(2), createAllSkills());
    process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
    void main();
}
