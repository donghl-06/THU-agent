/** sm-crypto 没有官方类型声明，这里只声明我们用到的 sm2.doEncrypt */
declare module "sm-crypto" {
    export const sm2: {
        doEncrypt(data: string, publicKey: string, cipherMode?: number): string;
        doDecrypt(data: string, privateKey: string, cipherMode?: number): string;
    };
}
