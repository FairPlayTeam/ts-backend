import { Router } from 'express';
import { authenticateSession } from '../lib/sessionAuth.js';
import { register, login, getProfile } from '../controllers/authController.js';
import { updateProfile } from '../controllers/userController.js';
import {
  getUserSessions,
  logoutSession,
  logoutAllOtherSessions,
  logoutAllSessions,
} from '../controllers/sessionController.js';
import { authLimiter } from '../middleware/limiters.js';
import {
  validate,
  registerSchema,
  loginSchema,
  updateProfileSchema,
} from '../middleware/validation.js';
import { registerRoute } from '../lib/docs.js';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
registerRoute({
  method: 'POST',
  path: '/auth/register',
  summary: 'Register a new user',
  body: { email: 'string', username: 'string', password: 'string' },
  responses: { 
    '201': `{
  "message": "User registered successfully",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "johndoe",
    "role": "user"
  },
  "sessionKey": "fp_sess_a1b2c3d4e5f6...",
  "session": {
    "id": "uuid",
    "expiresAt": "2024-10-20T13:30:00Z",
    "deviceInfo": "Mac",
    "ipAddress": "192.168.1.1"
  }
}` 
  },
});

router.post('/login', authLimiter, validate(loginSchema), login);
registerRoute({
  method: 'POST',
  path: '/auth/login',
  summary: 'Login user',
  body: { emailOrUsername: 'string', password: 'string' },
  responses: { 
    '200': `{
  "message": "Login successful",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "johndoe",
    "role": "user"
  },
  "sessionKey": "fp_sess_a1b2c3d4e5f6...",
  "session": {
    "id": "uuid",
    "expiresAt": "2024-10-20T13:30:00Z",
    "deviceInfo": "Mac",
    "ipAddress": "192.168.1.1"
  }
}` 
  },
});

router.get('/me', authenticateSession, getProfile);
registerRoute({
  method: 'GET',
  path: '/auth/me',
  summary: 'Get current user profile',
  auth: true,
  responses: {
    '200': `{
  "id": "uuid",
  "email": "user@example.com",
  "username": "johndoe",
  "displayName": "John Doe",
  "avatarUrl": "https://example.com/avatar.jpg",
  "bannerUrl": "https://example.com/banner.jpg",
  "bio": "Hello world!",
  "role": "user",
  "isVerified": false,
  "followerCount": 42,
  "totalViews": "1337",
  "totalEarnings": "0.00",
  "createdAt": "2024-01-01T00:00:00Z"
}`,
  },
});

router.patch(
  '/me',
  authenticateSession,
  validate(updateProfileSchema),
  updateProfile,
);

// Session management routes
router.get('/sessions', authenticateSession, getUserSessions);
registerRoute({
  method: 'GET',
  path: '/auth/sessions',
  summary: 'Get all active sessions for current user',
  auth: true,
  responses: {
    '200': `{
  "sessions": [
    {
      "id": "uuid",
      "sessionKey": "****c3d4e5f6",
      "ipAddress": "192.168.1.1",
      "deviceInfo": "Mac",
      "createdAt": "2024-09-20T10:00:00Z",
      "lastUsedAt": "2024-09-20T13:30:00Z",
      "expiresAt": "2024-10-20T10:00:00Z",
      "isCurrent": true
    }
  ],
  "total": 1
}`,
  },
});

router.delete('/sessions/:sessionId', authenticateSession, logoutSession);
registerRoute({
  method: 'DELETE',
  path: '/auth/sessions/:sessionId',
  summary: 'Logout from a specific session',
  auth: true,
  responses: {
    '200': `{"message": "Session logged out successfully"}`,
  },
});

router.delete('/sessions/others/all', authenticateSession, logoutAllOtherSessions);
registerRoute({
  method: 'DELETE',
  path: '/auth/sessions/others/all',
  summary: 'Logout from all other sessions (keep current)',
  auth: true,
  responses: {
    '200': `{
  "message": "All other sessions logged out successfully",
  "sessionsLoggedOut": 3
}`,
  },
});

router.delete('/sessions/all', authenticateSession, logoutAllSessions);
registerRoute({
  method: 'DELETE',
  path: '/auth/sessions/all',
  summary: 'Logout from all sessions including current',
  auth: true,
  responses: {
    '200': `{
  "message": "All sessions logged out successfully",
  "sessionsLoggedOut": 4
}`,
  },
});
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
    '200': `{"message": "Profile updated successfully", "user": {"id": "uuid", "displayName": "John Doe", "bio": "Updated bio"}}`,
  },
});

export default router;
