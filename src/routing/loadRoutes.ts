import type { Express, Router as ExpressRouter } from 'express';
import { readdir, stat } from 'node:fs/promises';
import { logger } from '../lib/logger.js';
import { apiLimiter } from '../middleware/limiters.js';

type RouteFactory<TContext> = (context: TContext) => unknown;

type RouteRegister<TContext> = (
  app: Express,
  routePath: string,
  context: TContext,
) => void | Promise<void>;

type RouteModule<TContext> = {
  createRouter?: RouteFactory<TContext>;
  default?: unknown;
  register?: RouteRegister<TContext>;
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

async function loadRoutes<TContext>(app: Express, routesDirUrl: URL, context: TContext) {
  try {
    await stat(routesDirUrl);
  } catch {
    logger.warn({ path: routesDirUrl.toString() }, 'Routes directory not found');
    return;
  }

  const files = (await walkFiles(routesDirUrl)).sort((left, right) =>
    left.pathname.localeCompare(right.pathname),
  );

  for (const fileUrl of files) {
    const rel = fileUrl.toString().slice(routesDirUrl.toString().length);
    const routePath = normalizeRoutePath(routePathFromFile(rel));

    const mod = (await import(fileUrl.toString())) as RouteModule<TContext>;
    const routerFactory = mod.createRouter;
    const router = mod.default;

    if (typeof routerFactory === 'function') {
      const createdRouter = routerFactory(context);

      if (createdRouter && typeof createdRouter === 'function') {
        app.use(routePath, apiLimiter, createdRouter as ExpressRouter);
        logger.info({ file: rel, route: routePath }, 'route mounted');
      } else {
        logger.warn({ file: rel }, 'Skipped route factory, no Router returned');
      }
    } else if (router && typeof router === 'function') {
      app.use(routePath, apiLimiter, router as ExpressRouter);
      logger.info({ file: rel, route: routePath }, 'route mounted');
    } else if (typeof mod.register === 'function') {
      await mod.register(app, routePath, context);
      logger.info({ file: rel, route: routePath }, 'Route registered');
    } else {
      logger.warn(
        { file: rel },
        'Skipped path, no createRouter(context), default Router, or register(app, route, context) export',
      );
    }
  }
}

export default loadRoutes;
