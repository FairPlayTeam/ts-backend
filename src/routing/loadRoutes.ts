import type { Express, RequestHandler, Router as ExpressRouter } from 'express';
import { readdir, stat } from 'node:fs/promises';
import { logger } from '../lib/logger.js';
import type { RouteDoc } from '../docs/registry.js';

type RouteFactory<TContext> = (context: TContext) => unknown;

type RouteRegister<TContext> = (
  app: Express,
  routePath: string,
  context: TContext,
) => void | Promise<void>;

export type RouteFile = {
  fileUrl: URL;
  relativeFile: string;
  routePath: string;
};

type RouteModule<TContext> = {
  createRouter?: RouteFactory<TContext>;
  default?: unknown;
  register?: RouteRegister<TContext>;
  routeDocs?: readonly RouteDoc[];
};

export type LoadedRoutes = {
  openApiRouteDocs: RouteDoc[];
};

function routePathFromFile(relativeFile: string): string {
  const normalized = relativeFile.replace(/\\/g, '/');
  const noExt = normalized.replace(/\.(ts|js)$/, '');

  if (noExt === 'index') {
    return '/';
  }

  if (noExt.endsWith('/index')) {
    const base = noExt.slice(0, -'/index'.length);
    return '/' + base;
  }

  return '/' + noExt;
}

function normalizeRoutePath(path: string): string {
  return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

async function walkFiles(dirUrl: URL, acc: URL[] = []): Promise<URL[]> {
  const entries = await readdir(dirUrl, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
    if (entry.isDirectory()) {
      acc = await walkFiles(childUrl, acc);
    } else if (/(\.ts|\.js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      acc.push(childUrl);
    }
  }

  return acc;
}

const routeSpecificity = (routePath: string): number =>
  routePath === '/' ? 0 : routePath.split('/').filter(Boolean).length;

const compareRouteFiles = (left: RouteFile, right: RouteFile): number => {
  const specificityDiff = routeSpecificity(right.routePath) - routeSpecificity(left.routePath);

  if (specificityDiff !== 0) {
    return specificityDiff;
  }

  return left.relativeFile.localeCompare(right.relativeFile);
};

export async function discoverRouteFiles(routesDirUrl: URL): Promise<RouteFile[]> {
  return (await walkFiles(routesDirUrl))
    .map((fileUrl): RouteFile => {
      const relativeFile = fileUrl.toString().slice(routesDirUrl.toString().length);

      return {
        fileUrl,
        relativeFile,
        routePath: normalizeRoutePath(routePathFromFile(relativeFile)),
      };
    })
    .sort(compareRouteFiles);
}

async function loadRoutes<TContext>(
  app: Express,
  routesDirUrl: URL,
  context: TContext,
  apiLimiter: RequestHandler,
): Promise<LoadedRoutes> {
  try {
    await stat(routesDirUrl);
  } catch {
    logger.warn({ path: routesDirUrl.toString() }, 'Routes directory not found');
    return { openApiRouteDocs: [] };
  }

  const routeFiles = await discoverRouteFiles(routesDirUrl);

  const openApiRouteDocs: RouteDoc[] = [];

  for (const { fileUrl, relativeFile, routePath } of routeFiles) {
    const mod = (await import(fileUrl.toString())) as RouteModule<TContext>;
    const routerFactory = mod.createRouter;
    const router = mod.default;
    let routeLoaded = false;

    if (typeof routerFactory === 'function') {
      const createdRouter = routerFactory(context);

      if (createdRouter && typeof createdRouter === 'function') {
        app.use(routePath, apiLimiter, createdRouter as ExpressRouter);
        logger.info({ file: relativeFile, route: routePath }, 'route mounted');
        routeLoaded = true;
      } else {
        logger.warn({ file: relativeFile }, 'Skipped route factory, no Router returned');
      }
    } else if (router && typeof router === 'function') {
      app.use(routePath, apiLimiter, router as ExpressRouter);
      logger.info({ file: relativeFile, route: routePath }, 'route mounted');
      routeLoaded = true;
    } else if (typeof mod.register === 'function') {
      await mod.register(app, routePath, context);
      logger.info({ file: relativeFile, route: routePath }, 'Route registered');
      routeLoaded = true;
    } else {
      logger.warn(
        { file: relativeFile },
        'Skipped path, no createRouter(context), default Router, or register(app, route, context) export',
      );
    }

    if (routeLoaded && mod.routeDocs) {
      openApiRouteDocs.push(...mod.routeDocs);
    }
  }

  return { openApiRouteDocs };
}

export default loadRoutes;
