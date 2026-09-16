import {lazy, memo, Suspense, useEffect, useId, useState} from "react";
import {Brain, Check, ChevronRight, CirclePause, LoaderCircle, ShieldCheck, TriangleAlert, Wrench} from "lucide-react";
import {toolLabels} from "../lib/api";
import type {TextStep, ToolStep, Turn, TurnItem} from "../lib/types";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

const Prose = memo(function Prose({text, streaming}: {text: string; streaming: boolean}) {
    return streaming ? <div className="plain-message">{text}<span className="stream-cursor"/></div>
        : <Suspense fallback={<div className="plain-message">{text}</div>}><MarkdownContent text={text}/></Suspense>;
});

function Reasoning({item, active}: {item: TextStep; active: boolean}) {
    const streaming = active && item.status === "streaming";
    const [disclosure, setDisclosure] = useState<{streaming: boolean; open: boolean} | null>(null);
    const expanded = disclosure?.streaming === streaming ? disclosure.open : streaming;
    const contentId = useId();
    return <div className={`reasoning-step ${streaming ? "is-streaming" : ""}`}>
        <button className="reasoning-heading" onClick={() => setDisclosure({streaming, open: !expanded})} aria-expanded={expanded} aria-controls={contentId}>
            <Brain size={15}/><span>{streaming ? "正在深度思考" : "深度思考"}</span><ChevronRight size={13} className={expanded ? "expanded" : ""}/>
        </button>
        <div className="turn-disclosure" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}>
            <div className="turn-disclosure-inner" id={contentId}><div className="reasoning-content"><Prose text={item.text} streaming={streaming}/></div></div>
        </div>
    </div>;
}

function Tool({item, active}: {item: ToolStep; active: boolean}) {
    const status = item.status === "running" && !active ? "interrupted" : item.status;
    const Icon = status === "running" ? LoaderCircle : status === "done" ? Check : status === "error" ? TriangleAlert : CirclePause;
    const label = {running: "执行中", done: "已完成", error: "未成功", interrupted: "已中断"}[status];
    return <div className={`tool-step ${status}`}>
        <Wrench size={14}/><span className="tool-name">{toolLabels[item.name] ?? item.name}</span>
        <span className="tool-status"><Icon size={13} className={status === "running" ? "spin" : undefined}/>{label}</span>
        {item.ms !== undefined && <small>{(item.ms / 1000).toFixed(1)}s</small>}
    </div>;
}

const TimelineItem = memo(function TimelineItem({item, active}: {item: TurnItem; active: boolean}) {
    return <div className={`timeline-item timeline-${item.kind}`} data-kind={item.kind}>
        {item.kind === "tool" ? <Tool item={item} active={active}/>
            : item.kind === "reasoning" ? <Reasoning item={item} active={active}/>
                : <Prose text={item.text} streaming={active && item.status === "streaming"}/>}
    </div>;
});

export function AgentTurn({turn, active}: {turn: Turn; active: boolean}) {
    const running = active && turn.status === "running";
    const status = turn.status === "running" && !active ? "interrupted" : turn.status;
    const [disclosure, setDisclosure] = useState<{status: string; open: boolean} | null>(null);
    const expanded = disclosure?.status === status ? disclosure.open : status !== "completed";
    const [now, setNow] = useState(Date.now);
    const contentId = useId();
    // A retry starts a fresh disclosure. A completed server checkpoint may correct
    // startedAt; that synchronization must not collapse what the user just opened.
    useEffect(() => { if (running) setDisclosure(null); }, [running, turn.startedAt]);
    useEffect(() => {
        if (!running) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running, turn.startedAt]);
    const elapsed = Math.max(0, Math.floor(((turn.finishedAt ?? now) - turn.startedAt) / 1000));
    const final = status === "completed" ? turn.items.find(item => item.id === turn.finalItemId && item.kind === "text") : undefined;
    const process = turn.items.filter(item => item !== final);
    const label = status === "completed" ? "已处理" : status === "cancelled" ? "已停止" : status === "error" ? "未完成" : status === "interrupted" ? "已中断"
        : {thinking: "正在思考", tool: "正在查询校园服务", generating: "正在整理回答", confirm: "等待你的确认"}[turn.phase];
    const Icon = running ? (turn.phase === "confirm" ? ShieldCheck : LoaderCircle) : status === "completed" ? Check : CirclePause;
    return <div className={`agent-turn ${running ? "is-running" : ""}`} data-status={status}>
        {(process.length > 0 || status !== "completed") && <>
            <button className="turn-heading" aria-label={expanded ? "收起处理过程" : "展开处理过程"} aria-expanded={expanded} aria-controls={contentId} onClick={() => setDisclosure({status, open: !expanded})}>
                <Icon size={15} className={running && turn.phase !== "confirm" ? "spin" : undefined}/><span role="status">{label}</span>
                {(running || turn.finishedAt !== undefined) && <span className="turn-time">{elapsed}s</span>}<ChevronRight size={14} className={expanded ? "expanded" : ""}/>
            </button>
            <div className="turn-disclosure" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}>
                <div className="turn-disclosure-inner" id={contentId}><div className="turn-timeline">
                    {process.length ? process.map(item => <TimelineItem key={item.id} item={item} active={running}/>)
                        : <p className="turn-placeholder">{running ? "正在理解你的问题" : "本次没有收到回复"}</p>}
                </div></div>
            </div>
        </>}
        {final && final.kind === "text" && <div className="turn-answer"><Prose text={final.text} streaming={false}/></div>}
    </div>;
}
