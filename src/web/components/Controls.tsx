import type {ButtonHTMLAttributes, ReactNode} from "react";
import {Flower, type LucideIcon} from "lucide-react";

export function IconButton({icon: Icon, label, className = "", ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {icon: LucideIcon; label: string}) {
    return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}><Icon size={19} strokeWidth={1.7}/></button>;
}

export function Brand({large = false}: {large?: boolean}) {
    return <span className={`brand-mark${large ? " large" : ""}`} aria-hidden="true"><Flower strokeWidth={1.35}/></span>;
}

export function EmptyState({icon: Icon, children}: {icon: LucideIcon; children: ReactNode}) {
    return <div className="empty-state"><Icon size={22} strokeWidth={1.4}/><p>{children}</p></div>;
}
