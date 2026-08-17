import type { ProfilesRoutePort } from '../../services/profiles.types.js';
import type { VideosRoutePort } from '../../services/videos.types.js';

export type ProfilesControllerDependencies = {
  profilesService: ProfilesRoutePort;
  videosService: Pick<VideosRoutePort, 'listPublicProfileVideos'>;
};
