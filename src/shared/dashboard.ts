export type DashboardGroup = "learning" | "campus" | "life";

export interface DashboardMetric {
    label: string;
    value: string;
    unit?: string;
}

export interface DashboardItem {
    title: string;
    subtitle?: string;
    time?: string;
    badge?: string;
    attention?: boolean;
    body?: string;
    href?: string;
    /** Opaque campus-news identifier; never use this as a browser URL. */
    newsRef?: string;
}

export interface DashboardContent {
    metrics?: DashboardMetric[];
    items?: DashboardItem[];
    images?: string[];
    note?: string;
}

export interface DashboardPanel {
    id: string;
    title: string;
    group: DashboardGroup;
    description: string;
    intervalMs: number;
    status: "idle" | "ready" | "empty" | "error" | "unavailable";
    refreshing: boolean;
    updatedAt?: number;
    attemptedAt?: number;
    nextRefreshAt?: number;
    error?: string;
    data?: DashboardContent;
}

export interface DashboardSnapshot {
    panels: DashboardPanel[];
    generatedAt: number;
    paused: boolean;
}

export interface DashboardNewsDetail {
    title: string;
    content: string;
    note?: string;
}

/** Remote service values are untrusted; never render executable or credential-bearing links. */
export function dashboardLink(value?: string): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
        return url.href;
    } catch { return undefined; }
}
