export class ApiError extends Error {
    constructor(public status: number) { super(`HTTP ${status}`); }
}

export async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(path, body === undefined ? {signal, cache: "no-store"} : {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal,
    });
    if (!response.ok) throw new ApiError(response.status);
    return response;
}

export interface StreamEvent {event: string; data: Record<string, unknown>}

export function parseEvent(block: string): StreamEvent | null {
    const event = /^event:\s*(.*)$/m.exec(block)?.[1]?.trim();
    const lines = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart());
    if (!event || !lines.length) return null;
    try { return {event, data: JSON.parse(lines.join("\n"))}; } catch { return null; }
}

export async function readStream(response: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
    if (!response.body) throw new Error("服务未返回内容");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const {done, value} = await reader.read();
            buffer += decoder.decode(value, {stream: !done});
            // Keep a trailing CR until the next chunk so split CRLF delimiters stay intact.
            buffer = buffer.replace(/\r\n/g, "\n");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                const parsed = parseEvent(buffer.slice(0, boundary));
                buffer = buffer.slice(boundary + 2);
                if (parsed) onEvent(parsed);
            }
            if (done) {
                const parsed = parseEvent(buffer);
                if (parsed) onEvent(parsed);
                break;
            }
        }
    } finally { reader.releaseLock(); }
}

export const toolLabels: Record<string, string> = {
    get_schedule: "课程表", get_classroom_state: "教室空位", get_report: "成绩单",
    get_campus_news: "校园动态", get_campus_news_detail: "动态详情",
    get_campus_card_info: "校园卡", recharge_campus_card: "校园卡充值",
    get_electricity: "宿舍电量", recharge_electricity: "电费充值",
    get_library_seats: "图书馆座位", get_library_rooms: "研讨间",
    book_library_seat: "预约图书馆座位", book_library_room: "预约研讨间",
    cancel_library_booking: "取消图书馆预约", get_my_library_bookings: "图书馆预约",
    get_sports_resources: "体育场馆", book_sports_field: "预约体育场馆", pay_sports_order: "体育订单支付",
    get_dorm_hygiene: "宿舍卫生", get_network_status: "校园网",
    get_learn_courses: "学堂课程", get_learn_notices: "学堂通知", get_learn_homework: "学堂作业",
    submit_learn_homework: "提交学堂作业", get_learn_files: "学堂课件", download_learn_file: "下载学堂课件",
    get_learn_calendar: "学堂日历", show_learn_image: "学堂图片",
    get_emails: "清华邮箱", send_email: "发送邮件", show_email_image: "邮件图片",
    create_reminder: "创建提醒", schedule_sports_booking: "定时预约", list_my_tasks: "我的任务", cancel_task: "取消任务",
};

export function errorMessage(error: unknown) {
    if (error instanceof ApiError) {
        if (error.status === 409) return "有另一个操作正在进行，请稍后重试。";
        if (error.status === 429) return "当前请求较多，请稍后重试。";
        if (error.status === 403) return "访问口令已失效，请重新输入口令。";
    }
    return "暂时无法完成请求，请检查连接后重试。";
}
