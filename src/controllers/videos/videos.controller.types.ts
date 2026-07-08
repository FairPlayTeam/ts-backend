import type { VideosRoutePort } from '../../services/videos.types.js';

export type VideosControllerDependencies = {
  videosService: VideosRoutePort;
};
