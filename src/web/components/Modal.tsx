import {useEffect, useId, useRef, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {motion, useReducedMotion} from "motion/react";
import {X} from "lucide-react";
import {IconButton} from "./Controls";

export function Modal({title, children, close, className = ""}: {title: string; children: ReactNode; close?: () => void; className?: string}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const heading = useId();
    const reduced = useReducedMotion();
    useEffect(() => {
        const element = dialog.current;
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        element?.showModal();
        element?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
        return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
    }, []);
    return createPortal(<motion.dialog ref={dialog} aria-labelledby={heading} className={`modal ${className}`}
        initial={{opacity: 0, y: reduced ? 0 : 14, scale: reduced ? 1 : .97}} animate={{opacity: 1, y: 0, scale: 1}} exit={{opacity: 0, y: reduced ? 0 : 8, scale: reduced ? 1 : .98}}
        transition={{duration: .23, ease: [.22, 1, .36, 1]}}
        onCancel={e => { e.preventDefault(); close?.(); }} onClick={e => { if (e.target === e.currentTarget && close) { const rect = e.currentTarget.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) close(); } }}>
        {close && <IconButton className="modal-close" icon={X} label="关闭弹窗" onClick={close}/>}
        <h2 id={heading}>{title}</h2>{children}
    </motion.dialog>, document.body);
}
