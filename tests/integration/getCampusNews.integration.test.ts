/**
 * 集成测试：get_campus_news 走真实 ThuClient → THU Info 动态接口。
 *
 * 只做读操作，不涉及收藏、订阅或已读状态。
 */
import {describe, expect, it} from "vitest";
import {ThuClient} from "../../src/client/ThuClient";
import {
    createGetCampusNewsSkill,
    type CampusNewsData,
} from "../../src/skills/news/getCampusNews";

describe("get_campus_news Skill（真实链路集成测试）", () => {
    it("execute 返回最近校园动态", async () => {
        const skill = createGetCampusNewsSkill(new ThuClient());
        const r = (await skill.execute({limit: 5})) as {
            success: boolean;
            data?: CampusNewsData;
            error?: {code: string; message: string};
        };

        expect(r.success).toBe(true);
        expect(r.data!.mode).toBe("latest");
        expect(r.data!.channels.length).toBeGreaterThan(0);
        expect(Array.isArray(r.data!.items)).toBe(true);
        for (const item of r.data!.items) {
            expect(item.title).toBeTruthy();
            expect(item.channelName).toBeTruthy();
            expect(item.url).toBeTruthy();
        }
        console.log(`集成测试：校园动态返回 ${r.data!.items.length} 条`);
    });
});
