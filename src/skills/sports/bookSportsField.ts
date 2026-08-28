/**
 * Skill: book_sports_field —— 预约体育场馆的一个场次（写操作，会真实下单）。
 *
 * 安全红线（plan4ai.md）：requiresConfirmation = true，Harness 必须先向用户
 * 展示操作详情并拿到明确同意才会执行到这里。
 *
 * 模型不需要也不应该传 uuid——输入全是人能读懂的语义参数
 * （场馆关键词/日期/时段/场地名），Skill 内部解析成 sessionUuid 等标识符。
 *
 * 支付说明：付费场次会生成待支付订单（orderGenerated && !freeOrder），
 * 本 Skill 只负责下单，不碰支付；结果里如实告知用户需去官方渠道支付。
 */
import type {BookResult, SportsClient} from "../../client/sports/SportsClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {formatDate, parseDate} from "../base/dateUtils";

export interface BookSportsFieldData {
    venue: string;
    field: string;
    date: string;
    time: string;
    feeYuan: number | null;
    /** 订单状态：免支付直接成功；否则提示需支付 */
    orderGenerated: boolean;
    freeOrder: boolean;
    resvIds: string[];
    /** 给用户看的下一步提示 */
    message: string;
}

type SportsBooker = Pick<SportsClient, "listScenes" | "getFieldPage" | "bookSession">;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function createBookSportsFieldSkill(client: SportsBooker): Skill {
    return {
        name: "book_sports_field",
        description:
            "预约体育场馆的一个场次（写操作，会真实下单，付费场次会生成待支付订单）。" +
            "调用前必须先用 get_sports_resources 确认该时段有空场，并向用户复述" +
            "场馆/日期/时段/场地/费用，得到明确同意后才调用。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                resourceName: {
                    type: "string",
                    description: "场馆项目关键词，如“气膜馆羽毛球”；需能唯一匹配一个场景",
                },
                date: {type: "string", description: "日期 YYYY-MM-DD；省略时表示今天"},
                sessionStart: {
                    type: "string",
                    description: "场次开始时间，HH:MM，如“06:00”。必须整段预约，不能约场次的一部分",
                },
                fieldName: {
                    type: "string",
                    description: "场地名，如“羽03”；省略时自动选该时段第一块空场",
                },
            },
            required: ["resourceName", "sessionStart"],
        },

        async execute(input: unknown): Promise<SkillResult<BookSportsFieldData>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.resourceName !== "string" || !raw.resourceName.trim()) {
                return fail("INVALID_INPUT", "resourceName 必填：场馆项目关键词，如“气膜馆羽毛球”");
            }
            if (typeof raw.sessionStart !== "string" || !TIME_RE.test(raw.sessionStart)) {
                return fail("INVALID_INPUT", "sessionStart 必须是 HH:MM 格式，如“06:00”");
            }
            if (raw.date !== undefined && typeof raw.date !== "string") {
                return fail("INVALID_INPUT", "date 必须是 YYYY-MM-DD 格式的字符串");
            }
            if (raw.fieldName !== undefined && typeof raw.fieldName !== "string") {
                return fail("INVALID_INPUT", "fieldName 必须是字符串");
            }
            const target = raw.date === undefined ? new Date() : parseDate(raw.date as string);
            if (target === null) {
                return fail("INVALID_INPUT", `无法解析日期：${raw.date}，请使用 YYYY-MM-DD 格式`);
            }
            const dateStr = formatDate(target);

            try {
                // 写操作的场景匹配必须唯一——宁可报错让用户说清楚，也不能订错场馆
                const scenes = await client.listScenes();
                const keyword = raw.resourceName.trim();
                const matched = scenes.filter((s) => s.sceneName.includes(keyword));
                if (matched.length === 0) {
                    return fail(
                        "INVALID_INPUT",
                        `找不到与“${keyword}”匹配的场馆。可选：${scenes.map((s) => s.sceneName).join("、")}`,
                    );
                }
                if (matched.length > 1) {
                    return fail(
                        "INVALID_INPUT",
                        `“${keyword}”匹配到多个场馆：${matched.map((s) => s.sceneName).join("、")}。请用更具体的关键词。`,
                    );
                }
                const scene = matched[0];

                // 找到该时段可订的场地
                const fields = await client.getFieldPage(scene.uuid, dateStr);
                const candidates = fields.flatMap((f) =>
                    f.sessions
                        .filter((s) => s.available && s.start === raw.sessionStart)
                        .map((s) => ({field: f, session: s})),
                );
                if (candidates.length === 0) {
                    const all = fields.flatMap((f) => f.sessions.filter((s) => s.available));
                    const hint = all.length > 0
                        ? `当前可约时段：${[...new Set(all.map((s) => `${s.start}-${s.end}`))].sort().join("、")}`
                        : "该天当前没有任何可约场次";
                    return fail(
                        "NOT_AVAILABLE",
                        `${scene.sceneName} ${dateStr} ${raw.sessionStart} 开始的场次没有空场。${hint}`,
                    );
                }
                let chosen = candidates[0];
                if (typeof raw.fieldName === "string" && raw.fieldName.trim()) {
                    const fieldName = raw.fieldName.trim();
                    const named = candidates.find((c) => c.field.siteName === fieldName);
                    if (!named) {
                        return fail(
                            "NOT_AVAILABLE",
                            `场地“${fieldName}”在该时段不可订。可订：${candidates.map((c) => c.field.siteName).join("、")}`,
                        );
                    }
                    chosen = named;
                }

                const result: BookResult = await client.bookSession({
                    sceneUuid: scene.uuid,
                    sceneUseType: "SPORT_GROUP",
                    siteUuid: chosen.field.uuid,
                    siteType: chosen.field.siteType,
                    sessionUuid: chosen.session.uuid,
                    date: dateStr,
                    startTime: chosen.session.start,
                    endTime: chosen.session.end,
                });

                const time = `${chosen.session.start}-${chosen.session.end}`;
                const fee = chosen.session.feeYuan;
                const message = result.orderGenerated && !result.freeOrder
                    ? `已下单，生成了待支付订单${fee !== null ? `（${fee} 元）` : ""}，请尽快到体育场馆预约系统完成支付，超时订单会取消。`
                    : `预约成功${fee === 0 || result.freeOrder ? "（免费场次，无需支付）" : ""}。`;
                return ok({
                    venue: scene.sceneName,
                    field: chosen.field.siteName,
                    date: dateStr,
                    time,
                    feeYuan: fee,
                    orderGenerated: result.orderGenerated,
                    freeOrder: result.freeOrder,
                    resvIds: result.resvIds,
                    message,
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
