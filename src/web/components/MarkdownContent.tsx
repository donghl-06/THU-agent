import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownContent({text}: {text: string}) {
    return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
        a: ({children, ...props}) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
        table: ({children, ...props}) => <div className="table-scroll"><table {...props}>{children}</table></div>,
    }}>{text}</Markdown></div>;
}
