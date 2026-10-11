import type { PublicProfileIdentity } from '../../modules/profiles/types.js';

export const toPublicProfileIdentityResponse = ({
  avatarUrl,
  displayName,
  username,
}: PublicProfileIdentity) => ({
  username,
  displayName,
  avatarUrl,
});
