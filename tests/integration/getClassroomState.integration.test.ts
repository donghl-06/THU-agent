/**
 * 集成测试：get_classroom_state 走真实链路（以"六教"为例）。
 */
import {describe, expect, it} from "vitest";
import {ThuClient} from "../../src/client/ThuClient";
import {createGetClassroomStateSkill, type ClassroomStateData} from "../../src/skills/classroom/getClassroomState";

describe("get_classroom_state Skill（真实链路集成测试）", () => {
    it("execute 返回真实教室状态", async () => {
        const skill = createGetClassroomStateSkill(new ThuClient());
        const r = (await skill.execute({building: "六教"})) as {
            success: boolean;
            data?: ClassroomStateData;
            error?: {code: string; message: string};
        };
        expect(r.success).toBe(true);
        expect(r.data!.totalRooms).toBeGreaterThan(0);
        console.log(
            `集成测试：${r.data!.building} ${r.data!.date}（第 ${r.data!.weekNumber} 周）` +
            `共 ${r.data!.totalRooms} 间教室，其中 ${r.data!.rooms.length} 间有空闲时段`,
        );
    });
});
