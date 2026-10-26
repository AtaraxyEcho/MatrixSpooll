/**
 * 会话级 Store 复位登记表。
 *
 * 登出只清 auth-store 时，业务 Store（项目列表、助手会话、任务、UI 偏好）会带着上一位
 * 用户的数据留在内存里：同一浏览器窗口换账号登录时，刷新到位之前会看到别人的项目卡片与
 * 助手会话。每个 Store 在模块内登记自己的复位动作，auth-store 只调一个入口，避免
 * auth-store 反向 import 全部业务 Store 造成循环依赖。
 */
type SessionResetter = () => void;

const resetters = new Set<SessionResetter>();

/** 登记一个「登出时必须清空」的复位动作；返回注销函数（测试解绑用）。 */
export function registerSessionResetter(reset: SessionResetter): () => void {
  resetters.add(reset);
  return () => {
    resetters.delete(reset);
  };
}

/** 复位所有已登记的业务 Store。单个复位抛错不影响其余 Store 与登出流程。 */
export function resetSessionScopedStores(): void {
  for (const reset of resetters) {
    try {
      reset();
    } catch (err: unknown) {
      console.warn("[auth] session store reset failed", err);
    }
  }
}
