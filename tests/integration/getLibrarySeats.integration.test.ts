/**
 * 集成测试：get_library_seats 走真实链路。
 */
import {describe, expect, it} from "vitest";
import {ThuClient} from "../../src/client/ThuClient";
import {createGetLibrarySeatsSkill, type LibrarySeatsData} from "../../src/skills/library/getLibrarySeats";

describe("get_library_seats Skill（真实链路集成测试）", () => {
    it("execute 返回真实座位空位", async () => {
        const skill = createGetLibrarySeatsSkill(new ThuClient());
        const r = (await skill.execute({})) as {success: boolean; data?: LibrarySeatsData; error?: {message: string}};
        expect(r.success).toBe(true);
        expect(r.data!.sections.length).toBeGreaterThan(0);
        console.log(
            `集成测试：图书馆 ${r.data!.day} 共 ${r.data!.sections.length} 个区域，` +
            `总空位 ${r.data!.totalAvailable}；空位最多：` +
            r.data!.sections.slice(0, 3).map((s) => `${s.library}${s.floor}${s.section}(${s.available})`).join("、"),
        );
    });
});
