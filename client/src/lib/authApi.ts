import { apiPost } from './apiClient';

export interface SignedUpUser { id: string; name: string; email: string; role: string; status: string }

export function verifyLogin(userId: string, password: string): Promise<{ ok: true }> {
  return apiPost('/auth/login', { userId, password });
}

export function signUp(name: string, email: string, password: string): Promise<SignedUpUser> {
  return apiPost('/auth/signup', { name, email, password });
}

export function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
  return apiPost('/auth/change-password', { userId, currentPassword, newPassword });
}
