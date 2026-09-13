/**
 * Skill: get_dorm_score —— 查询宿舍卫生检查成绩。
 *
 * 上游（weixin myhome 线图页）没有结构化分数，只有一张近四周分数公示图
 * （lib 的 uFetch 对 image/* 返回 base64）。文本模型读不了图，所以本 Skill
 * 把 base64 原样带出，由 agentLoop 在工具结果后追加带图消息喂给 vision
 * 模型（Step 20 多模态）。Skill 本身保持零 LLM（架构红线）。
 */
import {ThuError} from "../../client/errors";
import type {ThuClient} from "../../client/ThuClient";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface DormScoreData {
    /** 数据说明（告诉模型图里是什么） */
    note: string;
    /** 公示图 base64（裸 base64，不带 data: 前缀；agentLoop 负责包装） */
    imagesBase64: string[];
}

type DormScoreSource = Pick<ThuClient, "getDormScore">;

export function createGetDormScoreSkill(client: DormScoreSource): Skill {
    return {
        name: "get_dorm_score",
        description:
            "查询当前用户宿舍的卫生检查成绩（近四周公示图）。无参数。" +
            "结果以图片形式返回，调用后请直接根据图片内容报告各周得分，不要说查不到。",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },

        async execute(): Promise<SkillResult<DormScoreData>> {
            let base64: string;
            try {
                base64 = await client.getDormScore();
            } catch (e) {
                if (e instanceof ThuError) {
                    // 宿舍系统常见失败（DormAuthError 无 message）：给模型可转述的原因
                    return e.code === "LIB_ERROR" || e.code === "UPSTREAM_ERROR" || !e.message
                        ? fail(
                            "DORM_SCORE_UNAVAILABLE",
                            "宿舍系统未返回卫生成绩公示图（可能未登录宿舍系统、近期无检查记录或系统维护）。",
                        )
                        : fail(e.code, e.message);
                }
                throw e;
            }
            if (typeof base64 !== "string" || base64.length < 100) {
                return fail("DORM_SCORE_UNAVAILABLE", "宿舍系统返回了空的公示图，无法识别成绩。");
            }
            return ok({
                note: "下面是宿舍卫生检查成绩公示图（近四周分数折线图）。",
                imagesBase64: [base64],
            });
        },
    };
}
