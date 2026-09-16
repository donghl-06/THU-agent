import {motion} from "motion/react";
import {ArrowUpRight, BookOpen, CalendarDays, Clock3, CreditCard, Newspaper, Volleyball} from "lucide-react";
import {Brand} from "./Controls";
import {contentReveal as reveal, staggeredReveal} from "../lib/motion";

export const suggestions = [
    {icon: CalendarDays, title: "今天的课表", detail: "课程、时间与上课地点", question: "我今天有什么课？"},
    {icon: Volleyball, title: "运动一下", detail: "看看今晚的场馆空位", question: "今晚哪里可以打羽毛球？"},
    {icon: BookOpen, title: "找个自习位", detail: "查询图书馆可用座位", question: "帮我看看图书馆哪里有位置"},
    {icon: Clock3, title: "安排空闲时间", detail: "查查明天的空闲时段", question: "我明天下午有什么空闲时间？"},
    {icon: Newspaper, title: "校园动态", detail: "浏览校园通知与资讯", question: "最近有什么重要的校园通知或资讯？"},
    {icon: CreditCard, title: "校园卡余额", detail: "查看校园卡账户信息", question: "我的校园卡余额是多少？"},
];

export function Welcome({send, authenticated}: {send: (question: string) => void; authenticated: boolean}) {
    return <motion.section className="welcome" initial="hidden" animate="visible" variants={staggeredReveal}>
        <motion.div className="welcome-identity" variants={reveal}><Brand large/><h1>清灵<span>QingLing</span></h1></motion.div>
        <motion.div variants={reveal}><h2>今天，有什么可以帮你？</h2><p className="welcome-sub">查课表、找座位、安排日程。校园里的事，一起理清。</p></motion.div>
        <motion.div className="suggestions" variants={reveal}>
            {suggestions.map(({icon: Icon, title, detail, question}) => <button className="suggestion" key={title} onClick={() => send(question)}><span className="suggestion-icon"><Icon size={21} strokeWidth={1.6}/></span><span><strong>{title}</strong><small>{detail}</small></span><ArrowUpRight className="suggestion-arrow" size={17}/></button>)}
        </motion.div>
        {!authenticated && <motion.p className="welcome-login-note" variants={reveal}>连接清华 Info 后，即可查询你的校园信息</motion.p>}
    </motion.section>;
}
