/**
 * Step 15 扩充读技能真实链路集成测试（打真实账号，只读不写入）。
 */
import {describe, expect, it} from "vitest";
import {ThuClient} from "../../src/client/ThuClient";
import {createGetReportSkill, type ReportData} from "../../src/skills/academic/getReport";
import {createGetElectricitySkill, type ElectricityData} from "../../src/skills/dorm/getElectricity";
import {createGetLibraryRoomsSkill, type LibraryRoomData} from "../../src/skills/library/getLibraryRooms";

const client = new ThuClient();

describe("Step 15 扩充读技能（真实链路）", () => {
    it("get_report 返回成绩单", async () => {
        const r = (await createGetReportSkill(client).execute({})) as {success: boolean; data?: ReportData};
        expect(r.success).toBe(true);
        expect(r.data!.count).toBeGreaterThan(0);
        console.log(`集成测试：成绩单共 ${r.data!.count} 门，第一门 ${r.data!.courses[0].name} ${r.data!.courses[0].grade}`);
    }, 60000);

    it("get_electricity 返回电费情况（余额上游可能不可用，如实为 null 也算正常）", async () => {
        const r = (await createGetElectricitySkill(client).execute({})) as {success: boolean; data?: ElectricityData};
        expect(r.success).toBe(true);
        console.log(`集成测试：电费余额 ${r.data!.remainder ?? `不可用（${r.data!.remainderNote}）`}，缴费记录 ${r.data!.recentPayRecords.length} 条`);
    }, 60000);

    it("get_library_rooms 返回研讨间资源", async () => {
        const r = (await createGetLibraryRoomsSkill(client).execute({})) as {success: boolean; data?: LibraryRoomData};
        expect(r.success).toBe(true);
        expect(r.data!.rooms.length).toBeGreaterThan(0);
        const booked = r.data!.rooms.reduce((n: number, room) => n + room.booked.length, 0);
        console.log(`集成测试：研讨间 ${r.data!.rooms.length} 间，今日已订 ${booked} 段`);
    }, 60000);
});
