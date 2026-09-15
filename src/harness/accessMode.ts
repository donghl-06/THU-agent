/** Explicit host policy for one Agent turn; never inferred from model output. */
export type AccessMode = "request-approval" | "full-access";

export function isAccessMode(value: unknown): value is AccessMode {
    return value === "request-approval" || value === "full-access";
}

export function accessModeInstruction(mode: AccessMode): string {
    const policy = mode === "full-access"
        ? "当前模式：完全访问。用户已通过界面授权直接执行本轮指令所需的工具操作，包括预约、取消、充值、提交、发信及创建或取消定时任务。参数明确时直接调用工具完成指令，不再请求口头批准、复述后等待同意，或要求用户在弹窗确认。工具说明中的‘调用前须用户确认’已由本轮授权满足。"
        : "当前模式：请求批准。参数明确时直接调用对应工具，系统会在写操作执行前展示完整参数并请求用户批准。不要先在正文中额外询问‘是否执行’或要求用户回复确认，以免重复批准。工具说明中的‘调用前须用户确认’由系统的批准流程负责。";
    return `${policy}\n此模式决定操作授权，优先于其他说明中通用的确认要求。缺少必要参数或存在多个无法唯一确定的目标时，只询问缺失信息，不编造目标、金额或支付方式。学校登录、身份验证及第三方支付按其实际流程完成。工具失败或被拒绝后，不重复提交写操作。`;
}
