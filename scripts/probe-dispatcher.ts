import {getGlobalDispatcher} from "undici";
console.log("导入前 dispatcher:", getGlobalDispatcher().constructor.name);
await import("../src/client/sports/SportsClient");
console.log("导入后 dispatcher:", getGlobalDispatcher().constructor.name);
console.log("https_proxy =", process.env.https_proxy);
