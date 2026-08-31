import {describe, expect, it} from "vitest";
import {ok, type Skill} from "../../src/skills/base/types";
import {createAllSkills} from "../../src/skills/index";
import {runSkillCli} from "../../src/skillCli";

const echoSkill: Skill = {
    name: "echo",
    description: "回显输入",
    inputSchema: {type: "object", properties: {text: {type: "string"}}},
    async execute(input) {
        return ok({echo: input});
    },
};

function writeSkill(state: {executed: boolean}): Skill {
    return {
        name: "write_thing",
        description: "执行真实写操作",
        inputSchema: {type: "object", properties: {value: {type: "string"}}},
        requiresConfirmation: true,
        async execute(input) {
            state.executed = true;
            return ok({written: input});
        },
    };
}

describe("外部 Agent Skill CLI", () => {
    it("list 暴露统一装配表中的全部真实能力", async () => {
        const skills = createAllSkills();
        const result = await runSkillCli(["list"], skills);
        expect(result.exitCode).toBe(0);
        expect(result.body.success).toBe(true);
        const listed = (result.body.data as {skills: {name: string}[]}).skills;
        expect(listed.map((skill) => skill.name)).toEqual(skills.map((skill) => skill.name));
    });

    it("describe 返回输入 schema 和确认要求", async () => {
        const result = await runSkillCli(["describe", "echo"], [echoSkill]);
        expect(result.exitCode).toBe(0);
        expect(result.body.data).toEqual({
            skill: {
                name: "echo",
                description: "回显输入",
                inputSchema: echoSkill.inputSchema,
                requiresConfirmation: false,
            },
        });
    });

    it("call 解析 JSON 并执行读能力", async () => {
        const result = await runSkillCli(["call", "echo", "--input", "{\"text\":\"hello\"}"], [echoSkill]);
        expect(result.exitCode).toBe(0);
        expect(result.body).toEqual({success: true, data: {echo: {text: "hello"}}});
    });

    it("非法 JSON 返回机器可读错误", async () => {
        const result = await runSkillCli(["call", "echo", "--input", "{"], [echoSkill]);
        expect(result.exitCode).toBe(2);
        expect(result.body.error?.code).toBe("BAD_INPUT_JSON");
    });

    it("未知能力不会执行", async () => {
        const result = await runSkillCli(["call", "missing"], [echoSkill]);
        expect(result.exitCode).toBe(2);
        expect(result.body.error?.code).toBe("UNKNOWN_SKILL");
    });

    it("没有逐次确认标记时 fail closed", async () => {
        const state = {executed: false};
        const result = await runSkillCli(["call", "write_thing", "--input", "{\"value\":\"x\"}"], [writeSkill(state)]);
        expect(result.exitCode).toBe(1);
        expect(result.body.error?.code).toBe("CONFIRMATION_REQUIRED");
        expect(state.executed).toBe(false);
    });

    it("明确确认后才执行写能力", async () => {
        const state = {executed: false};
        const result = await runSkillCli([
            "call",
            "write_thing",
            "--input",
            "{\"value\":\"x\"}",
            "--confirmed-by-user",
        ], [writeSkill(state)]);
        expect(result.exitCode).toBe(0);
        expect(result.body.success).toBe(true);
        expect(state.executed).toBe(true);
    });

    it("未处理异常不泄露原始错误内容", async () => {
        const crashing: Skill = {
            ...echoSkill,
            async execute() {
                throw new Error("secret-cookie-value");
            },
        };
        const result = await runSkillCli(["call", "echo"], [crashing]);
        expect(result.exitCode).toBe(1);
        expect(result.body.error?.code).toBe("INTERNAL_ERROR");
        expect(JSON.stringify(result.body)).not.toContain("secret-cookie-value");
    });
});
