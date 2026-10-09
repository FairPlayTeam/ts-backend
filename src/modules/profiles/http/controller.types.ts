import type { ProfilesRoutePort } from '../index.js';
import type { VideosRoutePort } from '../../../services/videos.types.js';

export type ProfilesControllerDependencies = {
  profilesService: ProfilesRoutePort;
  videosService: Pick<VideosRoutePort, 'listPublicProfileVideos'>;
};
