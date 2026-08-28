/**
 * Skill: get_campus_card_info —— 查询校园卡余额和卡片状态。
 *
 * 无输入参数（查的就是当前登录用户自己的卡）。
 * 输出做了裁剪：模型通常只需要余额和状态，院系/证件照文件名等不返回。
 */
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface CampusCardData {
    /** 余额，单位：元 */
    balance: number;
    /** 卡片状态（如"正常"） */
    cardStatus: string;
    /** 最近一笔交易时间，ISO 字符串 */
    lastTransactionTime: string;
    /** 单日消费限额，单位：元 */
    maxDailyTransactionAmount: number;
}

type CampusCardSource = Pick<ThuClient, "getCampusCardInfo">;

export function createGetCampusCardInfoSkill(client: CampusCardSource): Skill {
    return {
        name: "get_campus_card_info",
        description: "查询当前用户的校园卡余额、卡片状态和最近交易时间。",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },

        async execute(): Promise<SkillResult<CampusCardData>> {
            try {
                const info = await client.getCampusCardInfo();
                return ok({
                    balance: info.balance,
                    cardStatus: info.cardStatus,
                    lastTransactionTime: info.lastTransactionTimestamp.toISOString(),
                    maxDailyTransactionAmount: info.maxDailyTransactionAmount,
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
