import Markdown, {type Components} from "react-markdown";
import remarkGfm from "remark-gfm";
import {ExternalLink, FileAudio, FileText, FileVideo, TriangleAlert} from "lucide-react";
import {useState, type ComponentProps} from "react";

function InlineImage({src, alt, ...props}: ComponentProps<"img">) {
    const [gone, setGone] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState(false);
    const temporary = typeof src === "string" && src.startsWith("/api/temp-image/");
    async function remove() {
        if (!temporary || deleting) return;
        setDeleting(true);
        setError(false);
        try {
            const response = await fetch(src, {method: "DELETE"});
            if (!response.ok && response.status !== 404) throw new Error("delete failed");
            setGone(true);
        } catch { setError(true); }
        finally { setDeleting(false); }
    }
    if (gone) return <span className="image-note">（临时图片已清理，可让清灵重新获取）</span>;
    return <span className="inline-image">
        <a href={src} target="_blank" rel="noopener noreferrer"><img {...props} src={src} alt={alt} onError={() => { if (temporary) setGone(true); }}/></a>
        {temporary && <button className="image-done" disabled={deleting} onClick={() => void remove()}>{deleting ? "正在删除…" : "已用完，删除图片"}</button>}
        {error && <span className="image-note" role="alert">删除失败，请重试</span>}
    </span>;
}

function CloudMedia({src, alt}: {src?: string; alt?: string}) {
    const text = (alt ?? "").trim();
    const kind = text.startsWith("video:")
        ? "video"
        : text.startsWith("audio:")
            ? "audio"
            : text.startsWith("file:")
                ? "file"
                : undefined;
    const [failed, setFailed] = useState(false);
    const [gone, setGone] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState(false);
    if (!kind || typeof src !== "string") return null;
    const previewUrl = src;

    const name = text.slice(kind.length + 1).trim() || "清华云盘文件";
    let trusted = false;
    let managed = false;
    try {
        const url = new URL(src, window.location.href);
        managed = url.origin === window.location.origin && url.pathname.startsWith("/api/cloud-file/");
        trusted = managed || (url.protocol === "https:" &&
            (url.hostname === "cloud.tsinghua.edu.cn" || url.hostname.endsWith(".tsinghua.edu.cn")));
    } catch { /* Invalid URLs are never rendered as media. */ }

    const Icon = kind === "video" ? FileVideo : kind === "audio" ? FileAudio : FileText;
    if (!trusted) return <span className="cloud-media-warning">云盘媒体链接无效，已停止加载。</span>;
    async function removePreview() {
        if (!managed || deleting) return;
        setDeleting(true);
        setDeleteError(false);
        try {
            const response = await fetch(previewUrl, {method: "DELETE"});
            if (!response.ok && response.status !== 404) throw new Error("delete failed");
            setGone(true);
        } catch {
            setDeleteError(true);
        } finally {
            setDeleting(false);
        }
    }

    if (gone) return <span className="image-note">（云盘文件预览已清理，可让清灵重新打开）</span>;

    return <span className={`cloud-media ${kind}`}>
        <span className="cloud-media-title">
            <Icon size={15}/>
            <span title={name}>{name}</span>
        </span>
        {kind === "video"
            ? <video controls preload="metadata" src={src} onError={() => setFailed(true)}/>
            : kind === "audio"
                ? <audio controls preload="metadata" src={src} onError={() => setFailed(true)}/>
                : null}
        <span className="cloud-media-actions">
            <a href={src} target="_blank" rel="noopener noreferrer" download={name}>
                {kind === "video" ? "新窗口打开 / 下载" : kind === "audio" ? "下载音频" : "下载文件"}
                <ExternalLink size={12}/>
            </a>
            {managed && <button className="image-done" disabled={deleting} onClick={() => void removePreview()}>
                {deleting ? "正在删除…" : "已用完，删除预览"}
            </button>}
        </span>
        {failed && <span className="cloud-media-error" role="alert">
            <TriangleAlert size={12}/>
            云盘预览已过期或浏览器暂不支持该编码，可让清灵重新打开。
        </span>}
        {deleteError && <span className="cloud-media-error" role="alert">删除预览失败，请重试。</span>}
    </span>;
}

// Stable component types preserve image deletion state when the conversation rerenders.
const components: Components = {
    a: ({node: _node, children, ...props}) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({node: _node, children, ...props}) => <div className="table-scroll"><table {...props}>{children}</table></div>,
    img: ({node: _node, ...props}) => {
        const alt = typeof props.alt === "string" ? props.alt.trim() : "";
        if (alt.startsWith("video:") || alt.startsWith("audio:") || alt.startsWith("file:")) {
            return <CloudMedia key={props.src} src={props.src} alt={props.alt}/>;
        }
        return <InlineImage key={props.src} {...props}/>;
    },
};

export default function MarkdownContent({text}: {text: string}) {
    return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{text}</Markdown></div>;
}
