/**
 * get_campus_card_info Skill 独立测试（假数据，无网络）。
 */
import {describe, expect, it} from "vitest";
import {createGetCampusCardInfoSkill, type CampusCardData} from "../../src/skills/card/getCampusCardInfo";
import {ThuError} from "../../src/client/errors";

const fakeInfo = {
    balance: 52.3,
    cardStatus: "正常",
    lastTransactionTimestamp: new Date("2026-08-27T11:30:00+08:00"),
    maxDailyTransactionAmount: 300,
};

const skill = createGetCampusCardInfoSkill({
    getCampusCardInfo: async () => fakeInfo as never,
});

describe("get_campus_card_info Skill（假数据，无网络）", () => {
    it("返回裁剪后的校园卡数据", async () => {
        const r = (await skill.execute({})) as {success: boolean; data?: CampusCardData};
        expect(r.success).toBe(true);
        expect(r.data!.balance).toBe(52.3);
        expect(r.data!.cardStatus).toBe("正常");
        expect(r.data!.lastTransactionTime).toBe("2026-08-27T03:30:00.000Z");
    });

    it("ThuError 被转换为 SkillResult 错误而不是抛出", async () => {
        const failing = createGetCampusCardInfoSkill({
            getCampusCardInfo: async () => {
                throw new ThuError("NETWORK_ERROR", "网络请求失败");
            },
        });
        const r = await failing.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NETWORK_ERROR");
    });
});
