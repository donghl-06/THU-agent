/**
 * Skill: get_sports_resources —— 查询体育场馆某天各时段的场地空余情况。
 *
 * 数据源：新版体育场馆预约系统（www.sports.tsinghua.edu.cn），
 * 由 SportsClient 封装（旧系统 50.tsinghua.edu.cn 已下线，见 docs/sports-api-notes.md）。
 *
 * 本 Skill 负责：按关键词匹配场景（如“羽毛球”同时命中气膜馆/综体/西体羽毛球），
 * 把每块场地的可约场次聚合成"时段 → 可订场地"的结构。
 *
 * 可约判定（2026-08-29 修正）：以每块场地的**场次表**（sessions）为准——
 * 场次 available === true 才是真的可约。场地级的 reserveStatus.availableRange
 * 只是"没被场次覆盖的空白时间"（含打烊后的时间），不能用来判断可约。
 * 仅当场地支持自由时段预约（supportPeriod）且没有场次表时，才回退用 availableRange。
 * 场馆未开放/全部订满时正常返回空 sessions + note，不算错误。
 */
import type {SportsClient, SportsField} from "../../client/sports/SportsClient";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";
import {formatDate, parseDate} from "../base/dateUtils";
import {matchScenes} from "./sceneMatch";

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

/** 聚合一个场景的场地列表为"时段 → 可订场地" */
function aggregateSessions(fields: SportsField[]): SportsTimeSession[] {
    const sessions = new Map<string, SportsTimeSession>();
    for (const f of fields) {
        if (f.sessions.length > 0) {
            // 场次制（主流）：只统计 available 的场次
            for (const s of f.sessions) {
                if (!s.available) continue;
                const time = `${s.start}-${s.end}`;
                let agg = sessions.get(time);
                if (!agg) {
                    agg = {time, total: fields.length, availableFields: [], cost: s.feeYuan};
                    sessions.set(time, agg);
                }
                agg.availableFields.push(f.siteName);
            }
        } else if (f.supportPeriod && f.reserveStatus?.reserveStatus === "Y") {
            // 自由时段制（回退路径）：availableRange 裁剪到可约时间窗
            for (const range of f.reserveStatus.availableRange) {
                const clipped = clipRange(range, f.bookableWindow);
                if (!clipped) continue;
                const time = `${clipped.start}-${clipped.end}`;
                let agg = sessions.get(time);
                if (!agg) {
                    agg = {time, total: fields.length, availableFields: [], cost: null};
                    sessions.set(time, agg);
                }
                agg.availableFields.push(f.siteName);
            }
        }
    }
    return [...sessions.values()].sort((a, b) => a.time.localeCompare(b.time));
}

export function createGetSportsResourcesSkill(client: SportsSource): Skill {
    return {
        name: "get_sports_resources",
        description:
            "查询体育场馆在指定日期（默认今天）各时段的场地空余情况。" +
            "resourceName 必填，支持关键词匹配场景（如“羽毛球”会同时查气膜馆、综体、西体的羽毛球场；" +
            "“乒乓球”“网球”“篮球”“台球”“游泳”等均可）。体育平台对请求频率有严格限制，" +
            "禁止不带关键词一次查询全部场馆（会触发限流导致查不到数据）。",
        inputSchema: {
            type: "object",
            properties: {
                resourceName: {
                    type: "string",
                    description: "场馆项目关键词，如“羽毛球”“气膜馆”。必填：平台限制请求频率，禁止一次查询全部场馆",
                },
                date: {
                    type: "string",
                    description: "要查询的日期，格式 YYYY-MM-DD；省略时表示今天",
                },
            },
            required: ["resourceName"],
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
                // 场景关键词匹配。必须带关键词：全场景扫描一次要发几百个请求，
                // 必触发平台滚动窗口限流（2026-08-31 实测），后续查询会拿到空数据。
                // 精确匹配为空时启用模糊匹配：平台场景名有错别字（"北体兵乓球"），
                // 严格子串会让"乒乓球"永远查不到（2026-09-02 用户实测）
                const scenes = await client.listScenes();
                const keyword = typeof raw.resourceName === "string" ? raw.resourceName.trim() : "";
                if (keyword === "") {
                    return fail(
                        "INVALID_INPUT",
                        "请指明要查询的场馆项目（如：羽毛球、游泳、乒乓球）。" +
                        "平台限制请求频率，不支持一次查询全部场馆。",
                    );
                }
                const {exact, fuzzy} = matchScenes(scenes, keyword);
                const matched = exact.length > 0 ? exact : fuzzy;
                if (matched.length === 0) {
                    return fail(
                        "INVALID_INPUT",
                        `找不到与“${keyword}”匹配的场馆。可选：${scenes.map((s) => s.sceneName).join("、")}。` +
                        "请从以上名称中选用后重试，不要自行推测失败原因。",
                    );
                }

                // 串行查询：每个场景内部要走位置级联（4 级）+ 按房间查询，
                // 并行容易触发服务端限流（"请求频繁"）。
                // 单场景失败（网络抖动等）降级为 note，不拖累其他场景。
                const fieldLists: (SportsField[] | null)[] = [];
                const failedScenes: string[] = [];
                for (const s of matched) {
                    try {
                        fieldLists.push(await client.getFieldPage(s.uuid, dateStr));
                    } catch (e) {
                        fieldLists.push(null);
                        failedScenes.push(
                            `${s.sceneName}（查询失败：${e instanceof ThuError ? e.message : "未知错误"}）`,
                        );
                    }
                }

                const venues: SportsVenue[] = matched.map((scene, i) => ({
                    name: scene.sceneName,
                    sessions: fieldLists[i] === null ? [] : aggregateSessions(fieldLists[i]),
                }));

                // 收集不可约原因：整个场景没有任何可订场次时给出解释。
                // 注意严格区分三种情况，绝不能把"查不到数据"说成"订满"（2026-08-31 游泳馆误报教训）：
                // ① fields === null → 查询失败（已进 failedScenes）
                // ② fields.length === 0 → 场景下没有查到任何场地，原因未知（接口变化/未排期/无权限）
                // ③ 有场地但 sessions 全空 → 才是真的"订满或锁场"（或全 N 用服务端原因）
                const closedReasons = new Set<string>(failedScenes);
                let emptyDataScenes = 0;
                venues.forEach((venue, i) => {
                    const fields = fieldLists[i];
                    if (fields === null || venue.sessions.length > 0) return;
                    if (fields.length === 0) {
                        emptyDataScenes++;
                        closedReasons.add(
                            `${venue.name}（未查到任何场地数据，原因不明——可能暂未开放预约、平台限流或系统接口变化，请以体育平台页面为准）`,
                        );
                        return;
                    }
                    // 场地整体状态为 N（未开放/表单缺失等）→ 用服务端给的原因；
                    // 状态正常但场次全满/锁场 → 如实说明
                    const allClosed = fields.every((f) => f.reserveStatus?.reserveStatus !== "Y");
                    const reason = allClosed
                        ? fields.find((f) => f.reserveStatus?.reserveStatusReason)
                            ?.reserveStatus?.reserveStatusReason
                        : undefined;
                    closedReasons.add(reason ? `${venue.name}（${reason}）` : `${venue.name}（场次已全部订满或锁场）`);
                });

                return ok({
                    date: dateStr,
                    venues,
                    ...(closedReasons.size > 0
                        ? {note: `以下场景暂无可约时段或查询失败：${[...closedReasons].join("、")}` +
                            (emptyDataScenes >= 2
                                ? "。多个场景均未查到数据，大概率是触发了平台限流，建议 1-2 分钟后再重试一次。"
                                : "")}
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
