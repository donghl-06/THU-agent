/**
 * Skill: get_electricity —— 查询宿舍电费余额与最近缴费记录。
 *
 * 实测注意（2026-08-29）：余额上游服务可能不可用，此时 remainder 为 null、
 * updateTime 是"暂时无法查询！"——如实返回，让模型告诉用户而不是编数字。
 * 缴费记录字段顺序实测为 [账号, 订单号, 时间, 渠道, 金额, 状态]。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface ElectricityData {
    /** 剩余电量（度）；上游服务不可用时为 null，看 remainderNote */
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

export function createGetElectricitySkill(client: ElectricitySource): Skill {
    return {
        name: "get_electricity",
        description:
            "查询当前用户宿舍的电费情况：剩余电量和最近缴费记录。" +
            "余额服务偶尔不可用（此时 remainder 为 null），缴费记录不受影响。无参数。",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },

        async execute(): Promise<SkillResult<ElectricityData>> {
            try {
                const [remainder, records] = await Promise.all([
                    client.getEleRemainder(),
                    client.getElePayRecord(),
                ]);
                // 上游不可用时 lib 会解析出 NaN，统一归一成 null + 说明
                const rem = typeof remainder.remainder === "number" && Number.isFinite(remainder.remainder)
                    ? remainder.remainder
                    : null;
                return ok({
                    remainder: rem,
                    remainderNote: remainder.updateTime,
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
