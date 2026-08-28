/**
 * 集成测试：get_campus_card_info 走真实链路。
 * 需要 .env 凭证与 OPENSSL_CONF（pnpm test 已内置）。
 */
import {describe, expect, it} from "vitest";
import {ThuClient} from "../../src/client/ThuClient";
import {createGetCampusCardInfoSkill, type CampusCardData} from "../../src/skills/card/getCampusCardInfo";

describe("get_campus_card_info Skill（真实链路集成测试）", () => {
    it("execute 返回真实余额", async () => {
        const skill = createGetCampusCardInfoSkill(new ThuClient());
        const r = (await skill.execute({})) as {success: boolean; data?: CampusCardData};
        expect(r.success).toBe(true);
        expect(typeof r.data!.balance).toBe("number");
        expect(r.data!.balance).toBeGreaterThanOrEqual(0);
        console.log(`集成测试：校园卡余额 ${r.data!.balance} 元，状态 ${r.data!.cardStatus}`);
    });
});
