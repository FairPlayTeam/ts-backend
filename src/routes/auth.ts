import { Router } from 'express';
import { authenticateToken } from '../lib/auth.js';
import { register, login, getProfile } from '../controllers/authController.js';
import { registerRoute } from '../lib/docs.js';
import { validate, registerSchema, loginSchema } from '../middleware/validation.js';

const router = Router();

router.post('/register', validate(registerSchema), register);
registerRoute({
  method: 'POST',
  path: '/auth/register',
  summary: 'Register a new user',
  body: { email: 'string', username: 'string', password: 'string' },
  responses: { '201': 'User registered with JWT token' },
});

router.post('/login', validate(loginSchema), login);
registerRoute({
  method: 'POST',
  path: '/auth/login',
  summary: 'Login user',
  body: { emailOrUsername: 'string', password: 'string' },
  responses: { '200': 'User logged in with JWT token' },
});

router.get('/me', authenticateToken, getProfile);
registerRoute({
  method: 'GET',
  path: '/auth/me',
  summary: 'Get current user profile',
  auth: true,
  responses: { '200': 'User profile' },
});

export default router;
