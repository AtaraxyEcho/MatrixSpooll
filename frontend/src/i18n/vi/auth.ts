import type enAuth from "@/i18n/en/auth";

export default {
  'login': 'Đăng nhập',
  'logging_in': 'Đang đăng nhập...',
  'login_failed': 'Đăng nhập thất bại',
  'login_required': 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại',
  'username': 'Tên đăng nhập',
  'password': 'Mật khẩu',
  'workspace_kicker': 'Không gian làm việc / truy cập',
  'workspace_title': 'Vào không gian làm việc',
  'workspace_description': 'Tiếp tục đến các dự án và nội dung sáng tạo của bạn.',
} satisfies Record<keyof typeof enAuth, string>;
