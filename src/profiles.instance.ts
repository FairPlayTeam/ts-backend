import { objectStorage } from './objectStorage.instance.js';
import { createUnavailableObjectStorage } from './lib/objectStorage.js';
import { prisma } from './lib/prisma.js';
import { createProfilesService } from './services/profiles.service.js';

export const profilesService = createProfilesService({
  prisma,
  objectStorage: objectStorage ?? createUnavailableObjectStorage(),
});
