/**
 * 让全局 fetch（undici 实现）尊重 https_proxy 环境变量。
 *
 * 背景：Node 的 fetch 默认不走系统代理，而本开发环境（WSL2）的直连
 * 偶发不通（2026-08-29 凌晨实测：LLM API 与体育系统先后出现
 * fetch failed / Connect Timeout，同一时间 curl 走代理稳定）。
 * 只要 import 本模块一次即生效；未设置代理环境变量时是纯 no-op。
 *
 * 注意：只影响全局 fetch（SportsClient / llmClient 用它）；
 * @thu-info/lib 走自己的 node-fetch，不受影响。
 */
import {ProxyAgent, setGlobalDispatcher} from "undici";

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxy) {
    setGlobalDispatcher(new ProxyAgent(proxy));
}
