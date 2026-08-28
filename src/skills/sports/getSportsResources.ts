/**
 * Skill: get_sports_resources —— 查询体育场馆某天各时段的场地空余情况。
 *
 * 数据源：新版体育场馆预约系统（www.sports.tsinghua.edu.cn），
 * 由 SportsClient 封装（旧系统 50.tsinghua.edu.cn 已下线，见 docs/sports-api-notes.md）。
 *
 * 本 Skill 负责：按关键词匹配场景（如“羽毛球”同时命中气膜馆/综体/西体羽毛球），
 * 把每块场地的可约时间段聚合成"时段 → 可订场地"的结构。
 *
 * 可约判定：reserveStatus.reserveStatus === "Y" 且 availableRange 非空。
 * 场馆未开放时（如暑假）正常返回空 sessions + note，不算错误。
 */
import type {SportsClient} from "../../client/sports/SportsClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {formatDate, parseDate} from "../base/dateUtils";

export interface SportsTimeSession {
    /** 时段，如 "19:00-20:00" */
    time: string;
    /** 该场景场地总数 */
    total: number;
    /** 该时段可订场地名列表 */
    availableFields: string[];
    /** 可订场地的价格（元），未知时为 null */
    cost: number | null;
}

export interface SportsVenue {
    /** 场景名（如"气膜馆羽毛球"） */
    name: string;
    sessions: SportsTimeSession[];
}

export interface SportsResourcesData {
    date: string;
    venues: SportsVenue[];
    note?: string;
}

type SportsSource = Pick<SportsClient, "listScenes" | "getFieldPage">;

/** 把空闲段裁剪到可约时间窗内；完全在窗外返回 null。"HH:MM" 字符串可按字典序比较 */
function clipRange(
    range: {startTime: string; endTime: string},
    window: {start: string; end: string} | null,
): {start: string; end: string} | null {
    if (!window) return {start: range.startTime, end: range.endTime};
    const start = range.startTime < window.start ? window.start : range.startTime;
    const end = range.endTime > window.end ? window.end : range.endTime;
    return start < end ? {start, end} : null;
}

export function createGetSportsResourcesSkill(client: SportsSource): Skill {
    return {
        name: "get_sports_resources",
        description:
            "查询体育场馆在指定日期（默认今天）各时段的场地空余情况。" +
            "resourceName 支持关键词匹配场景（如“羽毛球”会同时查气膜馆、综体、西体的羽毛球场；" +
            "“乒乓球”“网球”“篮球”“台球”“游泳”等均可）。",
        inputSchema: {
            type: "object",
            properties: {
                resourceName: {
                    type: "string",
                    description: "场馆项目关键词，如“羽毛球”“气膜馆”；省略时查询全部场景",
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

            try {
                // 场景关键词匹配（省略时查全部）
                const scenes = await client.listScenes();
                const keyword = typeof raw.resourceName === "string" ? raw.resourceName.trim() : "";
                const matched = keyword === ""
                    ? scenes
                    : scenes.filter((s) => s.sceneName.includes(keyword));
                if (matched.length === 0) {
                    return fail(
                        "INVALID_INPUT",
                        `找不到与“${keyword}”匹配的场馆。可选：${scenes.map((s) => s.sceneName).join("、")}`,
                    );
                }

                // 串行查询：每个场景内部要走位置级联（4 级）+ 按房间查询，
                // 并行容易触发服务端限流（"请求频繁"）
                const fieldLists = [];
                for (const s of matched) {
                    fieldLists.push(await client.getFieldPage(s.uuid, dateStr));
                }

                const venues: SportsVenue[] = matched.map((scene, i) => {
                    const fields = fieldLists[i];
                    // 按可约时间段聚合：同一时间段内可订的场地归在一起。
                    // availableRange 可能越出实际可约时间窗（如空闲段从 00:00 开始），
                    // 用 bookableWindow（reserveRule.laterLineTime）裁剪。
                    const sessions = new Map<string, SportsTimeSession>();
                    for (const f of fields) {
                        if (f.reserveStatus?.reserveStatus !== "Y") continue;
                        for (const range of f.reserveStatus.availableRange) {
                            const clipped = clipRange(range, f.bookableWindow);
                            if (!clipped) continue;
                            const time = `${clipped.start}-${clipped.end}`;
                            let s = sessions.get(time);
                            if (!s) {
                                s = {time, total: fields.length, availableFields: [], cost: null};
                                sessions.set(time, s);
                            }
                            s.availableFields.push(f.siteName);
                        }
                    }
                    return {
                        name: scene.sceneName,
                        sessions: [...sessions.values()].sort((a, b) => a.time.localeCompare(b.time)),
                    };
                });

                // 收集未开放原因（如"未开放""申请表单信息缺失"——暑假闭馆时常见）
                const closedReasons = new Set<string>();
                fieldLists.forEach((fields, i) => {
                    const allClosed = fields.every((f) => f.reserveStatus?.reserveStatus !== "Y");
                    if (allClosed) {
                        const reason = fields.find((f) => f.reserveStatus?.reserveStatusReason)
                            ?.reserveStatus?.reserveStatusReason;
                        closedReasons.add(reason ? `${matched[i].sceneName}（${reason}）` : matched[i].sceneName);
                    }
                });

                return ok({
                    date: dateStr,
                    venues,
                    ...(closedReasons.size > 0
                        ? {note: `以下场景当前不可预约：${[...closedReasons].join("、")}`}
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
