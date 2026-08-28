/**
 * 全局角色（`auth-store` 的 `role`）对应的界面能力谓词。
 *
 * 「能否打开系统设置」是路由守卫与首次使用引导共用的判定：`SystemSettingsGuard`
 * 按它放行 / 弹回，引导按它裁剪设置段步骤。两处必须消费同一份函数——判定各自
 * 维护一旦漂移，用户就会走进一条被守卫反复弹回、或讲了界面上不存在的入口的
 * 引导路径。新增界面能力判定时也在此处登记，保持「能力 → 角色」的单向换算。
 */
export function canAccessSystemSettings(role: "admin" | "member" | null): boolean {
  // role 为 null 只出现在认证关闭（AUTH_ENABLED=false）的本地形态，此时守卫
  // 同样放行设置页，引导的设置段也应保留——判定必须与守卫逐字一致。
  return role !== "member";
}
