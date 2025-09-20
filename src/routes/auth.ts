import { Router } from 'express';
import { authenticateToken } from '../lib/auth.js';
import { register, login, getProfile } from '../controllers/authController.js';
import { updateProfile } from '../controllers/userController.js';
import { validate, registerSchema, loginSchema, updateProfileSchema } from '../middleware/validation.js';
import { registerRoute } from '../lib/docs.js';

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
  responses: {
    '200': 'User profile'
  }
});

router.patch('/me', authenticateToken, validate(updateProfileSchema), updateProfile);
registerRoute({
  method: 'PATCH',
  path: '/auth/me',
  summary: 'Update current user profile',
  auth: true,
  body: {
    displayName: 'string (optional)',
    bio: 'string (optional)',
  },
  responses: {
    '200': '{ "message": "Profile updated successfully", ... }',
  },
});

export default router;
