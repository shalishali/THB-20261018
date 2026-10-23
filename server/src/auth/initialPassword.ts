export const DEFAULT_INITIAL_ADMIN_USERNAME = 'admin';
export const DEFAULT_INITIAL_ADMIN_PASSWORD = 'admin';
export const INITIAL_PASSWORD_MIN_LENGTH = 8;

export interface InitialPasswordRuleState {
  minLength: boolean;
  notDefault: boolean;
}

export function getInitialPasswordRuleState(password: string): InitialPasswordRuleState {
  return {
    minLength: password.length >= INITIAL_PASSWORD_MIN_LENGTH,
    notDefault: password !== DEFAULT_INITIAL_ADMIN_PASSWORD,
  };
}

// 产品确认：统一为“至少 8 位”，不再强制大小写/数字/特殊字符组合；
// 仍拒绝默认密码，避免初始化账号沿用 admin。
export function validateInitialPassword(password: string): string[] {
  const state = getInitialPasswordRuleState(password);
  const errors: string[] = [];
  if (!state.minLength) errors.push('新密码至少 8 位');
  if (!state.notDefault) errors.push('新密码不能使用默认密码');
  return errors;
}
