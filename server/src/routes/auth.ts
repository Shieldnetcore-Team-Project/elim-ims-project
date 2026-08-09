import { Router } from 'express';
import { safe } from '../lib/errors.js';
import * as auth from '../services/auth.js';

export const authRouter = Router();

authRouter.post('/login', safe((req, res) => {
  const { userId, password } = req.body ?? {};
  if (typeof userId !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: '"userId" and "password" are required' });
    return;
  }
  const blockReason = auth.loginBlockReason(userId);
  if (blockReason) {
    res.status(403).json({ error: blockReason });
    return;
  }
  if (!auth.verifyPassword(userId, password)) {
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }
  res.json({ ok: true });
}));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

authRouter.post('/signup', safe((req, res) => {
  const { name, email, password } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Full name is required' });
    return;
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  if (typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  const user = auth.createAccount(name.trim(), email.trim(), password);
  res.status(201).json(user);
}));

authRouter.post('/change-password', safe((req, res) => {
  const { userId, currentPassword, newPassword } = req.body ?? {};
  if (typeof userId !== 'string' || typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: '"userId", "currentPassword" and "newPassword" are required' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  if (!auth.verifyPassword(userId, currentPassword)) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  auth.setPassword(userId, newPassword);
  res.json({ ok: true });
}));
