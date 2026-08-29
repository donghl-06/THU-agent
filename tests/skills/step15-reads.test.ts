/**
 * Step 15 扩充读技能独立测试（假数据，无网络）。
 * 三个 skill 共用一个文件：模式一致，各自验证裁剪/过滤/错误转换。
 */
import {describe, expect, it} from "vitest";
import {createGetReportSkill, type ReportData} from "../../src/skills/academic/getReport";
import {createGetElectricitySkill, type ElectricityData} from "../../src/skills/dorm/getElectricity";
import {createGetLibraryRoomsSkill, type LibraryRoomData} from "../../src/skills/library/getLibraryRooms";
import {ThuError} from "../../src/client/errors";

type R<T> = {success: boolean; data?: T; error?: {code: string; message: string}};

describe("get_report Skill", () => {
    const courses = [
        {name: "数据结构", credit: 3, grade: "A", point: 4.0, semester: "2025-2026-1"},
        {name: "线性代数", credit: 3, grade: "B+", point: 3.3, semester: "2025-2026-1"},
        {name: "大学物理", credit: 4, grade: "A-", point: 3.7, semester: "2024-2025-2"},
    ];
    const skill = createGetReportSkill({getReport: async () => courses as never});

    it("返回全部课程", async () => {
        const r = (await skill.execute({})) as R<ReportData>;
        expect(r.success).toBe(true);
        expect(r.data!.count).toBe(3);
        expect(r.data!.courses[0]).toMatchObject({name: "数据结构", grade: "A"});
    });

    it("按学期关键词过滤", async () => {
        const r = (await skill.execute({semester: "2024-2025"})) as R<ReportData>;
        expect(r.success).toBe(true);
        expect(r.data!.count).toBe(1);
        expect(r.data!.courses[0].name).toBe("大学物理");
    });

    it("过滤不到时报 NOT_FOUND", async () => {
        const r = (await skill.execute({semester: "2030-2031"})) as R<ReportData>;
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("NOT_FOUND");
    });

    it("ThuError 转换为 SkillResult 错误", async () => {
        const failing = createGetReportSkill({getReport: async () => {
            throw new ThuError("AUTH_FAILED", "登录失败");
        }});
        const r = await failing.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("AUTH_FAILED");
    });
});

describe("get_electricity Skill", () => {
    it("返回余额与最近 5 条缴费记录（记录字段按实测顺序映射）", async () => {
        const records = Array.from({length: 7}, (_, i) =>
            ["dhl2006", `order${i}`, `2026-08-1${i} 08:00:00`, "微信", "20.00", "已成功"]);
        const skill = createGetElectricitySkill({
            getEleRemainder: async () => ({remainder: 88.5, updateTime: "2026-08-29 08:00"}),
            getElePayRecord: async () => records as never,
        });
        const r = (await skill.execute({})) as R<ElectricityData>;
        expect(r.success).toBe(true);
        expect(r.data!.remainder).toBe(88.5);
        expect(r.data!.recentPayRecords).toHaveLength(5);
        expect(r.data!.recentPayRecords[0]).toEqual({
            time: "2026-08-10 08:00:00", amount: "20.00", channel: "微信", status: "已成功",
        });
    });

    it("余额上游不可用时如实返回 null（不编数字）", async () => {
        const skill = createGetElectricitySkill({
            getEleRemainder: async () => ({remainder: null as unknown as number, updateTime: "暂时无法查询！"}),
            getElePayRecord: async () => [] as never,
        });
        const r = (await skill.execute({})) as R<ElectricityData>;
        expect(r.success).toBe(true);
        expect(r.data!.remainder).toBeNull();
        expect(r.data!.remainderNote).toContain("暂时无法查询");
    });
});

describe("get_library_rooms Skill", () => {
    const infos = [
        {kindId: 1, kindName: "文图研讨间", rooms: [{devId: 11, devName: "文图G01", minReserveTime: 30}]},
        {kindId: 2, kindName: "经管研讨间", rooms: [{devId: 21, devName: "经管A01", minReserveTime: 30}]},
    ];
    const resources = (kindId: number) => [{
        devId: 1, devName: kindId === 1 ? "文图G01" : "经管A01", kindId, kindName: kindId === 1 ? "文图研讨间" : "经管研讨间",
        labId: 1, labName: "", roomId: 1, roomName: "G01", limit: 0, maxMinute: 240, minMinute: 30,
        cancelMinute: 30, maxUser: 8, minUser: 3, openStart: "08:00", openEnd: "22:00",
        usage: [{id: 1, start: new Date("2026-08-29T10:00:00"), end: new Date("2026-08-29T12:00:00"), title: "", owner: "", ownerId: ""}],
    }];
    const client = {
        getLibraryRoomBookingInfoList: async () => infos as never,
        getLibraryRoomBookingResourceList: async (_d: string, kindId: number) => resources(kindId) as never,
    };
    const skill = createGetLibraryRoomsSkill(client);

    it("返回全部类别的房间与已订时段", async () => {
        const r = (await skill.execute({date: "2026-08-29"})) as R<LibraryRoomData>;
        expect(r.success).toBe(true);
        expect(r.data!.rooms).toHaveLength(2);
        expect(r.data!.rooms[0].booked[0]).toEqual({start: "10:00", end: "12:00"});
        expect(r.data!.failedKinds).toEqual([]);
    });

    it("单个类别查询失败时降级：其余类别正常返回，失败的进 failedKinds", async () => {
        const flaky = createGetLibraryRoomsSkill({
            getLibraryRoomBookingInfoList: client.getLibraryRoomBookingInfoList,
            getLibraryRoomBookingResourceList: async (_d: string, kindId: number) => {
                if (kindId === 2) throw new ThuError("UPSTREAM_ERROR", "操作失败，请重试");
                return resources(kindId) as never;
            },
        });
        const r = (await flaky.execute({})) as R<LibraryRoomData>;
        expect(r.success).toBe(true);
        expect(r.data!.rooms).toHaveLength(1);
        expect(r.data!.failedKinds).toEqual(["经管研讨间"]);
    });

    it("全部类别失败时报 UPSTREAM_ERROR", async () => {
        const allFail = createGetLibraryRoomsSkill({
            getLibraryRoomBookingInfoList: client.getLibraryRoomBookingInfoList,
            getLibraryRoomBookingResourceList: async () => {
                throw new ThuError("UPSTREAM_ERROR", "操作失败，请重试");
            },
        });
        const r = await allFail.execute({});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("UPSTREAM_ERROR");
    });

    it("关键词过滤类别", async () => {
        const r = (await skill.execute({keyword: "经管"})) as R<LibraryRoomData>;
        expect(r.success).toBe(true);
        expect(r.data!.rooms).toHaveLength(1);
        expect(r.data!.rooms[0].kindName).toBe("经管研讨间");
    });

    it("关键词无匹配时报 NOT_FOUND 并列出可选类别", async () => {
        const r = (await skill.execute({keyword: "不存在"})) as R<LibraryRoomData>;
        expect(r.success).toBe(false);
        expect(r.error!.message).toContain("文图研讨间");
    });

    it("非法日期被拒", async () => {
        const r = await skill.execute({date: "明天"});
        expect(r.success).toBe(false);
        expect(r.error!.code).toBe("INVALID_INPUT");
    });
});
