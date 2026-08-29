/**
 * Step 16 图书馆预约技能真实链路集成测试（打真实账号）。
 *
 * 只测读路径（我的预约记录）与座位/研讨间的查询解析逻辑前置部分；
 * 真实下单与取消必须人工确认，放在手动验证流程里，不进 CI。
 */
import {describe, expect, it} from "vitest";
import {ThuClient} from "../../src/client/ThuClient";
import {createGetMyLibraryBookingsSkill, type MyLibraryBookingsData} from "../../src/skills/library/getMyLibraryBookings";

const client = new ThuClient();

describe("Step 16 图书馆预约技能（真实链路，只读）", () => {
    it("get_my_library_bookings 返回我的座位+研讨间记录（可以为空）", async () => {
        const r = (await createGetMyLibraryBookingsSkill(client).execute({})) as
            {success: boolean; data?: MyLibraryBookingsData};
        expect(r.success).toBe(true);
        console.log(`集成测试：我的座位预约 ${r.data!.seats.length} 条，研讨间预约 ${r.data!.rooms.length} 条`);
    }, 60000);

    it("fuzzySearchLibraryId 按完整学号能查到人（研讨间加成员的前置）", async () => {
        // 实测：上游只认完整学号，姓名/姓氏/学号前缀都返回空（姓名还会脱敏）
        const {config} = await import("../../src/config/env");
        const found = await client.fuzzySearchLibraryId(config.thu.username);
        expect(found.length).toBeGreaterThan(0);
        console.log(`集成测试：按学号搜索命中 ${found.length} 人（${found[0].department}）`);
    }, 60000);

    it("MyhomeClient 直登 m.myhome 查到电量（比 lib 通道稳的源）", async () => {
        const {MyhomeClient} = await import("../../src/client/myhome");
        const info = await new MyhomeClient().getEleKwh();
        expect(Number.isFinite(info.kwh)).toBe(true);
        expect(info.room).not.toBe("");
        console.log(`集成测试：${info.building} ${info.room} 剩余电量 ${info.kwh} 度（抄表 ${info.meterTime}）`);
    }, 60000);
});
