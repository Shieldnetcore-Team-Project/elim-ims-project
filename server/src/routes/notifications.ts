import { Router } from 'express';
import * as notifications from '../services/notifications.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', (_req, res) => res.json(notifications.allNotifications()));
