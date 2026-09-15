import {useEffect, useId, useRef, useState} from "react";
import {Check, ChevronDown, Hand, ShieldAlert} from "lucide-react";
import type {AccessMode} from "../../harness/accessMode";

const modes = [
    {value: "request-approval", label: "请求批准", detail: "操作前由你批准", icon: Hand},
    {value: "full-access", label: "完全访问", detail: "直接执行，不再请求批准", icon: ShieldAlert},
] as const;

export function AccessModePicker({mode, change, disabled}: {mode: AccessMode; change: (mode: AccessMode) => void; disabled: boolean}) {
    const [open, setOpen] = useState(false);
    const container = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const menuId = useId();
    const current = modes.find(item => item.value === mode)!;
    const Icon = current.icon;
    function close(restoreFocus = false) {
        setOpen(false);
        if (restoreFocus) trigger.current?.focus();
    }
    useEffect(() => {
        if (!open) return;
        container.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
        const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
        window.addEventListener("pointerdown", outside);
        return () => window.removeEventListener("pointerdown", outside);
    }, [open]);
    useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
    return <div className="access-mode-picker" ref={container} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
    }} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); close(true); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            if (!open) { if (!disabled) setOpen(true); return; }
            const options = Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
            const index = options.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
            options[next]?.focus();
        }
    }}>
        <button ref={trigger} type="button" className={`access-mode-trigger ${mode === "full-access" ? "full-access" : ""}`} aria-label={`访问模式：${current.label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} onClick={() => setOpen(!open)}>
            <Icon size={16}/><span>{current.label}</span><ChevronDown size={12} className={open ? "expanded" : ""}/>
        </button>
        {open && <div id={menuId} className="access-mode-menu" role="menu" aria-label="访问模式">{modes.map(({value, label, detail, icon: ModeIcon}) =>
            <button type="button" key={value} className={`access-mode-option ${value === "full-access" ? "full-access" : ""}`} role="menuitemradio" aria-checked={mode === value} tabIndex={-1} onClick={() => { change(value); close(true); }}>
                <ModeIcon size={18}/><span><strong>{label}</strong><small>{detail}</small></span>{mode === value && <Check size={15}/>}
            </button>,
        )}</div>}
    </div>;
}
