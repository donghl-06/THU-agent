import {useEffect, useRef, type MouseEvent} from "react";
import {flushSync} from "react-dom";

type Theme = "light" | "dark";

export function useTheme(theme: Theme, setTheme: (theme: Theme) => void) {
    const transitioning = useRef(false);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#17171a" : "#f7f7fa");
    }, [theme]);

    async function toggleTheme(event: MouseEvent<HTMLButtonElement>) {
        if (transitioning.current) return;
        const next = theme === "dark" ? "light" : "dark";
        const apply = () => {
            document.documentElement.dataset.theme = next;
            flushSync(() => setTheme(next));
        };
        if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            apply();
            return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
        const clips = [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`];
        const root = document.documentElement;
        transitioning.current = true;
        root.dataset.themeTransition = next;
        const transition = document.startViewTransition(apply);
        try {
            await transition.ready;
            // Dark ink expands from the control, then retracts into it when returning to light.
            await root.animate({clipPath: next === "dark" ? clips : clips.toReversed()}, {
                duration: 620,
                easing: "cubic-bezier(.4, 0, .2, 1)",
                fill: "both",
                pseudoElement: next === "dark" ? "::view-transition-new(root)" : "::view-transition-old(root)",
            }).finished;
        } catch {
            // Hidden documents and interrupted snapshots still receive the selected theme.
            transition.skipTransition();
        } finally {
            await transition.finished.catch(() => {});
            delete root.dataset.themeTransition;
            transitioning.current = false;
        }
    }

    return {theme, toggleTheme};
}
