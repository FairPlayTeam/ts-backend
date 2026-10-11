export { createCommentsService } from './service.js';
export { commentsHttpModule } from './module.js';
export type { CommentsDependencies } from './dependencies.js';
export type * from './types.js';
export {
  CommentNotFoundError,
  CommentsDisabledError,
  CommentsTemporarilyUnavailableError,
} from './errors.js';
