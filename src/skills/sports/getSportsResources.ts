/**
 * Skill: get_sports_resources —— 查询体育场馆某天各时段的场地空余情况。
 *
 * 库的接口按"场馆项目（如气膜馆羽毛球场）+ 日期"查询，
 * 项目与 gymId/itemId 的对照表在库的 sportsIdInfoList 里（共 8 种）。
 * 本 Skill 负责按关键词匹配项目、聚合各时段的可订场地。
 *
 * 可订判定与官方 App 一致：locked !== true && userType === undefined。
 */
import {sportsIdInfoList} from "@thu-info/lib/dist/lib/sports";
import type {ThuClient} from "../../client/ThuClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {formatDate, parseDate} from "../base/dateUtils";

export interface SportsTimeSession {
    /** 时段，如 "19:00-20:00" */
    time: string;
    /** 该时段场地总数 */
    total: number;
    /** 该时段可订场地名列表 */
    availableFields: string[];
    /** 可订场地的价格（元），未知时为 null */
    cost: number | null;
}

export interface SportsVenue {
    /** 场馆项目名（如"气膜馆羽毛球场"） */
    name: string;
    sessions: SportsTimeSession[];
}

export interface SportsResourcesData {
    date: string;
    venues: SportsVenue[];
    note?: string;
}

type SportsSource = Pick<ThuClient, "getSportsResources">;

export function createGetSportsResourcesSkill(client: SportsSource): Skill {
    return {
        name: "get_sports_resources",
        description:
            "查询体育场馆在指定日期（默认今天）各时段的场地空余情况。" +
            "resourceName 支持关键词匹配项目（如“羽毛球”会同时查气膜馆、综体、西体的羽毛球场），" +
            "可选项目：" + sportsIdInfoList.map((s) => s.name).join("、") + "。",
        inputSchema: {
            type: "object",
            properties: {
                resourceName: {
                    type: "string",
                    description: "场馆项目关键词，如“羽毛球”“气膜馆”；省略时查询全部项目",
                },
                date: {
                    type: "string",
                    description: "要查询的日期，格式 YYYY-MM-DD；省略时表示今天",
                },
            },
            required: [],
        },

        async execute(input: unknown): Promise<SkillResult<SportsResourcesData>> {
            const raw = (input ?? {}) as {resourceName?: unknown; date?: unknown};
            if (raw.resourceName !== undefined && typeof raw.resourceName !== "string") {
                return fail("INVALID_INPUT", "resourceName 必须是字符串");
            }
            if (raw.date !== undefined && typeof raw.date !== "string") {
                return fail("INVALID_INPUT", "date 必须是 YYYY-MM-DD 格式的字符串");
            }
            const target = raw.date === undefined ? new Date() : parseDate(raw.date as string);
            if (target === null) {
                return fail("INVALID_INPUT", `无法解析日期：${raw.date}，请使用 YYYY-MM-DD 格式`);
            }
            const dateStr = formatDate(target);

            // 项目关键词匹配（省略时查全部）
            const keyword = typeof raw.resourceName === "string" ? raw.resourceName.trim() : "";
            const matched = keyword === ""
                ? sportsIdInfoList
                : sportsIdInfoList.filter((s) => s.name.includes(keyword));
            if (matched.length === 0) {
                return fail(
                    "INVALID_INPUT",
                    `找不到与“${keyword}”匹配的场馆项目。可选：${sportsIdInfoList.map((s) => s.name).join("、")}`,
                );
            }

            try {
                const results = await Promise.all(
                    matched.map((info) =>
                        client.getSportsResources(info.gymId, info.itemId, dateStr),
                    ),
                );

                const venues: SportsVenue[] = matched.map((info, i) => {
                    // 按时段聚合
                    const sessions = new Map<string, SportsTimeSession>();
                    for (const r of results[i].data) {
                        let s = sessions.get(r.timeSession);
                        if (!s) {
                            s = {time: r.timeSession, total: 0, availableFields: [], cost: null};
                            sessions.set(r.timeSession, s);
                        }
                        s.total += 1;
                        if (r.locked !== true && r.userType === undefined) {
                            s.availableFields.push(r.fieldName);
                            s.cost = r.cost ?? s.cost;
                        }
                    }
                    return {
                        name: info.name,
                        sessions: [...sessions.values()].sort((a, b) => a.time.localeCompare(b.time)),
                    };
                });

                // init <= 0 表示当前不可预约（见模型注释）
                const closedVenues = matched
                    .filter((_, i) => results[i].init <= 0)
                    .map((info) => info.name);

                return ok({
                    date: dateStr,
                    venues,
                    ...(closedVenues.length > 0
                        ? {note: `以下项目当前不在可预约时段：${closedVenues.join("、")}`}
                        : {}),
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
