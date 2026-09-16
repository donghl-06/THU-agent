import {lazy, memo, Suspense, useState} from "react";
import {motion} from "motion/react";
import {Bell, CalendarPlus, Copy, Download, ExternalLink, Image, RotateCcw, TriangleAlert} from "lucide-react";
import type {Message, Result} from "../lib/types";
import {Brand, IconButton} from "./Controls";
import {AgentTurn} from "./AgentTurn";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

export const MessageView = memo(function MessageView({message, streaming, retry, copy}: {message: Message; streaming: boolean; retry?: () => void; copy: (text: string) => void}) {
    const bot = message.role === "bot";
    return <motion.article className={`message ${bot ? "assistant-message" : "user-message"}`} initial={{opacity: 0, y: 8}} animate={{opacity: 1, y: 0}} transition={{duration: .25}} aria-label={bot ? "清灵的回答" : "你的提问"}>
        {bot && <div className="message-author">{message.notification ? <Bell size={17}/> : <Brand/>}<span>{message.notification ? "任务通知" : "清灵"}</span></div>}
        <div className="message-content">
            {message.images?.length ? <div className="message-images">{message.images.map((url, index) => <img src={url} key={index} alt={`附件 ${index + 1}`}/>)}</div> : Boolean(message.imageCount) && <p className="saved-attachment"><Image size={14}/>{message.imageCount} 张图片附件 · 预览未保存</p>}
            {bot && message.turn ? <AgentTurn key={message.turn.startedAt} turn={message.turn} active={streaming}/>
                : bot && !streaming ? <Suspense fallback={<div className="plain-message">{message.text}</div>}><MarkdownContent text={message.text}/></Suspense> : <div className="plain-message">{message.text}{streaming && <span className="stream-cursor"/>}</div>}
        </div>
        {bot && !streaming && <div className="message-footer"><div className="message-actions"><IconButton icon={Copy} label="复制回答" onClick={() => copy(message.text)}/>{retry && <IconButton icon={RotateCcw} label="重新生成" onClick={retry}/>}</div>{message.usage && <span className="usage">{message.usage.totalTokens.toLocaleString()} tokens{message.usage.costYuan !== undefined && ` · ¥${message.usage.costYuan.toFixed(3)}`}</span>}</div>}
    </motion.article>;
});

export function ErrorNotice({message, retry, disabled}: {message: string; retry: () => void; disabled: boolean}) {
    return <motion.div className="error-notice" initial={{opacity: 0, y: 6}} animate={{opacity: 1, y: 0}} role="alert"><TriangleAlert size={19}/><div><strong>暂时没有完成</strong><p>{message}</p><button className="text-button" onClick={retry} disabled={disabled}><RotateCcw size={14}/>重试</button></div></motion.div>;
}

export function ResultView({result}: {result: Result}) {
    const [tip, setTip] = useState("");
    if (result.kind === "qr") return <div className="result-panel qr-result">{result.dataUrl && <img src={result.dataUrl} alt="支付二维码"/>}<strong>使用支付宝扫码付款</strong><p>{result.url}</p></div>;
    if (result.kind === "calendar") return <div className="result-panel"><CalendarPlus size={23}/><div><strong>{result.title}</strong><p>导入手机或电脑日历，到点提醒</p><button className="text-button" onClick={() => {
        const url = URL.createObjectURL(new Blob([result.icsContent], {type: "text/calendar;charset=utf-8"}));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}><Download size={15}/>下载日历</button></div></div>;
    return <div className="result-panel"><ExternalLink size={22}/><div><strong>学校在线支付</strong><p>{tip || "确认订单后，前往学校支付平台完成付款"}</p><button className="button primary" onClick={() => {
        const paymentWindow = window.open("", "_blank");
        if (!paymentWindow) { setTip("请允许浏览器弹出支付窗口后重试"); return; }
        // The trusted local server supplies the school's auto-submit payment form.
        paymentWindow.opener = null;
        paymentWindow.document.write(result.html);
        paymentWindow.document.close();
        setTip("已打开支付页，付款后可回到这里继续");
    }}>前往学校支付平台<ExternalLink size={15}/></button></div></div>;
}
