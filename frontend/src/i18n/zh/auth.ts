import type enAuth from '../en/auth';

export default {
  'login': '登录',
  'logging_in': '登录中...',
  'login_failed': '登录失败',
  'username': '用户名',
  'password': '密码',
  'workspace_kicker': '工作区 / 入口',
  'workspace_title': '进入工作区',
  'workspace_description': '继续访问你的项目与自由创作内容。',
} satisfies Record<keyof typeof enAuth, string>;
