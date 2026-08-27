import type enAuth from '../en/auth';

export default {
  'login': '登录',
  'logging_in': '登录中...',
  'login_failed': '登录失败',
  'login_required': '登录已失效，请重新登录',
  'session_ended_replaced': '您的账号已在其他设备登录，当前会话已下线。请重新登录。',
  'session_ended_revoked': '当前会话已被管理员下线，请重新登录。',
  'session_ended_expired': '当前会话已过期，请重新登录。',
  'session_ended_invalid': '当前登录会话已失效，请重新登录。',
  'username': '用户名',
  'password': '密码',
  'workspace_kicker': '工作区 / 入口',
  'workspace_title': '进入工作区',
  'workspace_description': '继续访问你的项目与自由创作内容。',
} satisfies Record<keyof typeof enAuth, string>;
