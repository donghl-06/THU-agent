import {useCallback, useEffect, useRef, useState} from "react";
import type {DashboardSnapshot} from "../../shared/dashboard";
import {ApiError, request} from "./api";

export function useDashboard() {
    const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
    const [error, setError] = useState("");
    const [automatic, setAutomatic] = useState(true);
    const [visible, setVisible] = useState(!document.hidden);
    const [fetching, setFetching] = useState(false);
    const refreshRef = useRef<(id?: string) => void>(() => {});

    useEffect(() => {
        const changed = () => setVisible(!document.hidden);
        document.addEventListener("visibilitychange", changed);
        return () => document.removeEventListener("visibilitychange", changed);
    }, []);

    useEffect(() => {
        if (!visible) return;
        let stopped = false;
        let pending = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let controller: AbortController | undefined;
        async function load(force?: string, pollOnly = false) {
            if (stopped || pending) return;
            pending = true;
            clearTimeout(timer);
            controller = new AbortController();
            const current = controller;
            const timeout = setTimeout(() => current.abort(), 15_000);
            setFetching(true);
            let updating = false;
            try {
                const query = force ? `?refresh=${encodeURIComponent(force)}` : pollOnly ? "?poll=1" : "";
                const response = await request(`/api/dashboard${query}`, undefined, current.signal);
                const data = await response.json() as DashboardSnapshot;
                if (stopped) return;
                setSnapshot(data);
                setError("");
                updating = data.panels.some(panel => panel.refreshing);
            } catch (cause) {
                if (stopped) return;
                setError(cause instanceof ApiError && cause.status === 401 ? "登录已过期，请重新连接清华账号。"
                    : cause instanceof ApiError && cause.status === 403 ? "访问口令已失效，请重新输入口令。"
                    : cause instanceof ApiError && cause.status === 409 ? "当前操作完成后将自动加载看板。"
                    : "看板暂时无法更新，请检查连接后重试。已有数据仍保留。");
            } finally {
                clearTimeout(timeout);
                pending = false;
                if (!stopped) {
                    setFetching(false);
                    if (automatic || updating) timer = setTimeout(() => void load(undefined, updating || !automatic), updating ? 2000 : 15_000);
                }
            }
        }
        refreshRef.current = id => void load(id ?? "all");
        void load(undefined, !automatic);
        return () => { stopped = true; clearTimeout(timer); controller?.abort(); refreshRef.current = () => {}; };
    }, [automatic, visible]);

    const refresh = useCallback((id?: string) => refreshRef.current(id), []);
    return {snapshot, error, automatic, setAutomatic, fetching, refresh};
}
