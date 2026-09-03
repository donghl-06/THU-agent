/**
 * 主动式任务的数据模型（Step 23）。
 *
 * 核心设计：LLM 只负责"创建任务"（对应 skill 走确认流），到点执行走
 * 确定性代码路径（scheduler 直接调 skill.execute），不烧 LLM、不冒
 * 模型临场发挥的风险——LLM 负责推理，代码负责执行。
 *
 * 三类任务：
 *   reminder —— 到点提醒（通知）
 *   monitor  —— 条件监控（如电费低于阈值；未触发则按间隔重查）
 *   booking  —— 到点执行预约（写操作；创建时已过用户确认，执行时不再问）
 */

export interface BaseTask {
    id: string;
    /** 创建时间（epoch ms） */
    createdAt: number;
    /** 下次执行时间（epoch ms） */
    nextRunAt: number;
    /** 给用户看的任务描述（通知标题） */
    title: string;
    /** 创建任务的会话（通知回传定位用） */
    sessionId: string;
    /** 已完成/已取消的任务保留一段时间供查询 */
    done?: boolean;
    cancelled?: boolean;
    /** 最近一次执行的结果消息（查询时给用户看） */
    lastMessage?: string;
}

export interface ReminderTask extends BaseTask {
    kind: "reminder";
}

export interface MonitorTask extends BaseTask {
    kind: "monitor";
    monitor: "electricity";
    /** 电量低于该阈值（度）时触发提醒 */
    thresholdKwh: number;
    /** 重查间隔（分钟） */
    intervalMinutes: number;
}

export interface BookingTask extends BaseTask {
    kind: "booking";
    /** 要执行的工具（当前仅 book_sports_field；input 原样存语义参数） */
    toolName: "book_sports_field";
    input: Record<string, unknown>;
}

export type AgentTask = ReminderTask | MonitorTask | BookingTask;

/** 过期太久的 booking 不再执行（防止服务停摆后启动突然下单），只通知过期 */
export const MAX_LATE_MS = 10 * 60 * 1000;
