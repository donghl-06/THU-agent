import {useEffect, useLayoutEffect, useRef, useState, type ChangeEvent} from "react";
import {AnimatePresence, motion} from "motion/react";
import {ArrowUp, CornerDownLeft, ImagePlus, LoaderCircle, Mic, Square, X} from "lucide-react";
import type {Assistant} from "../lib/useAssistant";
import {useSpeech} from "../lib/useSpeech";
import {IconButton} from "./Controls";

export function Composer({app, value, setValue, onSend}: {app: Assistant; value: string; setValue: (text: string) => void; onSend: (text: string, images: string[]) => void}) {
    const [images, setImages] = useState<string[]>([]);
    const [uploading, setUploading] = useState(false);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const speech = useSpeech(value, setValue, app.notify);
    const busy = Boolean(app.turn);
    const wasBusy = useRef(busy);
    const uploadGeneration = useRef(0);
    useLayoutEffect(() => {
        if (textarea.current) { textarea.current.style.height = "auto"; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 160)}px`; }
    }, [value]);
    useEffect(() => {
        if (wasBusy.current && !busy) textarea.current?.focus();
        wasBusy.current = busy;
    }, [busy]);
    useEffect(() => {
        uploadGeneration.current++;
        setImages([]);
        setUploading(false);
        speech.stop();
    }, [app.history.activeId, app.authenticated]);
    useEffect(() => () => { uploadGeneration.current++; }, []);

    async function selectImages(event: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        const generation = uploadGeneration.current;
        setUploading(true);
        const next = [...images];
        for (const file of files) {
            if (next.length >= 4) { app.notify("最多一次发送 4 张图片"); break; }
            if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { app.notify("请选择 PNG、JPEG、WebP 或 GIF 图片", "error"); continue; }
            if (file.size > 4.5 * 1024 * 1024) { app.notify("图片超过 4.5 MB，请先压缩", "error"); continue; }
            try {
                next.push(await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result));
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                }));
            } catch { app.notify("无法读取图片，请重试", "error"); }
        }
        if (generation === uploadGeneration.current) { setImages(next); setUploading(false); }
    }
    function send() {
        if (busy) return;
        speech.stop();
        onSend(value.trim(), images);
        if (app.authenticated) setImages([]);
    }
    return <div className="composer-area">
        <motion.div className={`composer ${speech.listening ? "listening" : ""}`} initial={{opacity: 0, y: 14}} animate={{opacity: 1, y: 0}} transition={{duration: .45, delay: .1}}>
            <AnimatePresence>{images.length > 0 && <motion.div className="attachments" initial={{height: 0, opacity: 0}} animate={{height: "auto", opacity: 1}} exit={{height: 0, opacity: 0}}>{images.map((url, index) => <div key={url} className="attachment"><img src={url} alt={`待发送图片 ${index + 1}`}/><IconButton icon={X} label={`移除图片 ${index + 1}`} onClick={() => setImages(prev => prev.filter((_, i) => i !== index))}/></div>)}</motion.div>}</AnimatePresence>
            <textarea ref={textarea} aria-label="发送给清灵的消息" placeholder={speech.listening ? "正在聆听，点击麦克风结束…" : "发消息给清灵…"} rows={1} value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); if (!busy && !uploading && (value.trim() || images.length)) send(); }
            }} disabled={Boolean(app.lifecycle)}/>
            <div className="composer-toolbar"><div className="composer-tools">
                {app.vision && <IconButton icon={uploading ? LoaderCircle : ImagePlus} className={uploading ? "spin-icon" : ""} label="添加图片" disabled={busy || uploading} onClick={() => input.current?.click()}/>}
                <IconButton icon={Mic} label={speech.listening ? "停止语音输入" : "语音输入"} className={speech.listening ? "recording" : ""} aria-pressed={speech.listening} disabled={busy} onClick={speech.toggle}/>
                <span className="composer-tool-label">{speech.listening ? "聆听中" : "校园助手"}</span>
            </div><span className="composer-shortcut"><CornerDownLeft size={12}/>发送<span>·</span>Shift + Enter 换行</span>
                <button className={`send-button ${busy ? "stop-button" : ""}`} aria-label={app.stopping ? "正在停止" : busy ? "停止生成" : "发送消息"} title={busy ? "停止生成" : "发送消息"} disabled={app.stopping || uploading || app.loginPending || Boolean(app.lifecycle) || (!busy && !value.trim() && !images.length)} onClick={() => busy ? app.stop() : send()}>{app.stopping ? <LoaderCircle size={19} className="spin"/> : busy ? <Square size={16} fill="currentColor"/> : <ArrowUp size={21} strokeWidth={2}/>}</button>
            </div>
            <input ref={input} type="file" aria-label="选择图片" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => void selectImages(event)}/>
        </motion.div>
        <p className="disclaimer">清灵的回答可能存在误差，重要信息请以学校官方信息为准</p>
    </div>;
}
