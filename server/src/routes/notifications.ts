import { Router } from 'express';
import * as notifications from '../services/notifications.js';
import { safe } from '../lib/errors.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', safe(async (_req, res) => { res.json(await notifications.allNotifications()); }));
