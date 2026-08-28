/**
 * 集成测试：get_schedule Skill 走真实 ThuClient → @thu-info/lib → 清华服务器。
 *
 * 需要 .env 里的真实凭证；需要 OPENSSL_CONF（已内置在 pnpm test 脚本中）。
 * 这是 Skill 的"独立可执行"验证（plan4ai.md 第 9 节）：
 * 不依赖 DeepSeek / Harness / Chat UI。
 */
import {describe, expect, it} from "vitest";
import {ThuClient} from "../../src/client/ThuClient";
import {createGetScheduleSkill, type ScheduleData} from "../../src/skills/schedule/getSchedule";

describe("get_schedule Skill（真实链路集成测试）", () => {
    it("execute 返回稳定结构的真实数据", async () => {
        const client = new ThuClient();
        const skill = createGetScheduleSkill(client);

        const result = (await skill.execute({})) as {
            success: boolean;
            data?: ScheduleData;
            error?: {code: string; message: string};
        };

        expect(result.success).toBe(true);
        const data = result.data!;
        expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(data.dayOfWeek).toBeGreaterThanOrEqual(1);
        expect(data.dayOfWeek).toBeLessThanOrEqual(7);
        expect(typeof data.semesterName).toBe("string");
        expect(Array.isArray(data.courses)).toBe(true);
        for (const c of data.courses) {
            expect(typeof c.name).toBe("string");
            expect(c.beginSession).toBeLessThanOrEqual(c.endSession);
        }
        console.log(
            `集成测试：${data.date}（第 ${data.weekNumber ?? "?"} 周）` +
            `有 ${data.courses.length} 门课`,
        );
    });
});
