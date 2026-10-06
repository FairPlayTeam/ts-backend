import config from './config/env.js';
import { objectStorage } from './objectStorage.instance.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { createProfilesService } from './services/profiles.service.js';
import { createFollowingProfilesCursorCodec } from './services/profiles/followingProfilesCursor.js';

export const profilesService = createProfilesService({
  prisma,
  objectStorage: objectStorage ?? createUnavailableObjectStorage(),
  followingProfilesCursorCodec: createFollowingProfilesCursorCodec(
    config.followingCursorEncryptionKey,
  ),
  maxProxyBytes: {
    avatar: config.profileMediaMaxUploadBytes,
    banner: config.profileMediaMaxUploadBytes,
  },
});
