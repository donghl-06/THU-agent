/**
 * Skill: get_electricity —— 查询宿舍电费余额与最近缴费记录。
 *
 * 两个数据源（2026-08-30 实测）：
 * - 剩余电量（度）：m.myhome 微信版页面（MyhomeClient），稳定可靠，
 *   还带楼号/房间/抄表时间；
 * - 缴费记录：lib 的桌面 myhome 通道，稳定；
 * - 金额余额（元）：lib 的桌面通道，间歇性"暂时无法查询"，不可用时为 null。
 * 三个源互相独立，单个挂了不影响其他（降级为 null/空数组，如实标注）。
 */
import type {ThuClient} from "../../client/ThuClient";
import type {MyhomeClient} from "../../client/myhome";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface ElectricityData {
    /** 剩余电量（度），来自 m.myhome；源挂了为 null */
    kwhRemainder: number | null;
    /** 楼号（如"紫荆学生公寓二十号楼"），同 m.myhome 源 */
    building?: string;
    /** 房间号 */
    room?: string;
    /** 抄表时间 */
    meterTime?: string;
    /** 剩余金额（元）；上游服务不可用时为 null，看 remainderNote */
    remainder: number | null;
    /** 余额数据说明（正常是更新时间，异常时是"暂时无法查询"） */
    remainderNote: string;
    /** 最近缴费记录（最新在前，最多 5 条） */
    recentPayRecords: {
        time: string;
        /** 金额（元） */
        amount: string;
        /** 支付渠道，如"微信" */
        channel: string;
        /** 状态，如"已成功" */
        status: string;
    }[];
}

type ElectricitySource = Pick<ThuClient, "getEleRemainder" | "getElePayRecord">;

export function createGetElectricitySkill(
    client: ElectricitySource,
    myhome?: Pick<MyhomeClient, "getEleKwh">,
): Skill {
    return {
        name: "get_electricity",
        description:
            "查询当前用户宿舍的电费情况：剩余电量（度）、楼号房间、抄表时间和最近缴费记录。" +
            "金额余额（元）的上游偶尔不可用（此时 remainder 为 null），但电量（kwhRemainder）一般都能查到。无参数。",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },

        async execute(): Promise<SkillResult<ElectricityData>> {
            try {
                // 三个源独立降级：任何一个挂了都不拖垮整体
                const [kwhRes, remainderRes, recordsRes] = await Promise.allSettled([
                    myhome ? myhome.getEleKwh() : Promise.resolve(undefined),
                    client.getEleRemainder(),
                    client.getElePayRecord(),
                ]);

                const kwh = kwhRes.status === "fulfilled" ? kwhRes.value : undefined;
                const remainderRaw = remainderRes.status === "fulfilled" ? remainderRes.value : undefined;
                const records = recordsRes.status === "fulfilled" ? recordsRes.value : [];

                // 上游不可用时 lib 会解析出 NaN，统一归一成 null + 说明
                const rem = remainderRaw && Number.isFinite(remainderRaw.remainder)
                    ? remainderRaw.remainder
                    : null;

                return ok({
                    kwhRemainder: kwh?.kwh ?? null,
                    ...(kwh ? {building: kwh.building, room: kwh.room, meterTime: kwh.meterTime} : {}),
                    remainder: rem,
                    remainderNote: remainderRaw?.updateTime ?? "金额余额源不可用",
                    recentPayRecords: records.slice(0, 5).map((r) => ({
                        time: r[2],
                        amount: r[4],
                        channel: r[3],
                        status: r[5],
                    })),
                });
            } catch (e) {
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
